/* PT Review — Zero-Knowledge AES-256-GCM + CORS Cloud Backend Adapter */
(() => {
  'use strict';

  const HOST = window.location.hostname || '';
  const ENABLED = HOST.endsWith('github.io') || window.PT_FORCE_CLOUD === true;
  if (!ENABLED) {
    window.PT_CLOUD_API = { enabled: false };
    return;
  }

  const SITE_KEY_STORAGE = 'pt_review_site_key_v5';
  const BIN_CACHE_PREFIX = 'pt_cloud_bin_v6:';
  const PHOTO_CACHE = new Map();
  let MANIFEST_CACHE = null;
  let SEED_CACHE = { warehouse: null, full: null };
  let SESSION_CACHE = null;
  let WRITE_MUTEX = Promise.resolve();

  function saveCachedBin(url, obj) {
    if (!url || !obj) return;
    try {
      localStorage.setItem(BIN_CACHE_PREFIX + url, JSON.stringify(obj));
    } catch {}
  }

  function loadCachedBin(url) {
    if (!url) return null;
    try {
      const raw = localStorage.getItem(BIN_CACHE_PREFIX + url);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  const te = new TextEncoder();
  const td = new TextDecoder();

  function withMutex(fn) {
    const run = WRITE_MUTEX.then(fn, fn);
    WRITE_MUTEX = run.catch(() => {});
    return run;
  }

  function b64Encode(bytes) {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < arr.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, arr.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function b64Decode(str) {
    const bin = atob(str);
    const len = bin.length;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function hexFromBytes(bytes) {
    const arr = new Uint8Array(bytes);
    let s = '';
    for (let i = 0; i < arr.length; i++) s += arr[i].toString(16).padStart(2, '0');
    return s;
  }

  async function importAesKey(rawBytes, usages) {
    return crypto.subtle.importKey('raw', rawBytes, { name: 'AES-GCM' }, false, usages);
  }

  async function derivePbkdf2AesKey(secretStr, saltB64, iterations) {
    const baseKey = await crypto.subtle.importKey('raw', te.encode(secretStr), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: b64Decode(saltB64), iterations: Number(iterations || 250000), hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function hmacHex(rawKeyBytes, msgStr) {
    const k = await crypto.subtle.importKey('raw', rawKeyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', k, te.encode(msgStr));
    return hexFromBytes(sig);
  }

  async function aesDecryptJson(keyOrBytes, encObj) {
    if (!encObj || !encObj.iv || !encObj.ct) throw new Error('Corrupt encrypted payload');
    const key = keyOrBytes instanceof CryptoKey ? keyOrBytes : await importAesKey(keyOrBytes, ['decrypt']);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64Decode(encObj.iv) },
      key,
      b64Decode(encObj.ct)
    );
    return JSON.parse(td.decode(pt));
  }

  async function aesEncryptJson(keyOrBytes, obj) {
    const key = keyOrBytes instanceof CryptoKey ? keyOrBytes : await importAesKey(keyOrBytes, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      te.encode(JSON.stringify(obj))
    );
    return { iv: b64Encode(iv), ct: b64Encode(new Uint8Array(ct)) };
  }

  function nowSql(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function todayYmd(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function parseAuthQuery(authQueryStr) {
    const p = new URLSearchParams(authQueryStr || '');
    if (p.get('pin')) return { type: 'pin', val: p.get('pin').trim() };
    if (p.get('w')) return { type: 'w', val: p.get('w').trim() };
    if (p.get('k')) return { type: 'k', val: p.get('k').trim() };
    return null;
  }

  function getSiteKey() {
    const urlS = new URLSearchParams(window.location.search).get('s');
    if (urlS) {
      localStorage.setItem(SITE_KEY_STORAGE, urlS.trim());
      return urlS.trim();
    }
    return (localStorage.getItem(SITE_KEY_STORAGE) || '').trim();
  }

  function getDefaultBaseUrl() {
    const cleanPath = window.location.pathname.replace(/\/index\.html$/i, '').replace(/\/+$/, '');
    return `${window.location.origin}${cleanPath}/`;
  }

  async function npGet(url, { timeoutMs = 3500, retries = 1 } = {}) {
    const sep = url.includes('?') ? '&' : '?';
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(`${url}${sep}_=${Date.now()}`, { cache: 'no-store', signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`Cloud read failed (${res.status})`);
        const data = await res.json();
        saveCachedBin(url, data);
        return data;
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    }
    throw lastErr || new Error('Cloud read failed');
  }

  async function npPost(url, obj, { timeoutMs = 6000, retries = 1 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(obj),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`Cloud save failed (${res.status})`);
        const out = await res.json();
        saveCachedBin(url, obj);
        return out;
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    }
    throw lastErr || new Error('Cloud save failed');
  }

  async function loadManifest() {
    const siteKey = getSiteKey();
    if (!siteKey) {
      throw new Error('Open via your team invite link (?s=...) once to unlock this device.');
    }
    if (MANIFEST_CACHE && MANIFEST_CACHE.siteKey === siteKey) {
      return MANIFEST_CACHE;
    }
    const res = await fetch(`vault/cloud_manifest.enc.json?_=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('Could not load encrypted cloud manifest');
    const enc = await res.json();
    const mKey = await derivePbkdf2AesKey(siteKey, enc.salt, enc.iter || 250000);
    let data;
    try {
      data = await aesDecryptJson(mKey, enc);
    } catch {
      throw new Error('Invalid invite access key (?s=...). Use the link sent by Tyson.');
    }
    MANIFEST_CACHE = {
      siteKey,
      dirKeyBytes: b64Decode(data.dir_key_b64),
      hmacKeyBytes: b64Decode(data.hmac_key_b64),
      authBinUrl: data.auth_bin_url,
      fallbackAuthDir: data.fallback_auth_dir || null,
    };
    return MANIFEST_CACHE;
  }

  async function fetchAuthDir({ strict = false } = {}) {
    const m = await loadManifest();
    if (strict) {
      const raw = await npGet(m.authBinUrl, { timeoutMs: 5000, retries: 1 });
      if (raw && raw.enc_dir) {
        return await aesDecryptJson(m.dirKeyBytes, raw.enc_dir);
      }
      throw new Error('Auth directory empty');
    }
    try {
      const raw = await npGet(m.authBinUrl, { timeoutMs: 2800, retries: 1 });
      if (raw && raw.enc_dir) {
        return await aesDecryptJson(m.dirKeyBytes, raw.enc_dir);
      }
    } catch (e) {
      const cached = loadCachedBin(m.authBinUrl);
      if (cached && cached.enc_dir) {
        return await aesDecryptJson(m.dirKeyBytes, cached.enc_dir);
      }
      if (m.fallbackAuthDir) {
        return await aesDecryptJson(m.dirKeyBytes, m.fallbackAuthDir);
      }
      throw e;
    }
    const cached = loadCachedBin(m.authBinUrl);
    if (cached && cached.enc_dir) {
      return await aesDecryptJson(m.dirKeyBytes, cached.enc_dir);
    }
    if (m.fallbackAuthDir) {
      return await aesDecryptJson(m.dirKeyBytes, m.fallbackAuthDir);
    }
    throw new Error('Auth directory empty');
  }

  async function authenticate(authQueryStr, allowedRoles = null) {
    const cred = parseAuthQuery(authQueryStr);
    if (!cred || !cred.val) throw new Error('Invalid PIN');
    const cacheKey = `${cred.type}:${cred.val}`;

    if (!SESSION_CACHE || SESSION_CACHE.cacheKey !== cacheKey || (Date.now() - SESSION_CACHE.fetchedAt) > 60000) {
      const m = await loadManifest();
      const dir = await fetchAuthDir();
      const tagPrefix = cred.type === 'pin' ? 'pin:' : 'tok:';
      const tag = await hmacHex(m.hmacKeyBytes, tagPrefix + cred.val);
      const slot = dir.slots && dir.slots[tag];
      if (!slot) throw new Error('Invalid PIN');

      const slotKey = await derivePbkdf2AesKey(`${m.siteKey}:${cred.val}`, slot.salt, slot.iter || 250000);
      let slotData;
      try {
        slotData = await aesDecryptJson(slotKey, slot);
      } catch {
        throw new Error('Invalid PIN');
      }
      const u = slotData.user;
      if (!u || Number(u.active) !== 1) throw new Error('Invalid PIN');
      if (cred.type === 'w' && u.role !== 'warehouse') throw new Error('Invalid PIN');

      SESSION_CACHE = {
        cacheKey,
        fetchedAt: Date.now(),
        user: {
          id: Number(u.id),
          name: u.name,
          role: u.role,
          is_shared: Number(u.is_shared || 0),
          magic_token: u.magic_token,
        },
        staffOptions: (dir.public_wh_meta && dir.public_wh_meta.staff_options) || ['Brody', 'Dan', 'Warehouse'],
        whKeyBytes: slotData.wh_key_b64 ? b64Decode(slotData.wh_key_b64) : null,
        whBinUrl: slotData.wh_bin_url || '',
        photoBins: Array.isArray(slotData.photo_bins) ? slotData.photo_bins : [],
        fullKeyBytes: slotData.full_key_b64 ? b64Decode(slotData.full_key_b64) : null,
        philBinUrl: slotData.phil_bin_url || '',
        adminKeyBytes: slotData.admin_key_b64 ? b64Decode(slotData.admin_key_b64) : null,
      };
    }

    if (allowedRoles && !allowedRoles.includes(SESSION_CACHE.user.role)) {
      throw new Error('Forbidden for role: ' + SESSION_CACHE.user.role);
    }
    return SESSION_CACHE;
  }

  async function loadSeedItems(sess) {
    if (sess.user.role === 'warehouse') {
      if (SEED_CACHE.warehouse) return SEED_CACHE.warehouse;
      const res = await fetch('vault/seed_wh.enc.json?v=9');
      if (!res.ok) throw new Error('Could not load warehouse vault');
      const enc = await res.json();
      const arr = await aesDecryptJson(sess.whKeyBytes, enc);
      SEED_CACHE.warehouse = arr;
      return arr;
    }
    if (SEED_CACHE.full) return SEED_CACHE.full;
    const res = await fetch('vault/seed_full.enc.json?v=9');
    if (!res.ok) throw new Error('Could not load inventory vault');
    const enc = await res.json();
    const arr = await aesDecryptJson(sess.fullKeyBytes, enc);
    SEED_CACHE.full = arr;
    return arr;
  }

  async function readWhState(sess, { strict = false } = {}) {
    try {
      const raw = await npGet(sess.whBinUrl);
      if (raw && raw.enc) {
        const st = await aesDecryptJson(sess.whKeyBytes, raw.enc);
        return {
          items_patch: st.items_patch || {},
          uploads: Array.isArray(st.uploads) ? st.uploads : [],
          seen: st.seen || {},
        };
      }
      if (strict) throw new Error('Warehouse state missing');
    } catch (e) {
      if (strict) throw e;
      const cached = loadCachedBin(sess.whBinUrl);
      if (cached && cached.enc) {
        const st = await aesDecryptJson(sess.whKeyBytes, cached.enc);
        return {
          items_patch: st.items_patch || {},
          uploads: Array.isArray(st.uploads) ? st.uploads : [],
          seen: st.seen || {},
        };
      }
    }
    return { items_patch: {}, uploads: [], seen: {} };
  }

  async function writeWhState(sess, st) {
    const enc = await aesEncryptJson(sess.whKeyBytes, st);
    await npPost(sess.whBinUrl, { enc, v: 1 });
  }

  async function readPhilState(sess, { strict = false } = {}) {
    try {
      const raw = await npGet(sess.philBinUrl);
      if (raw && raw.enc) {
        const st = await aesDecryptJson(sess.fullKeyBytes, raw.enc);
        return {
          items_patch: st.items_patch || {},
          action_log: Array.isArray(st.action_log) ? st.action_log : [],
          nudge_state: st.nudge_state || {},
          nudge_log: Array.isArray(st.nudge_log) ? st.nudge_log : [],
          seen: st.seen || {},
        };
      }
      if (strict) throw new Error('Inventory review state missing');
    } catch (e) {
      if (strict) throw e;
      const cached = loadCachedBin(sess.philBinUrl);
      if (cached && cached.enc) {
        const st = await aesDecryptJson(sess.fullKeyBytes, cached.enc);
        return {
          items_patch: st.items_patch || {},
          action_log: Array.isArray(st.action_log) ? st.action_log : [],
          nudge_state: st.nudge_state || {},
          nudge_log: Array.isArray(st.nudge_log) ? st.nudge_log : [],
          seen: st.seen || {},
        };
      }
    }
    return { items_patch: {}, action_log: [], nudge_state: {}, nudge_log: [], seen: {} };
  }

  async function writePhilState(sess, st) {
    const enc = await aesEncryptJson(sess.fullKeyBytes, st);
    await npPost(sess.philBinUrl, { enc, v: 1 });
  }

  function blobFromB64(b64, mime = 'image/jpeg') {
    const bytes = b64Decode(b64);
    return new Blob([bytes], { type: mime });
  }

  async function hydrateUploadedPhotos(sess, uploads) {
    if (!uploads || !uploads.length) return;
    const neededShards = new Set();
    const unresolved = [];
    for (const u of uploads) {
      const key = u.id || u.file_path || `${u.bin_idx}:${u.item_code}:${u.created_at}`;
      if (PHOTO_CACHE.has(key)) continue;
      if (u.inline_enc) {
        unresolved.push({ u, key, inline: true });
      } else if (Number.isInteger(u.bin_idx) && sess.photoBins[u.bin_idx]) {
        neededShards.add(u.bin_idx);
        unresolved.push({ u, key, inline: false });
      }
    }
    if (!unresolved.length) return;

    const shardData = new Map();
    await Promise.all(Array.from(neededShards).map(async (idx) => {
      try {
        const res = await npGet(sess.photoBins[idx]);
        shardData.set(idx, (res && res.photos) || {});
      } catch {
        shardData.set(idx, {});
      }
    }));

    for (const entry of unresolved) {
      try {
        let enc = entry.inline ? entry.u.inline_enc : (shardData.get(entry.u.bin_idx) || {})[entry.u.id];
        if (!enc) continue;
        const dec = await aesDecryptJson(sess.whKeyBytes, enc);
        const objUrl = URL.createObjectURL(blobFromB64(dec.b64, dec.mime || 'image/jpeg'));
        PHOTO_CACHE.set(entry.key, objUrl);
      } catch {}
    }
  }

  function redactPrices(txt) {
    return String(txt || '').replace(/\$[\d,]+(?:\.\d+)?/g, '[PRICE HIDDEN]');
  }

  function stripForWarehouse(card) {
    const out = { ...card };
    [
      'start_bid', 'reserve_price', 'expected_price', 'bin_price', 'floor_price', 'ceiling_price',
      'orig_start_bid', 'orig_reserve_price', 'orig_expected_price', 'orig_bin_price', 'orig_floor_price', 'orig_ceiling_price',
      'live_ask',
    ].forEach((f) => { out[f] = null; });
    out.expected_line_total = 0;
    out.consignor = '';
    out.comp_source = '';
    out.comp_confidence = '';
    out.comp_summary = '';
    out.comps = [];
    out.price_preapproved = 0;
    out.catalog_sync = redactPrices(out.catalog_sync);
    out.phil_action_prompt = redactPrices(out.phil_action_prompt);
    return out;
  }

  function mergeItems(seedArr, whState, philState, isWhRole) {
    const uploadsByCode = new Map();
    for (const u of (whState.uploads || [])) {
      const key = u.id || u.file_path || `${u.bin_idx}:${u.item_code}:${u.created_at}`;
      const cachedUrl = PHOTO_CACHE.get(key);
      if (!cachedUrl) continue;
      if (!uploadsByCode.has(u.item_code)) uploadsByCode.set(u.item_code, []);
      uploadsByCode.get(u.item_code).push({
        src: cachedUrl,
        fallback: '',
        uploaded: true,
        shot_kind: u.shot_kind || 'general',
        actor: u.actor || 'Warehouse',
      });
    }

    const whPatchMap = whState.items_patch || {};
    const phPatchMap = (!isWhRole && philState && philState.items_patch) ? philState.items_patch : {};

    return seedArr.map((base) => {
      const it = { ...base, photos: (base.photos || []).map((p) => ({ ...p })), comps: (base.comps || []).map((c) => ({ ...c })) };
      const wp = whPatchMap[it.item_code];
      const pp = phPatchMap[it.item_code];
      const patches = [];
      if (wp) patches.push(wp);
      if (pp) patches.push(pp);
      patches.sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')));
      for (const p of patches) {
        Object.assign(it, p);
      }
      const extraPhotos = uploadsByCode.get(it.item_code);
      if (extraPhotos && extraPhotos.length) {
        const baseSeedPhotos = (it.photos || []).filter((p) => !p.uploaded);
        it.photos = [...baseSeedPhotos, ...extraPhotos];
      }
      return isWhRole ? stripForWarehouse(it) : it;
    });
  }

  function computeSummaryStats(items, philState) {
    const today = todayYmd();
    const decks = {};
    for (const it of items) {
      if (!decks[it.deck]) {
        decks[it.deck] = { total: 0, pending: 0, done: 0, oos: 0, pending_exp_value: 0 };
      }
      const d = decks[it.deck];
      d.total += 1;
      if (it.review_status === 'pending') {
        d.pending += 1;
        d.pending_exp_value += Number(it.expected_line_total || 0);
      } else if (it.review_status === 'out_of_stock') {
        d.oos += 1;
      } else if (['approved', 'price_changed', 'tag_captured', 'pre_approved_phil', 'pre_approved_consign'].includes(it.review_status)) {
        d.done += 1;
      }
    }

    const logs = (philState && philState.action_log) || [];
    const todayTaps = logs.filter((l) => String(l.created_at || '').slice(0, 10) === today && l.action !== 'skip_end').length;
    const todayVal = items
      .filter((it) => String(it.reviewed_at || '').slice(0, 10) === today && ['approved', 'price_changed', 'tag_captured', 'out_of_stock'].includes(it.review_status))
      .reduce((acc, it) => acc + Number(it.expected_line_total || 0), 0);

    const ns = (philState && philState.nudge_state) || {};
    return {
      decks,
      today_taps: todayTaps,
      today_value_reviewed: todayVal,
      streak_days: Number(ns.streak_days || 0),
      snooze_until: ns.snooze_until || null,
      blitz_mode: Number(ns.blitz_mode || 0),
      can_undo: logs.length > 0,
    };
  }

  function roundClean(v) {
    v = Number(v);
    if (v < 25) return Math.max(1, Math.round(v));
    if (v < 250) return Math.round(v / 5) * 5;
    if (v < 1000) return Math.round(v / 10) * 10;
    if (v < 5000) return Math.round(v / 25) * 25;
    return Math.round(v / 50) * 50;
  }

  function recomputePriceTiers(enteredPrice, mode = 'bin', conf = 'medium', item = null) {
    const entered = Math.max(1, Math.round(Number(enteredPrice) || 1));
    let bin, exp;
    if (mode === 'expected') {
      exp = entered;
      const binRaw = conf === 'high' ? exp * 1.2 : exp * 1.25;
      bin = Math.max(exp + (exp < 25 ? 2 : 5), roundClean(binRaw));
    } else {
      bin = entered;
      exp = roundClean(bin / 1.22);
      if (exp >= bin) {
        exp = Math.max(1, bin - (bin < 25 ? 2 : (bin < 250 ? 5 : 25)));
      }
      exp = Math.max(1, Math.min(exp, bin));
    }

    const isKasCostAnchored = item && /^KAS-/i.test(String(item.item_code || '')) && Number(item.orig_reserve_price || 0) > 0;
    const minStart = exp < 30 ? 5 : 10;
    let reserve, startBid, floor;
    if (isKasCostAnchored) {
      reserve = Math.max(1, Math.min(Math.round(Number(item.orig_reserve_price)), exp));
      startBid = roundClean(Math.max(minStart, reserve * 0.50));
      startBid = Math.max(1, Math.min(startBid, reserve));
      floor = roundClean(Math.max(reserve, exp * 0.60));
      floor = Math.max(reserve, Math.min(floor, exp));
    } else {
      const resMult = (conf === 'high' || conf === 'medium') ? 0.68 : 0.60;
      reserve = roundClean(exp * resMult);
      if (exp >= 10) reserve = Math.max(10, reserve);
      reserve = Math.max(1, Math.min(reserve, exp));

      startBid = roundClean(Math.max(minStart, reserve * 0.55));
      startBid = Math.max(1, Math.min(startBid, reserve));

      floor = roundClean(Math.max(reserve, exp * 0.80));
      floor = Math.max(reserve, Math.min(floor, exp));
    }

    const ceilMult = (conf === 'high' || conf === 'medium') ? 1.70 : 1.55;
    let ceiling = roundClean(Math.max(bin * 1.18, exp * ceilMult));
    const stepUp = exp < 25 ? 2 : (exp < 250 ? 5 : 25);
    if (ceiling <= bin) ceiling = bin + stepUp;

    startBid = Math.max(1, Math.min(startBid, reserve));
    reserve = Math.max(startBid, Math.min(reserve, floor));
    floor = Math.max(reserve, Math.min(floor, exp));
    exp = Math.max(floor, Math.min(exp, bin));
    bin = Math.max(exp, bin);
    ceiling = Math.max(bin, ceiling);

    return {
      start_bid: Math.round(startBid),
      reserve_price: Math.round(reserve),
      expected_price: Math.round(exp),
      bin_price: Math.round(bin),
      floor_price: Math.round(floor),
      ceiling_price: Math.round(ceiling),
    };
  }

  function updateStreak(ns, now) {
    const today = todayYmd();
    const yDate = new Date();
    yDate.setDate(yDate.getDate() - 1);
    const yesterday = todayYmd(yDate);
    let streak = Number(ns.streak_days || 0);
    if (ns.last_streak_date !== today) {
      streak = (ns.last_streak_date === yesterday) ? (streak + 1) : 1;
    }
    ns.last_activity_at = now;
    ns.snooze_until = null;
    ns.streak_days = streak;
    ns.last_streak_date = today;
    ns.updated_at = now;
  }

  function extractPatchFields(it) {
    return {
      deck: it.deck,
      deck_rank: it.deck_rank,
      review_status: it.review_status,
      qty: it.qty,
      basis: it.basis,
      start_bid: it.start_bid,
      reserve_price: it.reserve_price,
      expected_price: it.expected_price,
      bin_price: it.bin_price,
      floor_price: it.floor_price,
      ceiling_price: it.ceiling_price,
      expected_line_total: it.expected_line_total,
      phil_note: it.phil_note,
      wh_flag: it.wh_flag || '',
      wh_actor: it.wh_actor || '',
      wh_updated_at: it.wh_updated_at || null,
      reviewed_by: it.reviewed_by || '',
      reviewed_at: it.reviewed_at || null,
      updated_at: it.updated_at,
    };
  }

  function buildNudgePreview(authDir, stats, next5Val, msgIdx, baseUrl, nudgeState) {
    const decks = stats.decks || {};
    const high = (decks.Anywhere_High && decks.Anywhere_High.pending) || 0;
    const wh = (decks.Warehouse_Walk && decks.Warehouse_Walk.pending) || 0;
    const sweep = (decks.Stock_Sweep_Sub2k && decks.Stock_Sweep_Sub2k.pending) || 0;
    let totalItems = 0, doneItems = 0;
    Object.entries(decks).forEach(([k, info]) => {
      if (k === 'Consignment') return;
      totalItems += info.total;
      doneItems += info.done + info.oos;
    });
    const pct = totalItems > 0 ? Math.round((doneItems / totalItems) * 100) : 0;
    const next5Fmt = '$' + Math.round(next5Val).toLocaleString('en-US');
    const highValFmt = '$' + Math.round((decks.Anywhere_High && decks.Anywhere_High.pending_exp_value) || 0).toLocaleString('en-US');
    const philTok = (nudgeState && nudgeState.phil_magic_token) || '';
    const sPart = `s=${encodeURIComponent(getSiteKey())}&`;
    const base = String(baseUrl || getDefaultBaseUrl()).split('?')[0].replace(/\/+$/, '') + '/';
    const highUrl = `${base}?${sPart}k=${encodeURIComponent(philTok)}&mode=Anywhere_High`;
    const msg = high > 0
      ? `Morning PT Sprint: next 5 cards = ${next5Fmt} (${high} $2k+ left, ~60 sec total · ${pct}% overall, ${highValFmt} value): ${highUrl}`
      : (wh > 0 ? `All $2k+ pricing is DONE! Just ${wh} warehouse photo cards left` : `Fast sweep (${sweep} sub-$2k items left)`);
    return { msg, targetUrl: highUrl, remHigh: high, remWh: wh, remSweep: sweep };
  }

  function genMagicToken(role) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    let hex = '';
    for (const b of bytes) hex += b.toString(16).padStart(2, '0');
    const prefix = role === 'warehouse' ? 'ptwh_' : (role === 'admin' ? 'ptadm_' : 'ptm_');
    return prefix + hex;
  }

  async function buildAndSaveAuthDir(sess, adminUsersState) {
    const m = await loadManifest();
    const users = adminUsersState.users || [];
    const staffOptions = users
      .filter((u) => u.role === 'warehouse' && Number(u.active) === 1 && Number(u.is_shared) === 0)
      .map((u) => u.name);
    if (!staffOptions.includes('Warehouse')) staffOptions.push('Warehouse');

    const slots = {};
    for (const u of users) {
      if (Number(u.active) !== 1) continue;
      const baseSecret = {
        user: {
          id: Number(u.id),
          name: u.name,
          role: u.role,
          is_shared: Number(u.is_shared || 0),
          active: 1,
          magic_token: u.magic_token,
        },
        wh_key_b64: b64Encode(sess.whKeyBytes),
        wh_bin_url: sess.whBinUrl,
        photo_bins: sess.photoBins,
      };
      if (u.role === 'phil' || u.role === 'admin') {
        baseSecret.full_key_b64 = b64Encode(sess.fullKeyBytes);
        baseSecret.phil_bin_url = sess.philBinUrl;
      }
      if (u.role === 'admin') {
        baseSecret.admin_key_b64 = b64Encode(sess.adminKeyBytes);
      }

      for (const [prefix, val] of [['pin:', u.pin], ['tok:', u.magic_token]]) {
        if (!val) continue;
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const saltB64 = b64Encode(salt);
        const iter = 250000;
        const wrapKey = await derivePbkdf2AesKey(`${m.siteKey}:${val}`, saltB64, iter);
        const encSlot = await aesEncryptJson(wrapKey, baseSecret);
        const tag = await hmacHex(m.hmacKeyBytes, prefix + val);
        slots[tag] = { salt: saltB64, iter, iv: encSlot.iv, ct: encSlot.ct };
      }
    }

    const adminUsersEnc = await aesEncryptJson(sess.adminKeyBytes, adminUsersState);
    const dirObj = {
      v: 1,
      public_wh_meta: { staff_options: staffOptions },
      slots,
      admin_users_enc: adminUsersEnc,
    };
    const encDir = await aesEncryptJson(m.dirKeyBytes, dirObj);
    await npPost(m.authBinUrl, { enc_dir: encDir, v: 1 });
    SESSION_CACHE = null;
  }

  function formatUsersForAdmin(rawUsers, philState, whState) {
    const orderRank = (r) => (r === 'admin' ? 1 : (r === 'phil' ? 2 : 3));
    const sorted = rawUsers.slice().sort((a, b) =>
      (orderRank(a.role) - orderRank(b.role)) ||
      (Number(a.is_shared || 0) - Number(b.is_shared || 0)) ||
      (Number(a.id) - Number(b.id))
    );
    const pLogs = (philState && philState.action_log) || [];
    const ups = (whState && whState.uploads) || [];
    const seenMap = { ...(whState && whState.seen) || {}, ...(philState && philState.seen) || {} };

    return sorted.map((u) => {
      const uidStr = String(u.id);
      const lastSeen = seenMap[uidStr] || u.last_seen_at || null;
      const decisionsCount = pLogs.filter((l) => (l.actor === u.name || (u.name === 'Phil' && !l.actor)) && l.action !== 'skip_end').length;
      const photosCount = ups.filter((up) => up.actor === u.name).length;
      return {
        ...u,
        id: Number(u.id),
        active: Number(u.active),
        is_shared: Number(u.is_shared || 0),
        last_seen_at: lastSeen,
        decisions_count: decisionsCount,
        photos_count: photosCount,
      };
    });
  }

  async function handleGet(action, authQueryStr, extra = '') {
    if (action === 'ping') {
      return { ok: true, app: 'PT Medical Inventory Review', time: new Date().toISOString() };
    }
    if (action === 'auth_check') {
      const sess = await authenticate(authQueryStr);
      return { ok: true, role: sess.user.role, user: { id: sess.user.id, name: sess.user.name, role: sess.user.role, is_shared: sess.user.is_shared } };
    }
    if (action === 'state') {
      const sess = await authenticate(authQueryStr, ['phil', 'admin', 'warehouse']);
      const seed = await loadSeedItems(sess);
      const isWh = sess.user.role === 'warehouse';
      const [whState, philState] = await Promise.all([
        readWhState(sess),
        isWh ? Promise.resolve(null) : readPhilState(sess),
      ]);
      await hydrateUploadedPhotos(sess, whState.uploads);
      const merged = mergeItems(seed, whState, philState, isWh);
      if (isWh) {
        const cards = merged
          .filter((c) => c.deck === 'Warehouse_Walk' && c.review_status === 'pending')
          .sort((a, b) => (a.deck_rank - b.deck_rank) || (a.id - b.id));
        const whTot = merged.filter((c) => c.orig_deck === 'Warehouse_Walk' || c.deck === 'Warehouse_Walk' || c.wh_flag === 'photos_ready' || c.wh_flag === 'cant_find').length;
        const whPend = cards.length;
        return {
          ok: true,
          role: 'warehouse',
          user: { id: sess.user.id, name: sess.user.name, role: sess.user.role, is_shared: sess.user.is_shared },
          staff_options: sess.staffOptions,
          stats: { warehouse_pending: whPend, warehouse_total: whTot, warehouse_done: Math.max(0, whTot - whPend) },
          cards,
        };
      }
      merged.sort((a, b) => String(a.deck).localeCompare(String(b.deck)) || (a.deck_rank - b.deck_rank) || (a.id - b.id));
      const stats = computeSummaryStats(merged, philState);
      return {
        ok: true,
        role: sess.user.role,
        user: { id: sess.user.id, name: sess.user.name, role: sess.user.role, is_shared: sess.user.is_shared },
        stats,
        cards: merged,
      };
    }
    if (action === 'admin_overview') {
      const sess = await authenticate(authQueryStr, ['admin']);
      const [seed, whState, philState, dir] = await Promise.all([
        loadSeedItems(sess),
        readWhState(sess),
        readPhilState(sess),
        fetchAuthDir(),
      ]);
      await hydrateUploadedPhotos(sess, whState.uploads);
      const merged = mergeItems(seed, whState, philState, false);
      const stats = computeSummaryStats(merged, philState);
      const adminUsersState = await aesDecryptJson(sess.adminKeyBytes, dir.admin_users_enc);
      const users = formatUsersForAdmin(adminUsersState.users || [], philState, whState);

      const changes = merged
        .filter((it) => ['approved', 'price_changed', 'out_of_stock', 'tag_captured'].includes(it.review_status) || (it.wh_flag && it.wh_flag !== ''))
        .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
        .slice(0, 200);

      const boardMap = new Map();
      for (const up of (whState.uploads || [])) {
        const actor = up.actor || 'Unknown';
        if (!boardMap.has(actor)) boardMap.set(actor, { actor, items: new Set(), photos_count: 0, last_shot_at: up.created_at });
        const b = boardMap.get(actor);
        b.items.add(up.item_code);
        b.photos_count += 1;
        if (String(up.created_at || '') > String(b.last_shot_at || '')) b.last_shot_at = up.created_at;
      }
      const cfCountByActor = new Map();
      const cfLastByActor = new Map();
      for (const it of merged) {
        if (it.wh_flag === 'cant_find' && it.wh_actor) {
          cfCountByActor.set(it.wh_actor, (cfCountByActor.get(it.wh_actor) || 0) + 1);
          cfLastByActor.set(it.wh_actor, it.wh_updated_at || it.updated_at);
        }
      }
      const whBoard = [];
      boardMap.forEach((v, actor) => {
        whBoard.push({
          actor,
          items_shot: v.items.size,
          photos_count: v.photos_count,
          cant_find_count: cfCountByActor.get(actor) || 0,
          last_shot_at: v.last_shot_at,
        });
      });
      cfCountByActor.forEach((cnt, actor) => {
        if (!boardMap.has(actor)) {
          whBoard.push({ actor, items_shot: 0, photos_count: 0, cant_find_count: cnt, last_shot_at: cfLastByActor.get(actor) || null });
        }
      });
      whBoard.sort((a, b) => b.photos_count - a.photos_count);

      const ns = { ...(philState.nudge_state || {}) };
      if (!ns.base_url || String(ns.base_url).includes('imwebpros.com')) {
        ns.base_url = getDefaultBaseUrl();
      }

      return {
        ok: true,
        stats,
        nudge_state: ns,
        changes,
        warehouse_leaderboard: whBoard,
        nudge_log: (philState.nudge_log || []).slice().reverse().slice(0, 25),
        users,
        current_user: { id: sess.user.id, name: sess.user.name, role: sess.user.role, is_shared: sess.user.is_shared },
      };
    }
    if (action === 'cron_nudge') {
      const sess = await authenticate(authQueryStr, ['admin']);
      const [seed, whState, philState, dir] = await Promise.all([
        loadSeedItems(sess),
        readWhState(sess),
        readPhilState(sess),
        fetchAuthDir(),
      ]);
      const merged = mergeItems(seed, whState, philState, false);
      const stats = computeSummaryStats(merged, philState);
      const next5Val = merged
        .filter((it) => it.deck === 'Anywhere_High' && it.review_status === 'pending')
        .sort((a, b) => a.deck_rank - b.deck_rank)
        .slice(0, 5)
        .reduce((acc, it) => acc + Number(it.expected_line_total || 0), 0);
      const adminUsersState = await aesDecryptJson(sess.adminKeyBytes, dir.admin_users_enc);
      const philU = (adminUsersState.users || []).find((u) => u.role === 'phil' && Number(u.active) === 1);
      const ns = { ...(philState.nudge_state || {}), phil_magic_token: philU ? philU.magic_token : '' };
      const preview = buildNudgePreview(dir, stats, next5Val, Number(ns.last_msg_idx || -1) + 1, ns.base_url, ns);
      const qp = new URLSearchParams(extra || '');
      const forceWin = qp.get('force_window') || 'morning';
      return {
        ok: true,
        triggered: true,
        dry_run: true,
        payload: {
          first_name: 'Phil',
          window: forceWin,
          message: preview.msg,
          magic_url: preview.targetUrl,
          remaining_high: preview.remHigh,
          remaining_warehouse: preview.remWh,
          remaining_sweep: preview.remSweep,
          next5_value: Math.round(next5Val),
        },
        dispatch: { sent: false, channel: 'dry_run' },
      };
    }
    throw new Error('Unknown action: ' + action);
  }

  async function handlePost(action, authQueryStr, body) {
    if (action === 'decide') {
      return withMutex(async () => {
        const sess = await authenticate(authQueryStr, ['phil', 'admin']);
        const actorName = sess.user.name || 'Phil';
        const code = String(body.item_code || '').trim();
        const decision = String(body.decision || '').trim();
        const allowed = ['approve', 'still_have', 'out_of_stock', 'change_price', 'send_to_warehouse', 'tag_captured', 'skip_end'];
        if (!code || !allowed.includes(decision)) throw new Error('Invalid item_code or decision');

        const [seed, whState, philState] = await Promise.all([
          loadSeedItems(sess),
          readWhState(sess, { strict: true }),
          readPhilState(sess, { strict: true }),
        ]);
        const merged = mergeItems(seed, whState, philState, false);
        const idx = merged.findIndex((it) => it.item_code === code);
        if (idx < 0) throw new Error('Item not found');
        const item = merged[idx];

        const now = nowSql();
        const prevPrices = {
          start_bid: item.start_bid,
          reserve_price: item.reserve_price,
          expected_price: item.expected_price,
          bin_price: item.bin_price,
          floor_price: item.floor_price,
          ceiling_price: item.ceiling_price,
          expected_line_total: item.expected_line_total,
          deck_rank: item.deck_rank,
        };
        const logEntry = {
          id: (philState.action_log.length ? Number(philState.action_log[philState.action_log.length - 1].id || 0) : 0) + 1,
          item_id: item.id,
          item_code: code,
          action: decision,
          actor: actorName,
          prev_deck: item.deck,
          prev_status: item.review_status,
          prev_qty: item.qty,
          prev_basis: item.basis,
          prev_prices_json: prevPrices,
          prev_note: item.phil_note || '',
          created_at: now,
        };

        let newDeck = item.deck;
        let newStatus = item.review_status;
        let newQty = Number(item.qty);
        let newBasis = item.basis;
        let newNote = item.phil_note || '';
        let newRank = Number(item.deck_rank);
        let prices = {
          start_bid: item.start_bid,
          reserve_price: item.reserve_price,
          expected_price: item.expected_price,
          bin_price: item.bin_price,
          floor_price: item.floor_price,
          ceiling_price: item.ceiling_price,
        };
        let newExpLine = Number(item.expected_line_total || 0);
        let markReviewed = true;

        const maxRankForDeck = (dk) => merged.filter((x) => x.deck === dk).reduce((m, x) => Math.max(m, Number(x.deck_rank || 0)), 0);

        if (decision === 'approve' || decision === 'still_have') {
          newStatus = 'approved';
          if (body.phil_note !== undefined && String(body.phil_note).trim() !== '') newNote = String(body.phil_note).trim();
        } else if (decision === 'out_of_stock') {
          newStatus = 'out_of_stock';
          if (body.phil_note !== undefined && String(body.phil_note).trim() !== '') newNote = String(body.phil_note).trim();
        } else if (decision === 'send_to_warehouse') {
          newDeck = 'Warehouse_Walk';
          newStatus = 'pending';
          markReviewed = false;
          newRank = maxRankForDeck('Warehouse_Walk') + 1;
          if (body.phil_note !== undefined && String(body.phil_note).trim() !== '') newNote = String(body.phil_note).trim();
          else if (newNote === '') newNote = 'Flagged from mobile sprint to verify physical tag/condition in warehouse.';
        } else if (decision === 'skip_end') {
          newRank = maxRankForDeck(item.deck) + 1;
          markReviewed = false;
        } else if (decision === 'tag_captured') {
          newStatus = 'tag_captured';
          if (body.phil_note !== undefined) newNote = String(body.phil_note).trim();
          if (body.new_price !== undefined && Number(body.new_price) > 0) {
            const pMode = body.price_mode === 'expected' ? 'expected' : 'bin';
            prices = recomputePriceTiers(body.new_price, pMode, item.comp_confidence || 'medium', item);
            if (newBasis === 'PENDING ID') newBasis = 'Each';
          }
          if (prices.expected_price !== null) {
            newExpLine = newBasis === 'Lot' ? Number(prices.expected_price) : Number(prices.expected_price) * newQty;
          }
        } else if (decision === 'change_price') {
          const entered = body.new_price ?? item.bin_price ?? item.expected_price;
          if (!entered || Number(entered) <= 0) throw new Error('Valid positive new_price required');
          const pMode = body.price_mode === 'expected' ? 'expected' : 'bin';
          if (body.new_qty !== undefined && Number(body.new_qty) > 0) newQty = Number(body.new_qty);
          if (newBasis === 'PENDING ID') newBasis = 'Each';
          prices = recomputePriceTiers(entered, pMode, item.comp_confidence || 'medium', item);
          newExpLine = newBasis === 'Lot' ? Number(prices.expected_price) : Number(prices.expected_price) * newQty;
          newStatus = 'price_changed';
          if (body.phil_note !== undefined) newNote = String(body.phil_note).trim();
        }

        if (markReviewed && item.review_status !== 'pending') {
          newRank = maxRankForDeck(newDeck) + 1;
        }

        const updatedItem = {
          ...item,
          deck: newDeck,
          deck_rank: newRank,
          review_status: newStatus,
          qty: newQty,
          basis: newBasis,
          ...prices,
          expected_line_total: newExpLine,
          phil_note: newNote,
          wh_flag: markReviewed ? '' : (item.wh_flag || ''),
          reviewed_by: markReviewed ? actorName : (item.reviewed_by || ''),
          reviewed_at: markReviewed ? now : (item.reviewed_at || null),
          updated_at: now,
        };

        philState.items_patch[code] = extractPatchFields(updatedItem);
        philState.action_log.push(logEntry);
        philState.seen[String(sess.user.id)] = now;
        if (decision !== 'skip_end') {
          philState.nudge_state = philState.nudge_state || {};
          updateStreak(philState.nudge_state, now);
        }

        // Mirror price-stripped kick/undo context to wh_state when sending item to Warehouse_Walk
        let saveWh = false;
        if (decision === 'send_to_warehouse') {
          whState.items_patch[code] = {
            deck: 'Warehouse_Walk',
            deck_rank: newRank,
            review_status: 'pending',
            wh_flag: '',
            phil_note: redactPrices(newNote),
            updated_at: now,
          };
          saveWh = true;
        }

        await Promise.all([
          writePhilState(sess, philState),
          saveWh ? writeWhState(sess, whState) : Promise.resolve(),
        ]);

        merged[idx] = updatedItem;
        return {
          ok: true,
          item: updatedItem,
          stats: computeSummaryStats(merged, philState),
        };
      });
    }

    if (action === 'undo') {
      return withMutex(async () => {
        const sess = await authenticate(authQueryStr, ['phil', 'admin']);
        const [seed, whState, philState] = await Promise.all([
          loadSeedItems(sess),
          readWhState(sess, { strict: true }),
          readPhilState(sess, { strict: true }),
        ]);
        const last = philState.action_log.pop();
        if (!last) throw new Error('Nothing to undo');

        const merged = mergeItems(seed, whState, philState, false);
        const idx = merged.findIndex((it) => it.item_code === last.item_code);
        if (idx < 0) throw new Error('Item not found');
        const cur = merged[idx];
        const pp = last.prev_prices_json || {};
        const now = nowSql();

        const restored = {
          ...cur,
          deck: last.prev_deck,
          deck_rank: Number(pp.deck_rank ?? 1),
          review_status: last.prev_status,
          qty: Number(last.prev_qty),
          basis: last.prev_basis,
          start_bid: pp.start_bid ?? null,
          reserve_price: pp.reserve_price ?? null,
          expected_price: pp.expected_price ?? null,
          bin_price: pp.bin_price ?? null,
          floor_price: pp.floor_price ?? null,
          ceiling_price: pp.ceiling_price ?? null,
          expected_line_total: Number(pp.expected_line_total || 0),
          phil_note: last.prev_note || '',
          reviewed_by: last.prev_status === 'pending' ? '' : (cur.reviewed_by || ''),
          reviewed_at: last.prev_status === 'pending' ? null : cur.reviewed_at,
          updated_at: now,
        };
        philState.items_patch[last.item_code] = extractPatchFields(restored);
        philState.seen[String(sess.user.id)] = now;

        let saveWh = false;
        if (last.action === 'send_to_warehouse') {
          delete whState.items_patch[last.item_code];
          saveWh = true;
        }

        await Promise.all([
          writePhilState(sess, philState),
          saveWh ? writeWhState(sess, whState) : Promise.resolve(),
        ]);

        merged[idx] = restored;
        return {
          ok: true,
          restored_item: restored,
          stats: computeSummaryStats(merged, philState),
        };
      });
    }

    if (action === 'warehouse_action') {
      return withMutex(async () => {
        const sess = await authenticate(authQueryStr, ['warehouse', 'admin']);
        const code = String(body.item_code || '').trim();
        const whAct = String(body.wh_action || '').trim();
        if (!code || !['submit_photos', 'cant_find', 'skip_end'].includes(whAct)) {
          throw new Error('Invalid warehouse action');
        }
        const actor = (sess.user.role === 'warehouse' && !sess.user.is_shared)
          ? sess.user.name
          : (String(body.actor || sess.user.name || 'Warehouse').replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 32) || 'Warehouse');
        const whNote = String(body.wh_note || '').trim();
        const noSticker = !!body.no_sticker;

        const [seed, whState] = await Promise.all([
          loadSeedItems(sess),
          readWhState(sess, { strict: true }),
        ]);
        await hydrateUploadedPhotos(sess, whState.uploads);
        const merged = mergeItems(seed, whState, null, sess.user.role === 'warehouse');
        const idx = merged.findIndex((it) => it.item_code === code);
        if (idx < 0) throw new Error('Item not found');
        const item = merged[idx];
        if (item.deck !== 'Warehouse_Walk') throw new Error('Item is not in Warehouse_Walk');

        const now = nowSql();
        const itemUps = (whState.uploads || []).filter((u) => u.item_code === code);

        if (whAct === 'submit_photos') {
          const hasUnit = itemUps.some((u) => (u.shot_kind || 'general') === 'unit');
          const hasTag = itemUps.some((u) => u.shot_kind === 'tag');
          if (!hasUnit || (!hasTag && !noSticker)) {
            throw new Error('Upload both Full Unit Photo and Model/Serial Plate (or check No Readable Sticker).');
          }
          if (noSticker) {
            itemUps.forEach((u) => { u.no_sticker = 1; });
          }
          const isPendingId = String(item.basis || '').toUpperCase() === 'PENDING ID';
          const notePiece = `[${actor} Photos${noSticker ? ' (No Sticker)' : ''}]${whNote ? ' ' + whNote : ''}`;
          const mergedNote = item.phil_note ? `${notePiece} | ${item.phil_note}` : notePiece;
          const isConsignOrigin = item.orig_deck === 'Consignment';
          const targetDeck = isConsignOrigin ? 'Consignment' : (item.orig_deck === 'Stock_Sweep_Sub2k' ? 'Stock_Sweep_Sub2k' : 'Anywhere_High');
          const targetStatus = isConsignOrigin ? 'pre_approved_consign' : 'pending';

          whState.items_patch[code] = isPendingId
            ? { review_status: 'tag_captured', wh_flag: 'photos_ready', wh_actor: actor, wh_updated_at: now, reviewed_at: now, phil_note: mergedNote, updated_at: now }
            : { deck: targetDeck, deck_rank: 0, review_status: targetStatus, wh_flag: 'photos_ready', wh_actor: actor, wh_updated_at: now, phil_note: mergedNote, updated_at: now };
        } else if (whAct === 'cant_find') {
          const targetDeck = item.orig_deck === 'Stock_Sweep_Sub2k' || item.orig_deck === 'Consignment' ? 'Stock_Sweep_Sub2k' : 'Anywhere_High';
          const notePiece = `[${actor} COULD NOT LOCATE IN WAREHOUSE]${whNote ? ' ' + whNote : ''}`;
          const mergedNote = item.phil_note ? `${notePiece} | ${item.phil_note}` : notePiece;
          whState.items_patch[code] = {
            deck: targetDeck,
            deck_rank: -10,
            review_status: 'pending',
            wh_flag: 'cant_find',
            wh_actor: actor,
            wh_updated_at: now,
            phil_note: mergedNote,
            updated_at: now,
          };
        } else if (whAct === 'skip_end') {
          const maxRank = merged.filter((x) => x.deck === 'Warehouse_Walk').reduce((m, x) => Math.max(m, Number(x.deck_rank || 0)), 0);
          whState.items_patch[code] = { ...(whState.items_patch[code] || {}), deck_rank: maxRank + 1, updated_at: now };
        }

        whState.seen[String(sess.user.id)] = now;
        await writeWhState(sess, whState);

        const freshMerged = mergeItems(seed, whState, null, sess.user.role === 'warehouse');
        const freshItem = freshMerged.find((it) => it.item_code === code);
        const whTot = freshMerged.filter((c) => c.orig_deck === 'Warehouse_Walk' || c.deck === 'Warehouse_Walk' || c.wh_flag === 'photos_ready' || c.wh_flag === 'cant_find').length;
        const whPend = freshMerged.filter((c) => c.deck === 'Warehouse_Walk' && c.review_status === 'pending').length;

        return {
          ok: true,
          wh_action: whAct,
          stats: { warehouse_pending: whPend, warehouse_total: whTot, warehouse_done: Math.max(0, whTot - whPend) },
          item: freshItem,
        };
      });
    }

    if (action === 'snooze') {
      return withMutex(async () => {
        const sess = await authenticate(authQueryStr, ['phil', 'admin']);
        const preset = String(body.preset || '60m').trim();
        const d = new Date();
        let label = '1 hour';
        if (preset === '3h') {
          d.setHours(d.getHours() + 3);
          label = '3 hours';
        } else if (preset === 'tonight') {
          d.setHours(19, 0, 0, 0);
          if (d.getTime() <= Date.now()) d.setTime(Date.now() + 2 * 3600 * 1000);
          label = '7:00 PM tonight';
        } else if (preset === 'tomorrow') {
          d.setDate(d.getDate() + 1);
          d.setHours(8, 30, 0, 0);
          label = 'tomorrow at 8:30 AM';
        } else {
          d.setMinutes(d.getMinutes() + 60);
        }
        const until = nowSql(d);
        const philState = await readPhilState(sess, { strict: true });
        philState.nudge_state = philState.nudge_state || {};
        philState.nudge_state.snooze_until = until;
        philState.nudge_state.updated_at = nowSql();
        await writePhilState(sess, philState);
        return { ok: true, snooze_until: until, label };
      });
    }

    if (action === 'admin_settings') {
      return withMutex(async () => {
        const sess = await authenticate(authQueryStr, ['admin']);
        const philState = await readPhilState(sess, { strict: true });
        philState.nudge_state = philState.nudge_state || {};
        const blitz = body.blitz_mode ? 1 : 0;
        const webhook = String(body.ghl_webhook_url || '').trim();
        const baseUrl = String(body.base_url || getDefaultBaseUrl()).trim();
        philState.nudge_state.blitz_mode = blitz;
        philState.nudge_state.ghl_webhook_url = webhook;
        philState.nudge_state.base_url = baseUrl;
        philState.nudge_state.updated_at = nowSql();
        await writePhilState(sess, philState);
        return { ok: true, blitz_mode: blitz, ghl_webhook_url: webhook, base_url: baseUrl };
      });
    }

    if (action === 'admin_user_save') {
      return withMutex(async () => {
        const sess = await authenticate(authQueryStr, ['admin']);
        const dir = await fetchAuthDir({ strict: true });
        const adminUsersState = await aesDecryptJson(sess.adminKeyBytes, dir.admin_users_enc);
        const users = adminUsersState.users || [];

        const id = Number(body.id || 0);
        const name = String(body.name || '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 40);
        const role = String(body.role || 'warehouse').trim();
        const pin = String(body.pin || '').trim();
        const isShared = (role === 'warehouse' && body.is_shared) ? 1 : 0;
        const active = Object.prototype.hasOwnProperty.call(body, 'active') ? (body.active ? 1 : 0) : 1;
        const rotateToken = !!body.rotate_token;

        if (!name) throw new Error('Name is required.');
        if (!['admin', 'phil', 'warehouse'].includes(role)) throw new Error('Invalid role selected.');
        if (!/^\d{4}$/.test(pin)) throw new Error('PIN must be exactly 4 numeric digits (0-9).');

        const dup = users.find((u) => u.pin === pin && Number(u.id) !== id);
        if (dup) throw new Error(`PIN ${pin} is already assigned to ${dup.name}.`);

        const now = nowSql();
        let savedUser;
        if (id > 0) {
          const old = users.find((u) => Number(u.id) === id);
          if (!old) throw new Error('User not found.');
          if (Number(old.id) === sess.user.id && (!active || role !== 'admin')) {
            throw new Error('Cannot disable or demote your own active Admin account.');
          }
          if (old.role === 'admin' && Number(old.active) === 1 && (role !== 'admin' || !active)) {
            const others = users.filter((u) => u.role === 'admin' && Number(u.active) === 1 && Number(u.id) !== id).length;
            if (others === 0) throw new Error('At least one active Admin user is required.');
          }
          const roleChanged = (old.role === 'warehouse') !== (role === 'warehouse');
          old.name = name;
          old.role = role;
          old.pin = pin;
          old.magic_token = (rotateToken || roleChanged) ? genMagicToken(role) : old.magic_token;
          old.active = active;
          old.is_shared = isShared;
          old.updated_at = now;
          savedUser = old;
        } else {
          const nextId = Math.max(Number(adminUsersState.next_id || 1), ...users.map((u) => Number(u.id) + 1));
          adminUsersState.next_id = nextId + 1;
          savedUser = {
            id: nextId,
            name,
            role,
            pin,
            magic_token: genMagicToken(role),
            active,
            is_shared: isShared,
            last_seen_at: null,
            created_at: now,
            updated_at: now,
          };
          users.push(savedUser);
        }

        adminUsersState.users = users;
        await buildAndSaveAuthDir(sess, adminUsersState);
        const [whState, philState] = await Promise.all([readWhState(sess), readPhilState(sess)]);
        return {
          ok: true,
          saved_user: { ...savedUser, id: Number(savedUser.id), active: Number(savedUser.active), is_shared: Number(savedUser.is_shared || 0) },
          users: formatUsersForAdmin(users, philState, whState),
        };
      });
    }

    if (action === 'admin_user_toggle') {
      return withMutex(async () => {
        const sess = await authenticate(authQueryStr, ['admin']);
        const dir = await fetchAuthDir({ strict: true });
        const adminUsersState = await aesDecryptJson(sess.adminKeyBytes, dir.admin_users_enc);
        let users = adminUsersState.users || [];

        const id = Number(body.id || 0);
        const op = String(body.op || '').trim();
        if (id <= 0 || !['toggle_active', 'rotate_token', 'delete'].includes(op)) {
          throw new Error('Invalid operation or user ID.');
        }
        const target = users.find((u) => Number(u.id) === id);
        if (!target) throw new Error('User not found.');
        const now = nowSql();
        let savedUser = null;

        if (op === 'toggle_active') {
          const newActive = Number(target.active) ? 0 : 1;
          if (newActive === 0) {
            if (Number(target.id) === sess.user.id) throw new Error('Cannot disable your own active Admin account.');
            if (target.role === 'admin') {
              const others = users.filter((u) => u.role === 'admin' && Number(u.active) === 1 && Number(u.id) !== id).length;
              if (others === 0) throw new Error('Cannot disable the last active Admin.');
            }
          }
          target.active = newActive;
          target.updated_at = now;
          savedUser = target;
        } else if (op === 'rotate_token') {
          target.magic_token = genMagicToken(target.role);
          target.updated_at = now;
          savedUser = target;
        } else if (op === 'delete') {
          if (Number(target.id) === sess.user.id) throw new Error('Cannot delete your own active Admin account.');
          if (target.role === 'admin' && Number(target.active) === 1) {
            const others = users.filter((u) => u.role === 'admin' && Number(u.active) === 1 && Number(u.id) !== id).length;
            if (others === 0) throw new Error('Cannot delete the last active Admin.');
          }
          users = users.filter((u) => Number(u.id) !== id);
        }

        adminUsersState.users = users;
        await buildAndSaveAuthDir(sess, adminUsersState);
        const [whState, philState] = await Promise.all([readWhState(sess), readPhilState(sess)]);
        return {
          ok: true,
          op,
          saved_user: savedUser ? { ...savedUser, id: Number(savedUser.id), active: Number(savedUser.active), is_shared: Number(savedUser.is_shared || 0) } : null,
          users: formatUsersForAdmin(users, philState, whState),
        };
      });
    }

    throw new Error('Unknown action: ' + action);
  }

  async function uploadPhoto({ blob, item_code, shot_kind, actor, authQuery }) {
    return withMutex(async () => {
      const sess = await authenticate(authQuery, ['phil', 'admin', 'warehouse']);
      const safeActor = (sess.user.role === 'warehouse' && !sess.user.is_shared)
        ? sess.user.name
        : (String(actor || 'Warehouse').replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 32) || 'Warehouse');
      const kind = ['unit', 'tag', 'general'].includes(shot_kind) ? shot_kind : 'general';
      const [seed, whState] = await Promise.all([loadSeedItems(sess), readWhState(sess, { strict: true })]);
      await hydrateUploadedPhotos(sess, whState.uploads);

      const ab = await blob.arrayBuffer();
      const b64 = b64Encode(new Uint8Array(ab));
      const photoId = `ph_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
      const encPhoto = await aesEncryptJson(sess.whKeyBytes, {
        mime: blob.type || 'image/jpeg',
        b64,
        item_code,
        shot_kind: kind,
        actor: safeActor,
      });

      const objUrl = URL.createObjectURL(blob);
      PHOTO_CACHE.set(photoId, objUrl);

      let storedShardIdx = null;
      if (sess.photoBins && sess.photoBins.length) {
        const binIdx = whState.uploads.length % sess.photoBins.length;
        try {
          const shard = await npGet(sess.photoBins[binIdx]);
          const photosMap = (shard && shard.photos) || {};
          photosMap[photoId] = encPhoto;
          await npPost(sess.photoBins[binIdx], { photos: photosMap });
          storedShardIdx = binIdx;
        } catch {}
      }

      const now = nowSql();
      const uploadMeta = {
        id: photoId,
        item_code,
        shot_kind: kind,
        actor: safeActor,
        size_bytes: ab.byteLength,
        created_at: now,
        bin_idx: storedShardIdx,
        inline_enc: storedShardIdx === null ? encPhoto : undefined,
      };
      whState.uploads.push(uploadMeta);
      whState.items_patch[item_code] = {
        ...(whState.items_patch[item_code] || {}),
        missing_photo_reason: '',
        wh_actor: safeActor,
        wh_updated_at: now,
        updated_at: now,
      };
      whState.seen[String(sess.user.id)] = now;
      await writeWhState(sess, whState);

      const merged = mergeItems(seed, whState, null, sess.user.role === 'warehouse');
      const fresh = merged.find((it) => it.item_code === item_code);
      return { ok: true, item: fresh };
    });
  }

  function triggerDownload(filename, contentStr, mime) {
    const blob = new Blob([contentStr], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function downloadExport(kind, authQueryStr) {
    const sess = await authenticate(authQueryStr, ['admin']);
    const [seed, whState, philState] = await Promise.all([
      loadSeedItems(sess),
      readWhState(sess),
      readPhilState(sess),
    ]);
    const items = mergeItems(seed, whState, philState, false);
    items.sort((a, b) => String(a.sheet_tab).localeCompare(String(b.sheet_tab)) || (a.sheet_row - b.sheet_row));
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);

    if (kind === 'json') {
      const payload = {
        ok: true,
        exported_at: new Date().toISOString(),
        count: items.length,
        items,
        uploads: whState.uploads || [],
      };
      triggerDownload(`pt-review-export-${stamp}.json`, JSON.stringify(payload, null, 2), 'application/json');
      return;
    }

    const csvCell = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const headers = [
      'item_code', 'sheet_tab', 'sheet_row', 'deck', 'review_status', 'sku', 'title',
      'qty', 'basis', 'start_bid', 'reserve_price', 'expected_price', 'bin_price',
      'floor_price', 'ceiling_price', 'phil_note', 'reviewed_at', 'photos_count',
      'reviewed_by', 'wh_actor',
    ];
    const lines = [headers.join(',')];
    for (const r of items) {
      const upCnt = (r.photos || []).filter((p) => p.uploaded).length;
      lines.push([
        r.item_code, r.sheet_tab, r.sheet_row, r.deck, r.review_status, r.sku, r.title,
        r.qty, r.basis, r.start_bid, r.reserve_price, r.expected_price, r.bin_price,
        r.floor_price, r.ceiling_price, r.phil_note, r.reviewed_at, upCnt,
        r.reviewed_by || '', r.wh_actor || '',
      ].map(csvCell).join(','));
    }
    triggerDownload(`pt-review-decisions-${stamp}.csv`, lines.join('\r\n'), 'text/csv;charset=utf-8');
  }

  window.PT_CLOUD_API = {
    enabled: true,
    get: handleGet,
    post: handlePost,
    uploadPhoto,
    downloadExport,
  };
})();
