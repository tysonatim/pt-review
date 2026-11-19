/* PT Review — ADHD-Engineered Mobile Price Sprint Frontend */
(() => {
  'use strict';

  const STORAGE_KEY = 'pt_review_auth_v1';
  const QUEUE_KEY = 'pt_review_sync_queue_v1';
  const ACTOR_KEY = 'pt_review_wh_actor_v1';
  const SITE_KEY_STORAGE = 'pt_review_site_key_v5';

  const initialSiteKeyParam = new URLSearchParams(window.location.search).get('s');
  if (initialSiteKeyParam) {
    localStorage.setItem(SITE_KEY_STORAGE, initialSiteKeyParam.trim());
  }

  const state = {
    siteKey: (initialSiteKeyParam || localStorage.getItem(SITE_KEY_STORAGE) || '').trim(),
    auth: null, // { type: 'k'|'w'|'pin', val: string, role: 'phil'|'warehouse'|'admin' }
    user: null, // { id, name, role, is_shared }
    staffOptions: ['Brody', 'Dan', 'Warehouse'],
    adminUsers: [],
    whActor: localStorage.getItem(ACTOR_KEY) || '',
    whNoSticker: false,
    cards: [],
    stats: null,
    mode: 'Anywhere_High',
    sprintCount: 0,
    sprintValue: 0,
    showCompleted: false,
    pinnedCode: null,
    openedFromGrid: false,
    gridFilter: 'all',
    gridSort: 'price_desc',
    gridQuery: '',
    gridLimit: 80,
    gridScrollTop: 0,
    photoIdx: 0,
    editPriceMode: 'bin',
    editBaseBin: 500,
    editBaseExp: 410,
    editPct: 1,
    queue: [],
    syncing: false,
    pinBuffer: '',
  };

  const $ = (id) => document.getElementById(id);

  const fmt$ = (n) => (n === null || n === undefined ? 'TBD' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }));
  const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function loadStoredQueue() {
    try {
      state.queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    } catch {
      state.queue = [];
    }
  }

  function saveQueue() {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(state.queue));
  }

  function authQuery() {
    if (!state.auth) return '';
    if (state.auth.type === 'k') return `k=${encodeURIComponent(state.auth.val)}`;
    if (state.auth.type === 'w') return `w=${encodeURIComponent(state.auth.val)}`;
    return `pin=${encodeURIComponent(state.auth.val)}`;
  }

  function isWarehouseRole() {
    return !!(state.auth && state.auth.role === 'warehouse');
  }

  function copyText(str, msg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(str).then(() => showToast(msg)).catch(() => fallbackCopy(str, msg));
    } else {
      fallbackCopy(str, msg);
    }
  }

  function fallbackCopy(str, msg) {
    const ta = document.createElement('textarea');
    ta.value = str;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); showToast(msg); } catch { showToast('Copy failed — long press to copy'); }
    ta.remove();
  }

  function getAppBaseUrl() {
    const inp = $('adm-baseurl');
    let raw = (inp && inp.value.trim()) || window.location.href.split('?')[0];
    if (window.PT_CLOUD_API && window.PT_CLOUD_API.enabled && raw.includes('imwebpros.com')) {
      raw = window.location.href.split('?')[0];
    }
    return raw.split('?')[0].replace(/\/+$/, '');
  }

  function buildUserMagicUrl(u) {
    const base = getAppBaseUrl();
    const sPart = state.siteKey ? `s=${encodeURIComponent(state.siteKey)}&` : '';
    if (!u || !u.magic_token) return state.siteKey ? `${base}/?s=${encodeURIComponent(state.siteKey)}` : base;
    if (u.role === 'warehouse') return `${base}/?${sPart}w=${encodeURIComponent(u.magic_token)}`;
    if (u.role === 'admin') return `${base}/?${sPart}k=${encodeURIComponent(u.magic_token)}&admin=1`;
    return `${base}/?${sPart}k=${encodeURIComponent(u.magic_token)}&mode=Anywhere_High`;
  }

  function syncSelfSession(savedUser) {
    if (!savedUser || !state.user || Number(savedUser.id) !== Number(state.user.id)) return;
    state.user = {
      id: Number(savedUser.id),
      name: savedUser.name,
      role: savedUser.role,
      is_shared: Number(savedUser.is_shared || 0),
    };
    if (state.auth) {
      if (state.auth.type === 'pin') state.auth.val = savedUser.pin;
      else state.auth.val = savedUser.magic_token;
      state.auth.role = savedUser.role;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.auth));
    }
  }

  function renderStaffOptions() {
    const listEl = $('actor-options-list');
    if (!listEl) return;
    const opts = (state.staffOptions && state.staffOptions.length) ? state.staffOptions : ['Brody', 'Dan', 'Warehouse'];
    listEl.innerHTML = opts.map((name) => {
      const label = name === 'Warehouse' ? 'Other Warehouse Staff' : name;
      return `<button class="snooze-opt actor-pick" data-actor="${esc(name)}">${esc(label)}</button>`;
    }).join('');
  }

  async function apiGet(action, extra = '') {
    if (window.PT_CLOUD_API && window.PT_CLOUD_API.enabled) {
      return window.PT_CLOUD_API.get(action, authQuery(), extra);
    }
    const res = await fetch(`api.php?action=${encodeURIComponent(action)}&${authQuery()}${extra ? '&' + extra : ''}`);
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  async function apiPost(action, payload) {
    if (window.PT_CLOUD_API && window.PT_CLOUD_API.enabled) {
      return window.PT_CLOUD_API.post(action, authQuery(), payload || {});
    }
    const res = await fetch(`api.php?action=${encodeURIComponent(action)}&${authQuery()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(id).classList.add('active');
  }

  function showToast(msg, allowUndo = false) {
    $('toast-msg').textContent = msg;
    $('toast-undo').classList.toggle('hidden', !allowUndo || !(state.stats && state.stats.can_undo));
    $('toast').classList.remove('hidden');
    clearTimeout(state._toastT);
    state._toastT = setTimeout(() => $('toast').classList.add('hidden'), 3200);
  }

  // Exact JS port of php recompute_price_tiers for instant client-side preview
  function roundClean(v) {
    v = Number(v);
    if (v < 25) return Math.max(1, Math.round(v));
    if (v < 250) return Math.round(v / 5) * 5;
    if (v < 1000) return Math.round(v / 10) * 10;
    if (v < 5000) return Math.round(v / 25) * 25;
    return Math.round(v / 50) * 50;
  }

  function previewTiers(entered, mode = 'bin', conf = 'medium', card = null) {
    const val = Math.max(1, Math.round(Number(entered) || 1));
    let bin, exp;
    if (mode === 'expected') {
      exp = val;
      bin = Math.max(exp + (exp < 25 ? 2 : 5), roundClean(exp * (conf === 'high' ? 1.2 : 1.25)));
    } else {
      bin = val;
      exp = roundClean(bin / 1.22);
      if (exp >= bin) exp = Math.max(1, bin - (bin < 25 ? 2 : bin < 250 ? 5 : 25));
    }
    const isKasCostAnchored = card && /^KAS-/i.test(String(card.item_code || '')) && Number(card.orig_reserve_price || 0) > 0;
    let reserve, startBid, floor;
    if (isKasCostAnchored) {
      reserve = Math.max(1, Math.min(exp, Math.round(Number(card.orig_reserve_price))));
      startBid = roundClean(Math.max(exp < 30 ? 5 : 10, reserve * 0.50));
      startBid = Math.max(1, Math.min(startBid, reserve));
      floor = Math.max(reserve, Math.min(roundClean(Math.max(reserve, exp * 0.60)), exp));
    } else {
      reserve = roundClean(exp * (conf === 'low' ? 0.6 : 0.68));
      if (exp >= 10) reserve = Math.max(10, reserve);
      reserve = Math.max(1, Math.min(reserve, exp));
      startBid = roundClean(Math.max(exp < 30 ? 5 : 10, reserve * 0.55));
      startBid = Math.max(1, Math.min(startBid, reserve));
      floor = Math.max(reserve, Math.min(roundClean(Math.max(reserve, exp * 0.8)), exp));
    }
    let ceiling = roundClean(Math.max(bin * 1.18, exp * (conf === 'low' ? 1.55 : 1.7)));
    if (ceiling <= bin) ceiling = bin + (exp < 25 ? 2 : exp < 250 ? 5 : 25);
    return { startBid, reserve, floor, exp, bin, ceiling };
  }

  function getDeckCards() {
    const list = state.cards.filter((c) => c.deck === state.mode);
    if (state.showCompleted) return list;
    return list.filter((c) => c.review_status === 'pending');
  }

  function currentCard() {
    if (state.pinnedCode) {
      const pinned = state.cards.find((c) => c.item_code === state.pinnedCode);
      if (pinned) return pinned;
      state.pinnedCode = null;
    }
    const list = getDeckCards();
    return list.length ? list[0] : null;
  }

  function preloadNextPhotos() {
    const list = getDeckCards();
    for (let i = 1; i <= 4 && i < list.length; i++) {
      (list[i].photos || []).forEach((p) => {
        const im = new Image();
        im.src = p.src;
      });
    }
  }

  function updateHudCounts() {
    if (!state.stats) return;
    if (isWarehouseRole()) {
      $('phil-hud').classList.add('hidden');
      $('wh-only-hud').classList.remove('hidden');
      const rem = Number(state.stats.warehouse_pending || 0);
      const tot = Number(state.stats.warehouse_total || rem || 1);
      const done = Math.max(0, tot - rem);
      $('wh-only-count').textContent = `${rem} item${rem === 1 ? '' : 's'} left (${done}/${tot} done)`;
      const swBtn = $('btn-switch-actor');
      if (state.user && !state.user.is_shared) {
        state.whActor = state.user.name;
        swBtn.textContent = state.user.name;
        swBtn.disabled = true;
      } else {
        swBtn.disabled = false;
        swBtn.textContent = `${state.whActor || 'Select Rep'} \u25BE`;
      }
      $('wh-progress-fill').style.width = `${Math.round((done / tot) * 100)}%`;
      return;
    }
    $('phil-hud').classList.remove('hidden');
    $('wh-only-hud').classList.add('hidden');

    const d = state.stats.decks || {};
    $('cnt-high').textContent = (d.Anywhere_High && d.Anywhere_High.pending) || 0;
    $('cnt-wh').textContent = (d.Warehouse_Walk && d.Warehouse_Walk.pending) || 0;
    $('cnt-sweep').textContent = (d.Stock_Sweep_Sub2k && d.Stock_Sweep_Sub2k.pending) || 0;
    $('cnt-all').textContent = state.cards.length;
    $('more-cnt-con').textContent = (d.Consignment && d.Consignment.total) || 97;
    $('more-cnt-done').textContent = (d.done_phil && d.done_phil.total) || 22;

    document.querySelectorAll('.mode-pill').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === state.mode);
    });

    const backBtn = $('btn-back-grid');
    backBtn.classList.toggle('hidden', !(state.openedFromGrid && state.mode !== 'Grid_All'));

    if (state.mode === 'Grid_All') {
      $('sprint-label').textContent = `All Inventory · ${state.cards.length} items`;
    } else if (state.openedFromGrid && state.pinnedCode) {
      $('sprint-label').textContent = `Viewing ${state.pinnedCode} from Grid`;
    } else if (state.mode === 'Consignment') {
      $('sprint-label').textContent = `Consignment · ${(d.Consignment && d.Consignment.total) || 97} pre-priced`;
    } else if (state.mode === 'done_phil') {
      $('sprint-label').textContent = `Phil Pre-Approved · ${(d.done_phil && d.done_phil.total) || 22} items`;
    } else {
      const info = d[state.mode] || { total: 0, pending: 0, done: 0, oos: 0 };
      const doneCnt = (info.done || 0) + (info.oos || 0);
      $('sprint-label').textContent = `Queue: ${info.pending || 0} left · ${doneCnt} done`;
    }
    $('btn-undo').disabled = !state.stats.can_undo;

    // Master progress bar across all non-consignment PT items
    let tot = 0;
    let done = 0;
    ['done_phil', 'Anywhere_High', 'Warehouse_Walk', 'Stock_Sweep_Sub2k'].forEach((k) => {
      if (d[k]) {
        tot += d[k].total;
        done += d[k].done + d[k].oos;
      }
    });
    const pct = tot > 0 ? Math.round((done / tot) * 100) : 0;
    $('master-progress-fill').style.width = `${pct}%`;
  }

  function renderPhoto() {
    const card = currentCard();
    if (!card) return;
    const photos = card.photos || [];
    const imgEl = $('card-photo');
    const phEl = $('photo-placeholder');
    const prevBtn = $('btn-prev-photo');
    const nextBtn = $('btn-next-photo');
    const cntBadge = $('photo-counter');

    if (photos.length === 0) {
      imgEl.classList.add('hidden');
      phEl.classList.remove('hidden');
      $('ph-reason').textContent = card.missing_photo_reason || 'No warehouse photo attached yet — tap camera below in Warehouse Mode.';
      prevBtn.classList.add('hidden');
      nextBtn.classList.add('hidden');
      cntBadge.classList.add('hidden');
      return;
    }

    if (state.photoIdx >= photos.length) state.photoIdx = 0;
    const p = photos[state.photoIdx];
    phEl.classList.add('hidden');
    imgEl.classList.remove('hidden');
    imgEl.onerror = () => {
      if (p.fallback && imgEl.src !== p.fallback) {
        imgEl.src = p.fallback;
      }
    };
    imgEl.src = p.src;

    const multi = photos.length > 1;
    prevBtn.classList.toggle('hidden', !multi);
    nextBtn.classList.toggle('hidden', !multi);
    cntBadge.classList.toggle('hidden', !multi);
    if (multi) cntBadge.textContent = `${state.photoIdx + 1} / ${photos.length}`;
  }

  function refreshWarehouseStaffSlots(card) {
    const ups = (card.photos || []).filter((p) => p.uploaded);
    const hasUnit = ups.some((p) => (p.shot_kind || 'general') === 'unit');
    const hasTag = ups.some((p) => p.shot_kind === 'tag');
    const noSticker = $('chk-no-sticker').checked;

    $('btn-shot-unit').classList.toggle('done', hasUnit);
    $('lbl-shot-unit').textContent = hasUnit ? 'Unit Photo Saved (Tap to add more)' : 'Tap camera — required';
    $('btn-shot-tag').classList.toggle('done', hasTag);
    $('lbl-shot-tag').textContent = hasTag ? 'Serial Plate Saved (Tap to add more)' : (noSticker ? 'Skipped (No Sticker)' : 'Tap camera — required');

    const thumbs = $('wh-staff-thumbs');
    if (ups.length > 0) {
      thumbs.innerHTML = ups.map((p) => `<img src="${esc(p.src)}" alt="${esc(p.shot_kind || 'photo')}">`).join('');
      thumbs.classList.remove('hidden');
    } else {
      thumbs.innerHTML = '';
      thumbs.classList.add('hidden');
    }

    const ready = hasUnit && (hasTag || noSticker);
    const subBtn = $('btn-wh-submit');
    subBtn.disabled = !ready;
    subBtn.textContent = ready
      ? 'Submit Photos & Next Item'
      : (!hasUnit ? 'Snap Photo 1 (Full Unit) First' : 'Snap Photo 2 (Serial Plate) or Check Box');
  }

  function getFilteredGridCards() {
    const q = state.gridQuery.trim().toLowerCase();
    const f = state.gridFilter;
    let list = state.cards.filter((c) => {
      if (f === 'pending' && c.review_status !== 'pending') return false;
      else if (f === 'done' && !['approved', 'price_changed', 'tag_captured', 'pre_approved_phil'].includes(c.review_status)) return false;
      else if (f === 'oos' && c.review_status !== 'out_of_stock') return false;
      else if (['Anywhere_High', 'Warehouse_Walk', 'Stock_Sweep_Sub2k', 'Consignment'].includes(f) && c.deck !== f) return false;
      if (q && !`${c.item_code} ${c.title} ${c.sku} ${c.mfg} ${c.model}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const s = state.gridSort;
    list = list.slice().sort((a, b) => {
      if (s === 'price_desc') return (Number(b.bin_price || b.expected_line_total || 0) - Number(a.bin_price || a.expected_line_total || 0)) || (a.sheet_row - b.sheet_row);
      if (s === 'price_asc') return (Number(a.bin_price || a.expected_line_total || 9e9) - Number(b.bin_price || b.expected_line_total || 9e9)) || (a.sheet_row - b.sheet_row);
      return a.item_code.localeCompare(b.item_code, undefined, { numeric: true });
    });
    return list;
  }

  function tileClassAndStatus(c) {
    const st = c.review_status;
    let tileCls = 'grid-tile';
    let stLbl = '';
    let stCls = 'gt-status';
    if (st === 'out_of_stock') {
      tileCls += ' is-oos';
      stLbl = 'SOLD / OOS';
      stCls += ' st-oos';
    } else if (['approved', 'price_changed', 'tag_captured', 'pre_approved_phil'].includes(st)) {
      tileCls += ' is-approved';
      stLbl = st === 'price_changed' ? 'EDITED' : (st === 'tag_captured' ? 'SHOT' : 'DONE');
      stCls += ' st-done';
    } else if (st === 'pre_approved_consign') {
      stLbl = 'CONSIGN';
    } else if (c.deck === 'Warehouse_Walk') {
      stLbl = 'CAM';
      stCls += ' st-cam';
    } else if (c.deck === 'Anywhere_High') {
      stLbl = '$2K+';
    } else {
      stLbl = '<$2K';
    }
    return { tileCls, stLbl, stCls };
  }

  function renderGridTileHtml(c) {
    const { tileCls, stLbl, stCls } = tileClassAndStatus(c);
    const firstPhoto = (c.photos || [])[0];
    const photoHtml = firstPhoto
      ? `<img class="gt-photo" src="${esc(firstPhoto.src)}" loading="lazy" decoding="async" alt="" onerror="if(this.dataset.fb && this.src!==this.dataset.fb)this.src=this.dataset.fb;" data-fb="${esc(firstPhoto.fallback || '')}">`
      : `<div class="gt-no-photo">No Photo</div>`;
    const priceHtml = c.bin_price
      ? `<div class="gt-price">${fmt$(c.bin_price)}${Number(c.qty || 1) > 1 && String(c.basis).toLowerCase() !== 'lot' ? ` <small style="color:var(--muted);font-weight:600">x${c.qty}</small>` : ''}</div>`
      : `<div class="gt-price is-pending-id">Needs ID / Photo</div>`;
    return `<div class="${tileCls}" data-code="${esc(c.item_code)}">
      <div class="gt-photo-wrap" data-open="${esc(c.item_code)}">
        ${photoHtml}
        <span class="gt-code">${esc(c.item_code)}</span>
        <span class="${stCls}">${esc(stLbl)}</span>
      </div>
      <div class="gt-body" data-open="${esc(c.item_code)}">
        <div class="gt-title">${esc(c.title)}</div>
        <div class="gt-sub">${esc(c.sku || c.mfg || '')}</div>
        ${priceHtml}
      </div>
      <div class="gt-actions">
        <button class="gt-btn gt-btn-ok" data-gact="ok" data-code="${esc(c.item_code)}">OK</button>
        <button class="gt-btn gt-btn-oos" data-gact="oos" data-code="${esc(c.item_code)}">Gone</button>
      </div>
    </div>`;
  }

  function renderGrid(appendOnly = false) {
    const list = getFilteredGridCards();
    state._filteredGrid = list;
    const shown = list.slice(0, state.gridLimit);
    $('grid-summary').textContent = `Showing ${shown.length} of ${list.length} items (${state.cards.length} total)`;
    const wrap = $('grid-cards');
    if (appendOnly) {
      const existing = wrap.children.length;
      const chunk = list.slice(existing, state.gridLimit);
      if (chunk.length) wrap.insertAdjacentHTML('beforeend', chunk.map(renderGridTileHtml).join(''));
    } else {
      wrap.innerHTML = shown.map(renderGridTileHtml).join('');
    }
    $('grid-load-more').textContent = shown.length < list.length ? 'Scroll for more items...' : '';
  }

  function renderCard() {
    updateHudCounts();
    const whRole = isWarehouseRole();
    const isGrid = !whRole && state.mode === 'Grid_All';
    $('grid-stage').classList.toggle('hidden', !isGrid);
    $('card-stage').classList.toggle('hidden', isGrid);
    $('thumb-dock').classList.toggle('hidden', isGrid);
    if (isGrid) {
      renderGrid();
      return;
    }

    const card = currentCard();
    const emptyEl = $('deck-empty');
    const bodyEl = $('card-body');
    const dockEl = $('thumb-dock');

    if (!card) {
      bodyEl.classList.add('hidden');
      dockEl.classList.add('hidden');
      emptyEl.classList.remove('hidden');
      $('empty-title').textContent = whRole ? 'Warehouse Photo Queue Cleared!' : `${state.mode.replace(/_/g, ' ')} Cleared!`;
      $('empty-desc').textContent = whRole ? 'All assigned equipment photos have been submitted back to Phil.' : 'All items in this mode have been reviewed.';
      $('btn-next-deck').classList.toggle('hidden', whRole);
      $('btn-review-done').classList.toggle('hidden', whRole);
      return;
    }

    emptyEl.classList.add('hidden');
    bodyEl.classList.remove('hidden');
    dockEl.classList.remove('hidden');
    state.photoIdx = 0;

    // Badges
    const qtyNum = Number(card.qty || 1);
    const isLot = String(card.basis).toLowerCase() === 'lot';
    const qBadge = $('qty-badge');
    qBadge.textContent = isLot ? `LOT (${qtyNum} UNITS)` : (qtyNum > 1 ? `QTY: ${qtyNum} EACH` : 'QTY: 1');
    qBadge.classList.toggle('is-lot', isLot);
    $('code-badge').textContent = card.item_code;

    renderPhoto();

    // Alerts (incl. Warehouse Handoff notifications for Phil!)
    const fleetEl = $('fleet-banner');
    fleetEl.className = 'alert-banner alert-amber hidden';
    if (!whRole && card.wh_flag === 'cant_find') {
      fleetEl.className = 'alert-banner alert-red';
      fleetEl.textContent = `WAREHOUSE (${card.wh_actor || 'Staff'}) COULD NOT LOCATE THIS ITEM — Tap Sold/Gone to remove, or Approve if you have it.`;
      fleetEl.classList.remove('hidden');
    } else if (!whRole && card.wh_flag === 'photos_ready') {
      fleetEl.className = 'alert-banner alert-green';
      fleetEl.textContent = `NEW PHOTOS ADDED BY ${(card.wh_actor || 'WAREHOUSE').toUpperCase()} — Swipe photo above & Approve or Change $.`;
      fleetEl.classList.remove('hidden');
    } else if (card.fleet_warning) {
      fleetEl.textContent = card.fleet_warning;
      fleetEl.classList.remove('hidden');
    }

    const actEl = $('action-banner');
    const showActionBanner = card.phil_action_prompt && (whRole || state.mode === 'Warehouse_Walk' || /CRITICAL|COUNT CHECK|OVERLAP/i.test(card.phil_action_prompt));
    if (showActionBanner) {
      actEl.textContent = card.phil_action_prompt;
      actEl.classList.remove('hidden');
    } else {
      actEl.classList.add('hidden');
    }

    const stRow = $('status-pill-row');
    if (card.review_status !== 'pending') {
      stRow.classList.remove('hidden');
      const isOos = card.review_status === 'out_of_stock';
      const statusLabels = {
        pre_approved_phil: 'PRE-APPROVED BY PHIL',
        pre_approved_consign: 'CONSIGNMENT · PRE-PRICED',
        approved: 'APPROVED',
        price_changed: 'PRICE UPDATED',
        tag_captured: 'PHOTO CAPTURED',
        out_of_stock: 'SOLD / OUT OF STOCK',
      };
      const lbl = statusLabels[card.review_status] || card.review_status.replace(/_/g, ' ').toUpperCase();
      stRow.innerHTML = `<span class="done-tag ${isOos ? 'is-oos' : ''}">${esc(lbl)}</span>`;
    } else {
      stRow.classList.add('hidden');
    }

    // Title & specs
    const tEl = $('card-title');
    tEl.classList.remove('expanded');
    tEl.textContent = card.title;
    $('card-specs').textContent = [card.mfg, card.model, card.sku].filter(Boolean).join(' · ');

    // Live website ask / WH / consignor pills (hidden prices in warehouse role!)
    $('live-ask-pill').classList.toggle('hidden', whRole);
    if (!whRole) {
      $('live-ask-pill').textContent = card.live_ask ? `Live Website: ${fmt$(card.live_ask)}` : (card.catalog_sync ? card.catalog_sync.split('|')[0].trim() : 'Not on Website');
    }
    const whPill = $('wh-num-pill');
    if (card.warehouse_num) {
      whPill.textContent = `WH #${card.warehouse_num}`;
      whPill.classList.remove('hidden');
    } else {
      whPill.classList.add('hidden');
    }
    const conPill = $('consignor-pill');
    if (!whRole && card.consignor) {
      conPill.textContent = card.consignor.replace(/(\([^)]+\))\s+\1/g, '$1');
      conPill.classList.remove('hidden');
    } else {
      conPill.classList.add('hidden');
    }

    // Price box vs Phil Warehouse mode vs Locked Warehouse Staff mode
    const isPhilWhMode = !whRole && state.mode === 'Warehouse_Walk';
    $('hero-price-box').classList.toggle('hidden', whRole || (isPhilWhMode && !card.bin_price));
    $('wh-capture-box').classList.toggle('hidden', !isPhilWhMode);
    $('wh-staff-box').classList.toggle('hidden', !whRole);

    if (!whRole && card.bin_price) {
      $('hp-kicker').textContent = card.price_preapproved ? 'PRE-APPROVED LIST / BIN' : 'TARGET LIST / BUY-IT-NOW';
      $('hp-price').textContent = fmt$(card.bin_price);
      $('hp-unit').textContent = isLot ? '(Entire Lot)' : (qtyNum > 1 ? `each (${fmt$(card.bin_price * qtyNum)} total)` : '');
      $('hp-subline').textContent = `Expected: ${fmt$(card.expected_price)} · Floor: ${fmt$(card.floor_price)} · Reserve: ${fmt$(card.reserve_price)}`;
    }

    // Dock visibility
    $('dock-high').classList.toggle('hidden', whRole || state.mode !== 'Anywhere_High');
    $('dock-wh').classList.toggle('hidden', whRole || state.mode !== 'Warehouse_Walk');
    $('dock-sweep').classList.toggle('hidden', whRole || !['Stock_Sweep_Sub2k', 'Consignment', 'done_phil'].includes(state.mode));
    $('dock-wh-staff').classList.toggle('hidden', !whRole);

    if (whRole) {
      $('chk-no-sticker').checked = false;
      $('wh-staff-note').value = '';
      refreshWarehouseStaffSlots(card);
    } else if (state.mode === 'Anywhere_High') {
      const lbl = card.bin_price ? `Approve ${fmt$(card.bin_price)}${!isLot && qtyNum > 1 ? '/ea' : ''}` : 'Approve Price';
      $('btn-approve').textContent = lbl;
    } else if (state.mode === 'Warehouse_Walk') {
      const ups = (card.photos || []).filter((p) => p.uploaded);
      const thumbsEl = $('wh-thumbs');
      if (ups.length > 0) {
        thumbsEl.innerHTML = ups.map((p) => `<img src="${esc(p.src)}" alt="Captured">`).join('');
        thumbsEl.classList.remove('hidden');
        $('wh-cam-primary-wrap').classList.add('hidden');
        $('wh-cam-done-wrap').classList.remove('hidden');
      } else {
        thumbsEl.innerHTML = '';
        thumbsEl.classList.add('hidden');
        $('wh-cam-primary-wrap').classList.remove('hidden');
        $('wh-cam-done-wrap').classList.add('hidden');
      }
      $('wh-note-input').value = card.phil_note || '';
    } else {
      $('btn-sweep-have').textContent = card.bin_price ? `Still Have (${fmt$(card.bin_price)})` : 'Still Have';
    }

    preloadNextPhotos();
  }

  function applyLocalDecision(card, decision, extra = {}) {
    if (decision === 'skip_end') {
      const maxR = Math.max(0, ...state.cards.filter((c) => c.deck === card.deck).map((c) => c.deck_rank)) + 1;
      card.deck_rank = maxR;
      state.cards.sort((a, b) => a.deck_rank - b.deck_rank);
      if (state.stats) state.stats.can_undo = true;
      return;
    }

    const oldStatus = card.review_status;
    const prevDeck = card.deck;
    if (decision === 'approve' || decision === 'still_have') {
      card.review_status = 'approved';
    } else if (decision === 'out_of_stock') {
      card.review_status = 'out_of_stock';
    } else if (decision === 'tag_captured') {
      card.review_status = 'tag_captured';
      card.phil_note = extra.phil_note || card.phil_note;
    } else if (decision === 'send_to_warehouse') {
      card.deck = 'Warehouse_Walk';
      card.review_status = 'pending';
      const maxR = Math.max(0, ...state.cards.filter((c) => c.deck === 'Warehouse_Walk').map((c) => c.deck_rank)) + 1;
      card.deck_rank = maxR;
    } else if (decision === 'change_price') {
      const t = previewTiers(extra.new_price, extra.price_mode || 'bin', card.comp_confidence || 'medium', card);
      card.start_bid = t.startBid;
      card.reserve_price = t.reserve;
      card.expected_price = t.exp;
      card.bin_price = t.bin;
      card.floor_price = t.floor;
      card.ceiling_price = t.ceiling;
      if (extra.new_qty) card.qty = Number(extra.new_qty);
      if (card.basis === 'PENDING ID') card.basis = 'Each';
      card.expected_line_total = card.basis === 'Lot' ? t.exp : t.exp * Number(card.qty || 1);
      card.review_status = 'price_changed';
      if (extra.phil_note !== undefined) card.phil_note = extra.phil_note;
    }

    if (decision !== 'send_to_warehouse' && (oldStatus !== 'pending' || state.showCompleted)) {
      const maxR = Math.max(0, ...state.cards.filter((c) => c.deck === card.deck).map((c) => c.deck_rank)) + 1;
      card.deck_rank = maxR;
      state.cards.sort((a, b) => a.deck_rank - b.deck_rank);
    }

    // Update local summary counters optimistically
    if (state.stats && state.stats.decks) {
      if (decision === 'send_to_warehouse') {
        if (oldStatus === 'pending' && state.stats.decks[prevDeck]) state.stats.decks[prevDeck].pending = Math.max(0, state.stats.decks[prevDeck].pending - 1);
        if (state.stats.decks.Warehouse_Walk) {
          state.stats.decks.Warehouse_Walk.pending += 1;
          state.stats.decks.Warehouse_Walk.total += 1;
        }
      } else if (oldStatus === 'pending' && state.stats.decks[prevDeck]) {
        state.stats.decks[prevDeck].pending = Math.max(0, state.stats.decks[prevDeck].pending - 1);
        if (card.review_status === 'out_of_stock') state.stats.decks[prevDeck].oos += 1;
        else state.stats.decks[prevDeck].done += 1;
      }
      state.stats.today_taps += 1;
      state.stats.can_undo = true;
    }
  }

  async function flushQueue() {
    if (state.syncing || state.queue.length === 0) return;
    state.syncing = true;
    $('sync-badge').classList.remove('hidden');
    while (state.queue.length > 0) {
      const job = state.queue[0];
      try {
        const res = await apiPost('decide', job);
        state.queue.shift();
        saveQueue();
        if (res.item) {
          const idx = state.cards.findIndex((c) => c.item_code === res.item.item_code);
          if (idx >= 0) state.cards[idx] = res.item;
        }
        if (res.stats) state.stats = res.stats;
      } catch {
        break;
      }
    }
    state.syncing = false;
    $('sync-badge').classList.toggle('hidden', state.queue.length === 0);
    updateHudCounts();
  }

  function submitDecision(decision, extra = {}, explicitCard = null) {
    const card = explicitCard || currentCard();
    if (!card) return;
    const itemVal = Number(card.expected_line_total || card.bin_price || 0);

    applyLocalDecision(card, decision, extra);
    state.queue.push({ item_code: card.item_code, decision, ...extra });
    saveQueue();
    flushQueue();

    if (decision !== 'skip_end') {
      state.sprintCount += 1;
      state.sprintValue += itemVal;
    }

    const msgMap = {
      approve: 'Approved',
      still_have: 'Confirmed In Stock',
      out_of_stock: 'Marked Out of Stock',
      price_changed: 'Price Updated',
      change_price: 'Price Updated',
      send_to_warehouse: 'Moved to Warehouse Cam',
      tag_captured: 'Photo Saved',
      skip_end: 'Moved to End of Queue',
    };

    if (explicitCard && state.mode === 'Grid_All') {
      const existingTile = $('grid-cards').querySelector(`.grid-tile[data-code="${CSS.escape(card.item_code)}"]`);
      if (existingTile) existingTile.outerHTML = renderGridTileHtml(card);
      updateHudCounts();
      showToast(`${msgMap[decision] || 'Saved'} (${card.item_code})`, true);
      return;
    }

    state.pinnedCode = null;
    if (state.openedFromGrid) {
      state.mode = 'Grid_All';
      state.openedFromGrid = false;
      renderCard();
      $('grid-scroll').scrollTop = state.gridScrollTop;
      showToast(`${msgMap[decision] || 'Saved'} (${card.item_code})`, true);
      return;
    }

    if (decision !== 'skip_end' && state.sprintCount > 0 && state.sprintCount % 10 === 0) {
      showToast(`${state.sprintCount} reviewed (${fmt$(state.sprintValue)}) — keep rolling!`, true);
    } else {
      showToast(`${msgMap[decision] || 'Saved'} (${card.item_code})`, true);
    }
    renderCard();
  }

  async function doUndo() {
    await flushQueue();
    try {
      const res = await apiPost('undo', {});
      const rItem = res.restored_item;
      const idx = state.cards.findIndex((c) => c.item_code === rItem.item_code);
      if (idx >= 0) state.cards[idx] = rItem;
      state.cards.sort((a, b) => a.deck_rank - b.deck_rank);
      if (res.stats) state.stats = res.stats;
      state.sprintCount = Math.max(0, state.sprintCount - 1);
      if (state.mode === 'Grid_All') {
        const existingTile = $('grid-cards').querySelector(`.grid-tile[data-code="${CSS.escape(rItem.item_code)}"]`);
        if (existingTile) existingTile.outerHTML = renderGridTileHtml(rItem);
        updateHudCounts();
      } else {
        state.mode = rItem.deck;
        state.pinnedCode = rItem.item_code;
        renderCard();
      }
      showToast(`Undid ${rItem.item_code}`);
    } catch (e) {
      showToast(e.message || 'Nothing to undo');
    }
  }

  // Client-side Canvas JPEG compression so 12MP iPhone camera shots upload in <1s
  function compressImageFile(file, maxDim = 1600, quality = 0.82) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width: w, height: h } = img;
        if (w > maxDim || h > maxDim) {
          if (w > h) { h = Math.round((h * maxDim) / w); w = maxDim; }
          else { w = Math.round((w * maxDim) / h); h = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Image encode failed'));
        }, 'image/jpeg', quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  async function handleCameraFiles(files, shotKind = 'general') {
    const card = currentCard();
    if (!card || !files || !files.length) return;
    $('sync-badge').classList.remove('hidden');
    for (const file of Array.from(files)) {
      try {
        const isCloud = !!(window.PT_CLOUD_API && window.PT_CLOUD_API.enabled);
        const blob = await compressImageFile(file, isCloud ? 1280 : 1600, isCloud ? 0.78 : 0.82);
        const actor = isWarehouseRole() ? (state.whActor || 'Warehouse') : (state.user ? state.user.name : 'Phil');
        let data;
        if (isCloud) {
          data = await window.PT_CLOUD_API.uploadPhoto({
            blob,
            item_code: card.item_code,
            shot_kind: shotKind,
            actor,
            authQuery: authQuery(),
          });
        } else {
          const fd = new FormData();
          fd.append('item_code', card.item_code);
          fd.append('shot_kind', shotKind);
          fd.append('actor', actor);
          fd.append('photo', blob, `${card.item_code}_${shotKind}.jpg`);
          const res = await fetch(`api.php?action=upload_photo&${authQuery()}`, { method: 'POST', body: fd });
          data = await res.json();
        }
        if (data.ok && data.item) {
          const idx = state.cards.findIndex((c) => c.item_code === data.item.item_code);
          if (idx >= 0) state.cards[idx] = data.item;
        }
      } catch (e) {
        showToast('Upload error: ' + e.message);
      }
    }
    $('sync-badge').classList.add('hidden');
    renderCard();
    showToast(isWarehouseRole() ? 'Photo saved!' : 'Photo uploaded! Tap Done or snap another.');
  }

  async function doWarehouseAction(whAction) {
    const card = currentCard();
    if (!card) return;
    const actor = state.whActor || 'Warehouse';
    const note = $('wh-staff-note').value.trim();
    const noSticker = $('chk-no-sticker').checked;
    try {
      const res = await apiPost('warehouse_action', {
        item_code: card.item_code,
        wh_action: whAction,
        actor,
        no_sticker: noSticker,
        wh_note: note,
      });
      if (whAction === 'skip_end') {
        const maxR = Math.max(0, ...state.cards.map((c) => c.deck_rank)) + 1;
        card.deck_rank = maxR;
        state.cards.sort((a, b) => a.deck_rank - b.deck_rank);
        showToast('Moved to end of queue');
      } else {
        state.cards = state.cards.filter((c) => c.item_code !== card.item_code);
        if (res.stats) state.stats = res.stats;
        showToast(whAction === 'cant_find' ? 'Flagged for Phil to confirm' : 'Photos sent to Phil!');
      }
      renderCard();
    } catch (e) {
      showToast(e.message || 'Upload both required photos first');
    }
  }

  function openPriceModal() {
    const card = currentCard();
    if (!card) return;
    const conf = card.comp_confidence || 'medium';
    const baseBin = card.bin_price || (card.expected_price ? previewTiers(card.expected_price, 'expected', conf, card).bin : (card.live_ask || 500));
    const baseExp = card.expected_price || previewTiers(baseBin, 'bin', conf, card).exp;
    state.editBaseBin = baseBin;
    state.editBaseExp = baseExp;
    state.editPriceMode = 'bin';
    state.editPct = 1;
    document.querySelectorAll('.pm-btn').forEach((b) => b.classList.toggle('active', b.dataset.pm === 'bin'));
    document.querySelectorAll('.pct-btn').forEach((b) => b.classList.toggle('active', Number(b.dataset.pct) === 1));
    $('inp-price').value = String(baseBin);
    $('inp-qty').value = String(Math.max(1, Number(card.qty || 1)));
    $('edit-basis-lbl').textContent = card.basis === 'PENDING ID' ? 'Each' : card.basis;
    $('inp-price-note').value = card.phil_note || '';
    refreshPricePreview();
    $('modal-price').classList.remove('hidden');
  }

  function refreshPricePreview() {
    const card = currentCard();
    const t = previewTiers($('inp-price').value, state.editPriceMode, (card && card.comp_confidence) || 'medium', card);
    const qty = Math.max(1, Number($('inp-qty').value || 1));
    const isLot = card && String(card.basis).toLowerCase() === 'lot';
    const multiLine = (!isLot && qty > 1)
      ? `<br><span style="color:#93C5FD">Qty ${qty} Total: <b>${fmt$(t.bin * qty)}</b> List/BIN · <b>${fmt$(t.exp * qty)}</b> Expected</span>`
      : '';
    $('tier-live-preview').innerHTML =
      `<strong>Auto-Updated Tiers:</strong><br>` +
      `Start Bid: <b>${fmt$(t.startBid)}</b> · Reserve: <b>${fmt$(t.reserve)}</b> · Sales Floor: <b>${fmt$(t.floor)}</b><br>` +
      `Expected: <b>${fmt$(t.exp)}</b> · List/BIN: <b style="color:#34D399">${fmt$(t.bin)}</b> · Ceiling: <b>${fmt$(t.ceiling)}</b>` +
      multiLine;
  }

  function openCompsModal() {
    const card = currentCard();
    if (!card) return;
    const comps = card.comps || [];
    let html = `
      <div class="comp-item">
        <strong>All 6 Price Tiers (${esc(card.basis)})</strong><br>
        Start Bid: ${fmt$(card.start_bid)} &nbsp;|&nbsp; Reserve: ${fmt$(card.reserve_price)}<br>
        Sales Floor: ${fmt$(card.floor_price)} &nbsp;|&nbsp; Expected: ${fmt$(card.expected_price)}<br>
        List / BIN: <strong>${fmt$(card.bin_price)}</strong> &nbsp;|&nbsp; Sales Ceiling: ${fmt$(card.ceiling_price)}
      </div>
      <div class="comp-item">
        <strong>Source (${esc(card.comp_confidence)}):</strong> ${esc(card.comp_source)}<br><br>
        ${esc(card.comp_summary)}
      </div>
    `;
    if (comps.length > 0) {
      comps.forEach((c) => {
        html += `<div class="comp-item">
          <b>${esc(c.type)} ${fmt$(c.price)}</b> ${c.date ? '· ' + esc(c.date) : ''} ${c.condition ? '· ' + esc(c.condition) : ''}<br>
          ${esc(c.title)}<br>
          ${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.url)}</a>` : ''}
        </div>`;
      });
    } else {
      html += `<div class="comp-item">No external comp rows linked.</div>`;
    }
    $('comps-sheet-body').innerHTML = html;
    $('modal-comps').classList.remove('hidden');
  }

  async function loadAppData(opts = {}) {
    const data = await apiGet('state');
    state.cards = data.cards || [];
    state.stats = data.stats || null;
    state.auth.role = data.role;
    if (data.user) state.user = data.user;
    if (Array.isArray(data.staff_options) && data.staff_options.length) {
      state.staffOptions = data.staff_options;
    }

    const params = new URLSearchParams(window.location.search);
    if (isWarehouseRole()) {
      state.mode = 'Warehouse_Walk';
      renderStaffOptions();
      if (state.user && !state.user.is_shared) {
        state.whActor = state.user.name;
      }
      showScreen('app-screen');
      renderCard();
      if ((!state.user || state.user.is_shared) && !state.whActor) {
        $('modal-actor').classList.remove('hidden');
      }
      return;
    }

    if (opts.mode) state.mode = opts.mode;
    else if (params.get('mode')) state.mode = params.get('mode');
    if (params.get('sprint')) state.sprintTarget = Math.max(1, parseInt(params.get('sprint'), 10) || 5);

    if (params.get('snooze')) {
      try {
        const sn = await apiPost('snooze', { preset: params.get('snooze') });
        showToast(`Reminder snoozed until ${sn.label}`);
      } catch {}
    }

    if ((params.get('admin') === '1' || opts.openAdmin) && data.role === 'admin') {
      await openAdminScreen();
      return;
    }

    showScreen('app-screen');
    renderCard();
    flushQueue();
  }

  function renderAdminUsers() {
    const listEl = $('admin-users-list');
    if (!listEl) return;
    const users = state.adminUsers || [];
    if (!users.length) {
      listEl.innerHTML = '<div class="adm-row">No users configured.</div>';
      return;
    }
    const roleLabel = { admin: 'ADMIN', phil: 'PRICE REVIEW', warehouse: 'WAREHOUSE PHOTO' };
    const roleClass = { admin: 'role-admin', phil: 'role-phil', warehouse: 'role-wh' };
    listEl.innerHTML = users.map((u) => {
      const isMe = state.user && Number(u.id) === Number(state.user.id);
      const active = Number(u.active) === 1;
      const seen = u.last_seen_at ? `Seen ${u.last_seen_at}` : 'Not used yet';
      return `<div class="user-row-card ${active ? '' : 'is-disabled'}" data-uid="${u.id}">
        <div class="ur-top">
          <div class="ur-name">${esc(u.name)}${isMe ? ' <small style="color:#93C5FD">(You)</small>' : ''}</div>
          <div class="ur-badges">
            <span class="ur-pill ${roleClass[u.role] || 'role-wh'}">${roleLabel[u.role] || esc(u.role)}</span>
            ${Number(u.is_shared) === 1 ? '<span class="ur-pill role-wh">SHARED</span>' : ''}
            <span class="ur-pill ${active ? 'st-on' : 'st-off'}">${active ? 'ACTIVE' : 'DISABLED'}</span>
          </div>
        </div>
        <div class="ur-meta">
          <span class="ur-pin-badge">PIN: ${esc(u.pin)}</span>
          <span>${Number(u.decisions_count || 0)} reviews &middot; ${Number(u.photos_count || 0)} photos</span>
          <span>${esc(seen)}</span>
        </div>
        <div class="ur-actions">
          <button type="button" class="ur-btn" data-uact="copy_link" data-uid="${u.id}">Copy Link</button>
          <button type="button" class="ur-btn" data-uact="copy_invite" data-uid="${u.id}">Copy Invite</button>
          <button type="button" class="ur-btn" data-uact="edit" data-uid="${u.id}">Edit / PIN</button>
          <button type="button" class="ur-btn" data-uact="rotate" data-uid="${u.id}">Rotate Link</button>
          ${isMe ? '' : `<button type="button" class="ur-btn ${active ? 'ur-warn' : 'ur-ok'}" data-uact="toggle" data-uid="${u.id}">${active ? 'Disable' : 'Enable'}</button>`}
        </div>
      </div>`;
    }).join('');
  }

  function openUserModal(u = null) {
    const isNew = !u;
    const isMe = u && state.user && Number(u.id) === Number(state.user.id);
    $('modal-user-title').textContent = isNew ? 'Add User & PIN' : `Edit ${u.name}`;
    $('usr-id').value = isNew ? '0' : String(u.id);
    $('usr-name').value = isNew ? '' : u.name;
    $('usr-role').value = isNew ? 'warehouse' : u.role;
    $('usr-pin').value = isNew ? '' : u.pin;
    $('usr-shared').checked = !isNew && Number(u.is_shared) === 1;
    $('usr-rotate').checked = false;
    $('usr-shared-wrap').classList.toggle('hidden', $('usr-role').value !== 'warehouse');
    $('usr-rotate-wrap').classList.toggle('hidden', isNew);
    $('btn-delete-user').classList.toggle('hidden', isNew || isMe);
    $('usr-form-err').textContent = '';
    $('usr-form-err').classList.add('hidden');
    $('modal-user').classList.remove('hidden');
  }

  async function openAdminScreen() {
    try {
      const ov = await apiGet('admin_overview');
      const d = ov.stats.decks || {};
      const grid = $('admin-progress-cards');
      const labels = [
        ['Anywhere_High', '$2k+ Sprints'],
        ['Warehouse_Walk', 'Warehouse Cam'],
        ['Stock_Sweep_Sub2k', 'Sub-$2k Sweep'],
        ['done_phil', 'Phil Already Done'],
        ['Consignment', 'Consignment'],
      ];
      grid.innerHTML = labels.map(([k, title]) => {
        const info = d[k] || { total: 0, pending: 0, done: 0, oos: 0 };
        const finished = info.done + info.oos;
        return `<div class="adm-stat-card"><h4>${title}</h4><div class="adm-stat-big">${finished}/${info.total}</div><small>${info.pending} pending · ${info.oos} OOS</small></div>`;
      }).join('');

      const ns = ov.nudge_state || {};
      $('adm-blitz').checked = Number(ns.blitz_mode || 0) === 1;
      $('adm-webhook').value = ns.ghl_webhook_url || '';
      $('adm-baseurl').value = ns.base_url || window.location.href.split('?')[0];
      $('btn-export-csv').href = `api.php?action=export_csv&${authQuery()}`;
      $('btn-export-json').href = `api.php?action=export_json&${authQuery()}`;

      if (ov.current_user) state.user = ov.current_user;
      state.adminUsers = ov.users || [];
      renderAdminUsers();

      const wb = ov.warehouse_leaderboard || [];
      $('admin-wh-board').innerHTML = wb.length
        ? wb.map((w) => `<div class="adm-row"><b>${esc(w.actor)}</b> · ${w.items_shot} items shot · ${w.photos_count} photos · ${w.cant_find_count} couldn't find</div>`).join('')
        : '<div class="adm-row">No warehouse staff photos uploaded yet.</div>';

      const changes = ov.changes || [];
      $('adm-chg-cnt').textContent = changes.length;
      $('admin-changes-list').innerHTML = changes.length
        ? changes.map((c) => `<div class="adm-row"><b>${esc(c.item_code)}</b> · <span style="color:#34D399">${esc(c.review_status)}${c.reviewed_by ? ' by ' + esc(c.reviewed_by) : (c.wh_actor ? ' (' + esc(c.wh_actor) + ')' : '')}</span> · ${esc(c.title)}<br><small>BIN: ${fmt$(c.orig_bin_price)} &rarr; ${fmt$(c.bin_price)} · Qty ${c.qty} ${c.phil_note ? '· Note: ' + esc(c.phil_note) : ''}</small></div>`).join('')
        : '<div class="adm-row">No mobile edits logged yet.</div>';

      const logs = ov.nudge_log || [];
      $('admin-nudge-log').innerHTML = logs.length
        ? logs.map((l) => `<div class="adm-row"><b>${esc(l.window_key)}</b> (${esc(l.status)} via ${esc(l.channel)})<br><small>${esc(l.message)}</small></div>`).join('')
        : '<div class="adm-row">No nudges fired yet.</div>';

      showScreen('admin-screen');
    } catch (e) {
      showToast(e.message);
    }
  }

  function wireEvents() {
    // PIN Keypad
    $('pin-grid').addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const k = btn.dataset.k;
      if (k === 'clr') state.pinBuffer = '';
      else if (k === 'del') state.pinBuffer = state.pinBuffer.slice(0, -1);
      else if (state.pinBuffer.length < 4) state.pinBuffer += k;

      const dots = $('pin-dots').querySelectorAll('span');
      dots.forEach((sp, i) => sp.classList.toggle('filled', i < state.pinBuffer.length));
      $('login-error').textContent = '';

      if (state.pinBuffer.length === 4) {
        try {
          state.auth = { type: 'pin', val: state.pinBuffer, role: 'phil' };
          const chk = await apiGet('auth_check');
          state.auth.role = chk.role;
          state.user = chk.user || null;
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state.auth));
          state.pinBuffer = '';
          dots.forEach((sp) => sp.classList.remove('filled'));
          await loadAppData({ openAdmin: chk.role === 'admin' });
        } catch (err) {
          state.auth = null;
          state.pinBuffer = '';
          dots.forEach((sp) => sp.classList.remove('filled'));
          $('login-error').textContent = (err && err.message && err.message !== 'Invalid PIN' && err.message !== 'Request failed')
            ? err.message
            : 'Incorrect PIN';
        }
      }
    });

    // Mode tabs
    document.querySelectorAll('.mode-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.mode = btn.dataset.mode;
        state.showCompleted = false;
        state.pinnedCode = null;
        state.openedFromGrid = false;
        state.sprintCount = 0;
        state.sprintValue = 0;
        renderCard();
      });
    });

    // Return to Grid from inspected item
    $('btn-back-grid').addEventListener('click', () => {
      state.pinnedCode = null;
      state.openedFromGrid = false;
      state.mode = 'Grid_All';
      renderCard();
      $('grid-scroll').scrollTop = state.gridScrollTop;
    });

    // All Grid View search, sort, filters, infinite scroll, and tile clicks
    $('grid-search').addEventListener('input', () => {
      state.gridQuery = $('grid-search').value;
      state.gridLimit = 80;
      renderGrid();
    });
    $('grid-sort').addEventListener('change', () => {
      state.gridSort = $('grid-sort').value;
      state.gridLimit = 80;
      renderGrid();
    });
    $('grid-filters').addEventListener('click', (e) => {
      const btn = e.target.closest('.gf-pill');
      if (!btn) return;
      state.gridFilter = btn.dataset.gf;
      state.gridLimit = 80;
      document.querySelectorAll('.gf-pill').forEach((p) => p.classList.toggle('active', p === btn));
      renderGrid();
    });
    $('grid-scroll').addEventListener('scroll', () => {
      const el = $('grid-scroll');
      if (state._filteredGrid && state.gridLimit < state._filteredGrid.length && (el.scrollTop + el.clientHeight >= el.scrollHeight - 400)) {
        state.gridLimit += 80;
        renderGrid(true);
      }
    }, { passive: true });
    $('grid-cards').addEventListener('click', (e) => {
      const actBtn = e.target.closest('[data-gact]');
      if (actBtn) {
        const card = state.cards.find((c) => c.item_code === actBtn.dataset.code);
        if (!card) return;
        const dec = actBtn.dataset.gact === 'oos' ? 'out_of_stock' : (card.price_preapproved ? 'still_have' : 'approve');
        submitDecision(dec, {}, card);
        return;
      }
      const openEl = e.target.closest('[data-open]');
      if (openEl) {
        const card = state.cards.find((c) => c.item_code === openEl.dataset.open);
        if (!card) return;
        state.gridScrollTop = $('grid-scroll').scrollTop;
        state.openedFromGrid = true;
        state.pinnedCode = card.item_code;
        state.mode = card.deck;
        renderCard();
      }
    });

    // Global iOS double-tap & pinch zoom guard (CSS touch-action: manipulation handles rapid taps without swallowing clicks)
    document.addEventListener('dblclick', (e) => {
      if (!e.target.closest('#modal-zoom')) e.preventDefault();
    }, { passive: false });
    document.addEventListener('gesturestart', (e) => {
      if (!e.target.closest('#modal-zoom')) e.preventDefault();
    }, { passive: false });

    // Photo carousel + zoom + title expand
    $('btn-prev-photo').addEventListener('click', (e) => {
      e.stopPropagation();
      const card = currentCard();
      if (!card || !card.photos.length) return;
      state.photoIdx = (state.photoIdx - 1 + card.photos.length) % card.photos.length;
      renderPhoto();
    });
    $('btn-next-photo').addEventListener('click', (e) => {
      e.stopPropagation();
      const card = currentCard();
      if (!card || !card.photos.length) return;
      state.photoIdx = (state.photoIdx + 1) % card.photos.length;
      renderPhoto();
    });
    $('card-photo').addEventListener('click', () => {
      $('zoom-img').src = $('card-photo').src;
      $('modal-zoom').classList.remove('hidden');
    });
    $('card-title').addEventListener('click', () => $('card-title').classList.toggle('expanded'));

    // Touch swipe left/right on multi-photo box
    let touchX = 0;
    $('photo-box').addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
    $('photo-box').addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - touchX;
      const card = currentCard();
      if (!card || (card.photos || []).length <= 1 || Math.abs(dx) < 40) return;
      state.photoIdx = dx < 0
        ? (state.photoIdx + 1) % card.photos.length
        : (state.photoIdx - 1 + card.photos.length) % card.photos.length;
      renderPhoto();
    }, { passive: true });

    // Primary Mode 1 buttons
    $('btn-approve').addEventListener('click', () => submitDecision('approve'));
    $('btn-edit-price').addEventListener('click', openPriceModal);
    $('btn-oos').addEventListener('click', () => submitDecision('out_of_stock'));
    $('btn-to-wh').addEventListener('click', () => submitDecision('send_to_warehouse'));
    $('btn-skip-high').addEventListener('click', () => submitDecision('skip_end'));

    // Mode 2 Camera buttons (Phil)
    $('btn-snap-photo').addEventListener('click', () => $('camera-input').click());
    $('btn-snap-more').addEventListener('click', () => $('camera-input').click());
    $('camera-input').addEventListener('change', (e) => {
      handleCameraFiles(e.target.files, 'general');
      e.target.value = '';
    });

    // Locked Warehouse Staff Camera Slots & Actions
    $('btn-shot-unit').addEventListener('click', () => $('cam-unit-input').click());
    $('btn-shot-tag').addEventListener('click', () => $('cam-tag-input').click());
    $('cam-unit-input').addEventListener('change', (e) => {
      handleCameraFiles(e.target.files, 'unit');
      e.target.value = '';
    });
    $('cam-tag-input').addEventListener('change', (e) => {
      handleCameraFiles(e.target.files, 'tag');
      e.target.value = '';
    });
    $('chk-no-sticker').addEventListener('change', () => {
      const card = currentCard();
      if (card) refreshWarehouseStaffSlots(card);
    });
    $('btn-wh-submit').addEventListener('click', () => doWarehouseAction('submit_photos'));
    $('btn-wh-cant-find').addEventListener('click', () => doWarehouseAction('cant_find'));
    $('btn-wh-staff-skip').addEventListener('click', () => doWarehouseAction('skip_end'));
    $('btn-switch-actor').addEventListener('click', () => {
      if (state.user && !state.user.is_shared) return;
      renderStaffOptions();
      $('modal-actor').classList.remove('hidden');
    });
    $('btn-wh-logout').addEventListener('click', () => {
      localStorage.removeItem(STORAGE_KEY);
      state.auth = null;
      state.user = null;
      showScreen('login-screen');
    });
    $('actor-options-list').addEventListener('click', (e) => {
      const b = e.target.closest('.actor-pick');
      if (!b) return;
      state.whActor = b.dataset.actor;
      localStorage.setItem(ACTOR_KEY, state.whActor);
      $('modal-actor').classList.add('hidden');
      updateHudCounts();
      showToast(`Shooting as ${state.whActor}`);
    });
    $('btn-wh-done').addEventListener('click', () => {
      submitDecision('tag_captured', { phil_note: $('wh-note-input').value.trim() });
    });
    $('btn-wh-trash').addEventListener('click', () => submitDecision('out_of_stock', { phil_note: $('wh-note-input').value.trim() }));
    $('btn-wh-price').addEventListener('click', openPriceModal);
    $('btn-wh-skip').addEventListener('click', () => submitDecision('skip_end'));

    // Mode 3 Stock Sweep buttons
    $('btn-sweep-have').addEventListener('click', () => submitDecision('still_have'));
    $('btn-sweep-gone').addEventListener('click', () => submitDecision('out_of_stock'));
    $('btn-sweep-price').addEventListener('click', openPriceModal);
    $('btn-sweep-wh').addEventListener('click', () => submitDecision('send_to_warehouse'));
    $('btn-sweep-skip').addEventListener('click', () => submitDecision('skip_end'));

    // Undo / Toast Undo / Comps / Snooze / More
    $('btn-undo').addEventListener('click', doUndo);
    $('toast-undo').addEventListener('click', doUndo);
    $('btn-comps').addEventListener('click', openCompsModal);
    $('btn-snooze').addEventListener('click', () => $('modal-snooze').classList.remove('hidden'));
    $('btn-more').addEventListener('click', () => $('modal-more').classList.remove('hidden'));

    // Close modals
    document.querySelectorAll('.sheet-close, .zoom-close, .modal-backdrop').forEach((el) => {
      el.addEventListener('click', () => {
        const targetId = el.dataset.close;
        if (targetId) $(targetId).classList.add('hidden');
        else el.closest('.modal').classList.add('hidden');
      });
    });

    // Price Edit Sheet (percent chips always calculate from card's original baseline, never compound)
    document.querySelectorAll('.pct-btn').forEach((b) => {
      b.addEventListener('click', () => {
        const clickedPct = Number(b.dataset.pct);
        const pct = (state.editPct === clickedPct && clickedPct !== 1) ? 1 : clickedPct;
        state.editPct = pct;
        const base = state.editPriceMode === 'expected' ? state.editBaseExp : state.editBaseBin;
        $('inp-price').value = String(pct === 1 ? base : Math.max(1, roundClean(base * pct)));
        document.querySelectorAll('.pct-btn').forEach((x) => x.classList.toggle('active', Number(x.dataset.pct) === pct));
        refreshPricePreview();
      });
    });
    document.querySelectorAll('.pm-btn').forEach((b) => {
      b.addEventListener('click', () => {
        const nextMode = b.dataset.pm;
        if (nextMode === state.editPriceMode) return;
        const card = currentCard();
        const curTiers = previewTiers($('inp-price').value, state.editPriceMode, (card && card.comp_confidence) || 'medium', card);
        state.editPriceMode = nextMode;
        document.querySelectorAll('.pm-btn').forEach((x) => x.classList.toggle('active', x === b));
        if (state.editPct !== null) {
          const base = nextMode === 'expected' ? state.editBaseExp : state.editBaseBin;
          $('inp-price').value = String(state.editPct === 1 ? base : Math.max(1, roundClean(base * state.editPct)));
        } else {
          $('inp-price').value = String(nextMode === 'expected' ? curTiers.exp : curTiers.bin);
        }
        refreshPricePreview();
      });
    });
    $('inp-price').addEventListener('input', () => {
      const clean = $('inp-price').value.replace(/\D/g, '');
      $('inp-price').value = clean;
      const base = state.editPriceMode === 'expected' ? state.editBaseExp : state.editBaseBin;
      state.editPct = (clean !== '' && Number(clean) === base) ? 1 : null;
      document.querySelectorAll('.pct-btn').forEach((x) => x.classList.toggle('active', state.editPct !== null && Number(x.dataset.pct) === state.editPct));
      refreshPricePreview();
    });
    $('inp-price').addEventListener('focus', () => setTimeout(() => { try { $('inp-price').select(); } catch {} }, 20));
    $('qty-minus').addEventListener('click', () => {
      $('inp-qty').value = String(Math.max(1, Number($('inp-qty').value || 1) - 1));
      refreshPricePreview();
    });
    $('qty-plus').addEventListener('click', () => {
      $('inp-qty').value = String(Math.max(1, Number($('inp-qty').value || 1) + 1));
      refreshPricePreview();
    });
    $('inp-qty').addEventListener('input', () => {
      $('inp-qty').value = $('inp-qty').value.replace(/\D/g, '');
      refreshPricePreview();
    });
    $('inp-qty').addEventListener('focus', () => setTimeout(() => { try { $('inp-qty').select(); } catch {} }, 20));
    $('btn-save-price').addEventListener('click', () => {
      const fallbackBase = state.editPriceMode === 'expected' ? state.editBaseExp : state.editBaseBin;
      const enteredPrice = Math.max(1, Number($('inp-price').value.replace(/\D/g, '') || fallbackBase || 1));
      const enteredQty = Math.max(1, Number($('inp-qty').value.replace(/\D/g, '') || 1));
      $('modal-price').classList.add('hidden');
      submitDecision('change_price', {
        new_price: enteredPrice,
        price_mode: state.editPriceMode,
        new_qty: enteredQty,
        phil_note: $('inp-price-note').value.trim(),
      });
    });

    // Sprint celebration actions
    $('btn-sprint-next').addEventListener('click', () => {
      state.sprintCount = 0;
      state.sprintValue = 0;
      $('modal-sprint').classList.add('hidden');
      updateHudCounts();
    });
    $('btn-sprint-stop').addEventListener('click', () => {
      state.sprintCount = 0;
      state.sprintValue = 0;
      $('modal-sprint').classList.add('hidden');
      updateHudCounts();
      showToast('Progress saved — pick up anytime!');
    });

    // Snooze options
    document.querySelectorAll('.snooze-opt').forEach((b) => {
      b.addEventListener('click', async () => {
        $('modal-snooze').classList.add('hidden');
        try {
          const res = await apiPost('snooze', { preset: b.dataset.snooze });
          showToast(`Snoozed! We'll text you in ${res.label}.`);
        } catch (e) {
          showToast(e.message);
        }
      });
    });

    // More drawer options
    document.querySelectorAll('[data-jump]').forEach((b) => {
      b.addEventListener('click', () => {
        $('modal-more').classList.add('hidden');
        state.mode = b.dataset.jump;
        state.showCompleted = (b.dataset.jump === 'Consignment' || b.dataset.jump === 'done_phil');
        renderCard();
      });
    });
    $('btn-toggle-completed').addEventListener('click', () => {
      $('modal-more').classList.add('hidden');
      state.showCompleted = !state.showCompleted;
      renderCard();
      showToast(state.showCompleted ? 'Showing all items (incl. done)' : 'Showing unreviewed items only');
    });
    $('btn-review-done').addEventListener('click', () => {
      state.showCompleted = true;
      renderCard();
    });
    $('btn-next-deck').addEventListener('click', () => {
      const d = (state.stats && state.stats.decks) || {};
      const order = ['Anywhere_High', 'Warehouse_Walk', 'Stock_Sweep_Sub2k'];
      const next = order.find((m) => m !== state.mode && d[m] && d[m].pending > 0);
      if (next) {
        state.mode = next;
        state.showCompleted = false;
        renderCard();
      } else {
        showToast('Every queue is cleared!');
      }
    });
    $('btn-open-search').addEventListener('click', () => {
      $('modal-more').classList.add('hidden');
      $('modal-search').classList.remove('hidden');
      $('inp-search').focus();
    });
    $('inp-search').addEventListener('input', () => {
      const q = $('inp-search').value.trim().toLowerCase();
      const hits = q
        ? state.cards.filter((c) =>
            `${c.item_code} ${c.title} ${c.sku} ${c.mfg} ${c.model}`.toLowerCase().includes(q)
          ).slice(0, 25)
        : [];
      $('search-results').innerHTML = hits.map((c) =>
        `<button class="search-hit" data-code="${esc(c.item_code)}"><b>${esc(c.item_code)}</b> · ${esc(c.title)}<small>${esc(c.deck)} · ${esc(c.review_status)} · BIN ${fmt$(c.bin_price)}</small></button>`
      ).join('');
    });
    $('search-results').addEventListener('click', (e) => {
      const btn = e.target.closest('.search-hit');
      if (!btn) return;
      const card = state.cards.find((c) => c.item_code === btn.dataset.code);
      if (!card) return;
      $('modal-search').classList.add('hidden');
      state.mode = card.deck;
      state.showCompleted = (card.deck === 'Consignment' || card.deck === 'done_phil');
      state.openedFromGrid = false;
      state.pinnedCode = card.item_code;
      renderCard();
    });

    $('btn-open-admin').addEventListener('click', () => {
      $('modal-more').classList.add('hidden');
      if (state.auth && state.auth.role === 'admin') {
        openAdminScreen();
      } else {
        localStorage.removeItem(STORAGE_KEY);
        state.auth = null;
        state.user = null;
        showScreen('login-screen');
        $('login-error').textContent = 'Enter Admin PIN to open settings';
      }
    });
    $('btn-logout').addEventListener('click', () => {
      $('modal-more').classList.add('hidden');
      localStorage.removeItem(STORAGE_KEY);
      state.auth = null;
      state.user = null;
      showScreen('login-screen');
    });

    // Admin User & PIN Management
    $('btn-add-user').addEventListener('click', () => openUserModal(null));
    $('usr-role').addEventListener('change', () => {
      $('usr-shared-wrap').classList.toggle('hidden', $('usr-role').value !== 'warehouse');
    });
    $('usr-pin').addEventListener('input', () => {
      $('usr-pin').value = $('usr-pin').value.replace(/\D/g, '').slice(0, 4);
    });
    $('btn-gen-pin').addEventListener('click', () => {
      const taken = new Set(['1234', ...(state.adminUsers || []).map((u) => String(u.pin))]);
      let pin = '';
      for (let i = 0; i < 200; i++) {
        const cand = String(Math.floor(1000 + Math.random() * 9000));
        if (!taken.has(cand) && !/^(\d)\1{3}$/.test(cand)) { pin = cand; break; }
      }
      if (pin) $('usr-pin').value = pin;
    });
    $('btn-save-user').addEventListener('click', async () => {
      const errEl = $('usr-form-err');
      errEl.classList.add('hidden');
      errEl.textContent = '';
      try {
        const res = await apiPost('admin_user_save', {
          id: Number($('usr-id').value || 0),
          name: $('usr-name').value.trim(),
          role: $('usr-role').value,
          pin: $('usr-pin').value.trim(),
          is_shared: $('usr-shared').checked,
          rotate_token: $('usr-rotate').checked,
        });
        syncSelfSession(res.saved_user);
        state.adminUsers = res.users || [];
        renderAdminUsers();
        $('modal-user').classList.add('hidden');
        showToast(`Saved ${res.saved_user.name} (PIN ${res.saved_user.pin})`);
      } catch (e) {
        errEl.textContent = e.message || 'Could not save user';
        errEl.classList.remove('hidden');
      }
    });
    $('btn-delete-user').addEventListener('click', async () => {
      const id = Number($('usr-id').value || 0);
      const u = (state.adminUsers || []).find((x) => Number(x.id) === id);
      if (!u) return;
      if (!window.confirm(`Delete user "${u.name}" (PIN ${u.pin})? Past logs stay intact.`)) return;
      try {
        const res = await apiPost('admin_user_toggle', { id, op: 'delete' });
        state.adminUsers = res.users || [];
        renderAdminUsers();
        $('modal-user').classList.add('hidden');
        showToast(`Deleted ${u.name}`);
      } catch (e) {
        $('usr-form-err').textContent = e.message || 'Could not delete user';
        $('usr-form-err').classList.remove('hidden');
      }
    });
    $('admin-users-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-uact]');
      if (!btn) return;
      const uid = Number(btn.dataset.uid || 0);
      const act = btn.dataset.uact;
      const u = (state.adminUsers || []).find((x) => Number(x.id) === uid);
      if (!u) return;
      if (act === 'copy_link') {
        copyText(buildUserMagicUrl(u), `Copied link for ${u.name}`);
      } else if (act === 'copy_invite') {
        const label = u.role === 'warehouse' ? 'Warehouse Photo Queue' : 'Inventory Review';
        copyText(`PT Medical ${label} (${u.name}): ${buildUserMagicUrl(u)} — or enter PIN: ${u.pin}`, `Copied invite + PIN for ${u.name}`);
      } else if (act === 'edit') {
        openUserModal(u);
      } else if (act === 'rotate') {
        try {
          const res = await apiPost('admin_user_toggle', { id: uid, op: 'rotate_token' });
          syncSelfSession(res.saved_user);
          state.adminUsers = res.users || [];
          renderAdminUsers();
          copyText(buildUserMagicUrl(res.saved_user), `Rotated & copied link for ${u.name}`);
        } catch (err) {
          showToast(err.message);
        }
      } else if (act === 'toggle') {
        try {
          const res = await apiPost('admin_user_toggle', { id: uid, op: 'toggle_active' });
          state.adminUsers = res.users || [];
          renderAdminUsers();
          showToast(`${res.saved_user && Number(res.saved_user.active) === 1 ? 'Enabled' : 'Disabled'} ${u.name}`);
        } catch (err) {
          showToast(err.message);
        }
      }
    });

    // Admin events
    $('btn-admin-back').addEventListener('click', () => {
      showScreen('app-screen');
      renderCard();
    });
    $('btn-export-csv').addEventListener('click', async (e) => {
      if (window.PT_CLOUD_API && window.PT_CLOUD_API.enabled) {
        e.preventDefault();
        try {
          await window.PT_CLOUD_API.downloadExport('csv', authQuery());
        } catch (err) {
          showToast(err.message);
        }
      }
    });
    $('btn-export-json').addEventListener('click', async (e) => {
      if (window.PT_CLOUD_API && window.PT_CLOUD_API.enabled) {
        e.preventDefault();
        try {
          await window.PT_CLOUD_API.downloadExport('json', authQuery());
        } catch (err) {
          showToast(err.message);
        }
      }
    });
    $('btn-save-admin').addEventListener('click', async () => {
      try {
        await apiPost('admin_settings', {
          blitz_mode: $('adm-blitz').checked,
          ghl_webhook_url: $('adm-webhook').value.trim(),
          base_url: $('adm-baseurl').value.trim(),
        });
        showToast('Settings saved');
      } catch (e) {
        showToast(e.message);
      }
    });
    $('btn-test-nudge').addEventListener('click', async () => {
      try {
        const res = await apiGet('cron_nudge', 'dry_run=1&force_window=morning');
        $('adm-test-out').textContent = JSON.stringify(res, null, 2);
        $('adm-test-out').classList.remove('hidden');
      } catch (e) {
        showToast(e.message);
      }
    });
    $('btn-copy-magic').addEventListener('click', () => {
      const philU = (state.adminUsers || []).find((u) => u.role === 'phil' && Number(u.active) === 1);
      if (!philU) { showToast('No active Phil user found'); return; }
      copyText(buildUserMagicUrl(philU), `Copied ${philU.name} magic link!`);
    });
    $('btn-copy-wh').addEventListener('click', () => {
      const whU = (state.adminUsers || []).find((u) => u.role === 'warehouse' && Number(u.active) === 1 && Number(u.is_shared) === 1)
        || (state.adminUsers || []).find((u) => u.role === 'warehouse' && Number(u.active) === 1);
      if (!whU) { showToast('No active Warehouse user found'); return; }
      copyText(buildUserMagicUrl(whU), `Copied ${whU.name} link!`);
    });

    window.addEventListener('online', flushQueue);
  }

  async function boot() {
    loadStoredQueue();
    wireEvents();
    const params = new URLSearchParams(window.location.search);
    const urlW = params.get('w');
    const urlK = params.get('k');
    if (urlW) {
      state.auth = { type: 'w', val: urlW, role: 'warehouse' };
      try {
        const chk = await apiGet('auth_check');
        state.auth.role = chk.role;
        state.user = chk.user || null;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state.auth));
        await loadAppData();
        return;
      } catch {
        state.auth = null;
      }
    }
    if (urlK) {
      state.auth = { type: 'k', val: urlK, role: 'phil' };
      try {
        const chk = await apiGet('auth_check');
        state.auth.role = chk.role;
        state.user = chk.user || null;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state.auth));
        await loadAppData();
        return;
      } catch {
        state.auth = null;
      }
    }

    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && saved.val) {
        state.auth = saved;
        const chk = await apiGet('auth_check');
        state.auth.role = chk.role;
        state.user = chk.user || null;
        await loadAppData();
        return;
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
      state.auth = null;
    }

    showScreen('login-screen');
  }

  boot();
})();
