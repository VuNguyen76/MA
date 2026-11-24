/**
 * Mai Anh’s Green Closet - Fashion Studio
 * Tủ đồ cá nhân & Haute Lookbook Studio
 * Direct Google Drive Integration via Google Apps Script Web App
 */

'use strict';

// =============================================================================
// 1. CẤU HÌNH & HẰNG SỐ DANH MỤC
// =============================================================================
const CATS = ['Áo', 'Quần', 'Chân váy', 'Váy liền', 'Áo khoác', 'Giày dép', 'Túi xách', 'Phụ kiện'];
const SLOTS = ['Áo', 'Quần', 'Chân váy', 'Váy liền', 'Áo khoác', 'Giày dép', 'Túi xách', 'Phụ kiện'];

// Tọa độ & độ nghiêng tương đối chuẩn flat-lay lookbook
const POSITIONS = {
  'Áo': { x: 27, y: 8, w: 45, h: 35, r: -3, z: 4 },
  'Áo khoác': { x: 13, y: 7, w: 53, h: 45, r: -8, z: 5 },
  'Quần': { x: 32, y: 43, w: 44, h: 45, r: 3, z: 3 },
  'Chân váy': { x: 30, y: 43, w: 46, h: 37, r: 5, z: 3 },
  'Váy liền': { x: 25, y: 12, w: 52, h: 72, r: -2, z: 4 },
  'Giày dép': { x: 2, y: 68, w: 32, h: 25, r: -12, z: 6 },
  'Túi xách': { x: 67, y: 25, w: 31, h: 29, r: 9, z: 7 },
  'Phụ kiện': { x: 65, y: 6, w: 31, h: 20, r: 8, z: 8 }
};

// =============================================================================
// 2. BIẾN TRẠNG THÁI ỨNG DỤNG (STATE)
// =============================================================================
const $ = (id) => document.getElementById(id);

let db = null;
let items = [];
let looks = [];
let selectedIds = [];
let board = {};
let activeFilter = 'Tất cả';
let editId = null;
let photos = [];
let busy = false;
let processing = false;
let photoGeneration = 0;
let restoreRequested = false;

// Google Apps Script Web App URL
const DEFAULT_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyQFKwenRbCRCRNVscF2q-B8WYiWvB_PmXoeJ6nwkUjrS0O7UmMMi-_xV08t_r6WMB83w/exec';
const APPS_SCRIPT_KEY = 'mai-anh-apps-script-url-v2';
let appsScriptUrl = localStorage.getItem(APPS_SCRIPT_KEY) || DEFAULT_SCRIPT_URL;

// =============================================================================
// 3. TIỆN ÍCH DÙNG CHUNG (UTILITIES)
// =============================================================================
const uuid = () => crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2);

function toast(msg) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

async function fileToDataURL(f) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(f);
  });
}

// Nén ảnh thông minh bảo toàn độ nét trang phục
async function shrink(f) {
  const data = await fileToDataURL(f);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, 1200 / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const ctx = canvas.getContext('2d');
      if (f.type !== 'image/png') {
        ctx.fillStyle = '#FAF8F5';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL(f.type === 'image/png' ? 'image/png' : 'image/jpeg', f.type === 'image/png' ? undefined : 0.85));
    };
    image.onerror = () => reject(new Error('Ảnh không đọc được'));
    image.src = data;
  });
}

// =============================================================================
// 4. CLOUDFLARE R2 DIRECT UPLOAD (KHÔNG FALLBACK GOOGLE DRIVE)
// =============================================================================
async function uploadToR2(base64Data, fileName, folder = 'maianh-closet/items') {
  const response = await fetch('/api/r2-upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base64Data, fileName, folder })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.url) {
    throw new Error(data.error || `Lỗi R2 HTTP ${response.status}`);
  }
  return { id: data.id, url: data.url };
}

async function uploadImageToCloud(base64Data, fileName, folder = 'maianh-closet/items') {
  return await uploadToR2(base64Data, fileName, folder);
}

// =============================================================================
// 5. CƠ SỞ DỮ LIỆU INDEXEDDB (OFFLINE-FIRST)
// =============================================================================
function tx(store, mode = 'readonly') {
  return db.transaction(store, mode).objectStore(store);
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('my-little-closet-v1', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('items')) {
        d.createObjectStore('items', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('looks')) {
        d.createObjectStore('looks', { keyPath: 'id' });
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function persist(store, obj) {
  obj.updated = Date.now();
  await req(tx(store, 'readwrite').put(obj));
}

async function remove(store, id) {
  await req(tx(store, 'readwrite').delete(id));
}

async function reload() {
  items = await req(tx('items').getAll());
  looks = await req(tx('looks').getAll());
  items.sort((a, b) => b.added - a.added);
  looks.sort((a, b) => b.added - a.added);
  render();
}

// =============================================================================
// 5B. ĐỒNG BỘ CLOUD DATABASE ĐA THIẾT BỊ QUA GOOGLE DRIVE
// =============================================================================
let isSyncing = false;

async function fetchCloudDatabase(showToast = false) {
  if (!appsScriptUrl || isSyncing) return false;
  isSyncing = true;
  const statusEl = $('syncStatusText');
  const iconEl = $('syncIcon');
  if (statusEl) statusEl.textContent = 'Đang tải...';
  if (iconEl) iconEl.classList.add('fa-spin');

  try {
    const response = await fetch(appsScriptUrl, { method: 'GET' });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      console.warn('Apps Script chưa có doGet:', text.slice(0, 100));
      return false;
    }

    if (data && Array.isArray(data.items)) {
      const localItems = await req(tx('items').getAll());
      const localByFileId = new Map(localItems.filter(x => x.driveFileId).map(x => [x.driveFileId, x]));
      const deletedSet = new Set(Array.isArray(data.deletedFileIds) ? data.deletedFileIds : []);

      // Gom toàn bộ thao tác vào 1 transaction IndexedDB duy nhất để tránh khựng UI
      await new Promise((resolve, reject) => {
        const batchTx = db.transaction(['items', 'looks'], 'readwrite');
        const itemStore = batchTx.objectStore('items');
        const lookStore = batchTx.objectStore('looks');

        for (const local of localItems) {
          if (local.driveFileId && deletedSet.has(local.driveFileId)) {
            itemStore.delete(local.id);
          }
        }
        for (const item of data.items) {
          if (item.driveFileId && deletedSet.has(item.driveFileId)) continue;
          const existingByFile = item.driveFileId ? localByFileId.get(item.driveFileId) : null;
          if (existingByFile && existingByFile.id !== item.id) {
            if (item.id.startsWith('drive-')) continue;
            itemStore.delete(existingByFile.id);
          }
          itemStore.put(item);
        }
        if (Array.isArray(data.looks)) {
          for (const look of data.looks) {
            lookStore.put(look);
          }
        }
        batchTx.oncomplete = () => resolve();
        batchTx.onerror = () => reject(batchTx.error);
      });

      await reload();
      if (statusEl) statusEl.textContent = 'Đã đồng bộ';
      if (showToast) toast(`Đã đồng bộ ${data.items.length} món đồ`);
      return true;
    }
  } catch (err) {
    console.warn('Không thể tải đồng bộ:', err.message);
    if (showToast) toast('Chưa đồng bộ được: ' + err.message);
  } finally {
    isSyncing = false;
    if (iconEl) iconEl.classList.remove('fa-spin');
    setTimeout(() => {
      if (statusEl && (statusEl.textContent === 'Đã đồng bộ' || statusEl.textContent === 'Đang tải...')) {
        statusEl.textContent = '';
      }
    }, 2500);
  }
  return false;
}

async function syncDatabaseToDrive(showToast = false, deletedFileIds = []) {
  if (!appsScriptUrl) return;
  const statusEl = $('syncStatusText');
  const iconEl = $('syncIcon');
  if (statusEl) statusEl.textContent = 'Đang lưu...';
  if (iconEl) iconEl.classList.add('fa-spin');

  try {
    const allItems = await req(tx('items').getAll());
    const allLooks = await req(tx('looks').getAll());

    const lightItems = allItems.map(item => {
      const copy = { ...item };
      if (copy.original && copy.original.startsWith('data:image/')) {
        delete copy.original;
      }
      return copy;
    });

    const payload = {
      action: 'sync_db',
      items: lightItems,
      looks: allLooks,
      deletedFileIds
    };

    const res = await fetch(appsScriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    let result = {};
    try {
      result = JSON.parse(text);
    } catch (_) {}

    if (result.status === 'success') {
      if (statusEl) statusEl.textContent = 'Đã đồng bộ';
      if (showToast) toast('Đã đồng bộ dữ liệu tủ đồ');
    }
  } catch (err) {
    console.warn('Lỗi đồng bộ dữ liệu:', err.message);
  } finally {
    if (iconEl) iconEl.classList.remove('fa-spin');
    setTimeout(() => {
      if (statusEl && statusEl.textContent === 'Đã đồng bộ') {
        statusEl.textContent = '';
      }
    }, 2500);
  }
}

// =============================================================================
// 6. RENDER GIAO DIỆN HAUTE ATELIER
// =============================================================================
function render() {
  if ($('count')) $('count').textContent = items.length + ' món đồ';
  $('savedCount').textContent = looks.length ? `(${looks.length})` : '';
  renderFilters();
  renderCloset();
  renderBoard();
  renderLooks();
}

function renderFilters() {
  const container = $('filters');
  container.innerHTML = ['Tất cả', ...CATS].map(c => `
    <button type="button" class="chip ${activeFilter === c ? 'active' : ''}" data-cat="${esc(c)}">
      ${esc(c)}${c === 'Tất cả' ? ' (' + items.length + ')' : ''}
    </button>
  `).join('');

  container.querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      activeFilter = b.dataset.cat;
      renderFilters();
      renderCloset();
    };
  });
}

function renderCloset() {
  const q = $('search').value.trim().toLocaleLowerCase();
  const seasonVal = $('seasonFilter')?.value || '';
  const shown = items.filter(i => {
    const matchCat = activeFilter === 'Tất cả' || i.cat === activeFilter;
    const matchSeason = !seasonVal || i.season === seasonVal;
    const matchSearch = [i.name, i.color, i.note, i.season].join(' ').toLocaleLowerCase().includes(q);
    return matchCat && matchSeason && matchSearch;
  });

  const closetEl = $('closet');
  if (!shown.length) {
    closetEl.innerHTML = `<div class="empty"><i class="fa-solid fa-shirt empty-ico" aria-hidden="true"></i>Tủ đồ chưa có món nào ở mục này<br>Nhấn “Thêm đồ” để bắt đầu nhé.</div>`;
    return;
  }

  const pickedSet = new Set(selectedIds);

  closetEl.innerHTML = shown.map(i => {
    const isSelected = pickedSet.has(i.id);
    return `
    <div class="item ${isSelected ? 'item-selected' : ''}" draggable="true" data-id="${esc(i.id)}">
      <div class="item-media">
        <img src="${i.photo}" alt="${esc(i.name)}" loading="lazy" decoding="async">
        ${isSelected ? '<span class="item-picked-badge" title="Đang trong outfit"><i class="fa-solid fa-check" aria-hidden="true"></i></span>' : ''}
        <div class="item-hover-actions">
          <button type="button" class="item-fab" title="Xem toàn màn hình" aria-label="Xem toàn màn hình" data-zoom="${esc(i.id)}"><i class="fa-solid fa-magnifying-glass-plus" aria-hidden="true"></i></button>
          <button type="button" class="item-fab" title="Sửa" aria-label="Sửa" data-edit="${esc(i.id)}"><i class="fa-regular fa-pen-to-square" aria-hidden="true"></i></button>
          <button type="button" class="item-fab item-fab-danger" title="Xóa" aria-label="Xóa" data-delete="${esc(i.id)}"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button>
        </div>
      </div>
      <div class="info">
        <div class="name" title="${esc(i.name)}">${esc(i.name)}</div>
        <div class="sub">${esc(i.cat)}${i.color ? ' · ' + esc(i.color) : ''}</div>
      </div>
    </div>`;
  }).join('');

  closetEl.querySelectorAll('.item').forEach(el => {
    el.ondragstart = e => e.dataTransfer.setData('text/plain', el.dataset.id);
    el.onclick = e => {
      if (e.target.closest('[data-zoom]') || e.target.closest('[data-edit]') || e.target.closest('[data-delete]')) return;
      toggleItemSelection(el.dataset.id);
    };
  });

  closetEl.querySelectorAll('[data-zoom]').forEach(el => {
    el.onclick = e => {
      e.stopPropagation();
      const it = items.find(x => x.id === el.dataset.zoom);
      if (it) openLightbox(it.photo, it.name);
    };
  });

  closetEl.querySelectorAll('[data-edit]').forEach(el => {
    el.onclick = e => {
      e.stopPropagation();
      openModal(el.dataset.edit);
    };
  });

  closetEl.querySelectorAll('[data-delete]').forEach(el => {
    el.onclick = e => {
      e.stopPropagation();
      deleteItem(el.dataset.delete);
    };
  });
}

// Đồng bộ selectedIds -> board (tương thích ngược)
function syncLegacyBoard() {
  board = {};
  for (const id of selectedIds) {
    const it = items.find(x => x.id === id);
    if (it && !board[it.cat]) board[it.cat] = id;
  }
}

// Quy tắc giới hạn vật lý thông minh theo vùng cơ thể (Phụ kiện rời & Túi xách: KHÔNG GIỚI HẠN)
function toggleItemSelection(id, forceAdd = false) {
  const it = items.find(x => x.id === id);
  if (!it) return;

  const idx = selectedIds.indexOf(id);
  if (idx !== -1 && !forceAdd) {
    selectedIds.splice(idx, 1);
    syncLegacyBoard();
    renderBoard();
    renderCloset();
    return;
  }
  if (idx !== -1) return;

  const prof = classifyGarmentProfile(it);

  if (prof.zone === 'LOWER' || prof.zone === 'DRESS') {
    // Mỗi bộ chỉ mặc tối đa 1 Quần / Chân váy / Váy liền ở thân dưới
    selectedIds = selectedIds.filter(eid => {
      const e = items.find(x => x.id === eid);
      if (!e) return false;
      const ep = classifyGarmentProfile(e);
      return ep.zone !== 'LOWER' && ep.zone !== 'DRESS';
    });
  } else if (prof.zone === 'FOOT') {
    selectedIds = selectedIds.filter(eid => {
      const e = items.find(x => x.id === eid);
      return e && classifyGarmentProfile(e).zone !== 'FOOT';
    });
  } else if (prof.zone === 'HEAD') {
    // Phân biệt Nón/Mũ (CROWN) và Kính (EYE): không đội 2 cái nón chồng lên 1 đầu
    const isEye = /kính|glass/.test((it.name || '').toLowerCase());
    selectedIds = selectedIds.filter(eid => {
      const e = items.find(x => x.id === eid);
      if (!e) return false;
      const ep = classifyGarmentProfile(e);
      if (ep.zone !== 'HEAD') return true;
      const eIsEye = /kính|glass/.test((e.name || '').toLowerCase());
      return eIsEye !== isEye;
    });
  } else if (prof.role === 'CORSET_BELT' || prof.role === 'FAKE_COLLAR' || prof.role === 'OUTERWEAR') {
    // Tối đa 1 Đai corset/thắt lưng, 1 Cổ áo giả, 1 Áo khoác ngoài
    selectedIds = selectedIds.filter(eid => {
      const e = items.find(x => x.id === eid);
      return e && classifyGarmentProfile(e).role !== prof.role;
    });
  } else if (prof.zone === 'UPPER') {
    // Các món áo thân trên (kể cả Cúp ngực, Áo xuyên thấu để trong mục Phụ kiện): tối đa 2 món để ghép lớp hoặc tách 2 Style
    const existingUpperTops = selectedIds.filter(eid => {
      const e = items.find(x => x.id === eid);
      if (!e) return false;
      const ep = classifyGarmentProfile(e);
      return ep.zone === 'UPPER' && ep.role !== 'OUTERWEAR';
    });
    if (existingUpperTops.length >= 2) {
      selectedIds = selectedIds.filter(eid => eid !== existingUpperTops[0]);
    }
  }

  selectedIds.push(id);
  syncLegacyBoard();
  renderBoard();
  renderCloset();
}

function addToBoard(id) {
  toggleItemSelection(id, true);
}

function renderBoard() {
  // Đảm bảo nếu selectedIds rỗng nhưng board cũ có dữ liệu thì đồng bộ sang
  if (!selectedIds.length && Object.keys(board).length) {
    selectedIds = Object.values(board).filter(Boolean);
  }
  selectedIds = selectedIds.filter(id => items.some(x => x.id === id));
  syncLegacyBoard();
  updateMixCount();
  mixOutfit(true);
}

function getLookPieces(l) {
  if (Array.isArray(l.items) && l.items.length) {
    return l.items
      .map(id => items.find(i => i.id === id))
      .filter(Boolean)
      .map(it => ({ slot: it.cat, it }));
  }
  if (l.board && typeof l.board === 'object') {
    return Object.entries(l.board)
      .map(([slot, id]) => ({ slot, it: items.find(i => i.id === id) }))
      .filter(x => x.it);
  }
  return [];
}

function renderLooks() {
  const grid = $('savedGrid');
  if (!looks.length) {
    grid.innerHTML = '<div class="empty"><i class="fa-regular fa-bookmark empty-ico" aria-hidden="true"></i>Chưa có outfit nào trong Bộ sưu tập<br>Qua tab Tủ đồ để phối set đầu tiên nhé.</div>';
    return;
  }

  grid.innerHTML = looks.map(l => {
    const selected = getLookPieces(l);

    return `
      <article class="lookcard">
        ${l.aiPhoto ? `<div class="look-ai-wrap"><img class="look-ai-thumb" src="${l.aiPhoto}" alt="${esc(l.name)}" loading="lazy"><button type="button" class="item-fab look-zoom-btn" title="Xem toàn màn hình" aria-label="Xem toàn màn hình" data-zoom-look="${esc(l.id)}"><i class="fa-solid fa-magnifying-glass-plus" aria-hidden="true"></i></button></div>` : ''}
        <div class="lookpics">
          ${selected.slice(0, 8).map(x => `
            <img src="${x.it.photo}" title="${esc(x.slot)}: ${esc(x.it.name)}" alt="${esc(x.it.name)}">
          `).join('') || (l.aiPhoto ? '' : '<div class="placeholder">Chưa có ảnh</div>')}
        </div>
        <div class="lookname">${esc(l.name)}</div>
        <div class="muted">${selected.length} món · ${new Date(l.added).toLocaleDateString('vi-VN')}</div>
        <div class="group-row" style="margin-top:10px">
          <button type="button" class="btn-subtle" data-load="${esc(l.id)}">Mở để phối lại</button>
          <button type="button" class="btn-subtle" data-del-look="${esc(l.id)}">Xóa</button>
        </div>
      </article>
    `;
  }).join('');

  grid.querySelectorAll('[data-zoom-look]').forEach(b => {
    b.onclick = () => {
      const l = looks.find(x => x.id === b.dataset.zoomLook);
      if (l?.aiPhoto) openLightbox(l.aiPhoto, l.name);
    };
  });

  grid.querySelectorAll('[data-load]').forEach(b => {
    b.onclick = () => {
      const l = looks.find(x => x.id === b.dataset.load);
      if (!l) return;
      selectedIds = Array.isArray(l.items) && l.items.length
        ? [...l.items]
        : Object.values(l.board || {}).filter(Boolean);
      syncLegacyBoard();
      $('lookName').value = l.name;
      switchTab('studio');
      renderBoard();
      renderCloset();
      toast('Đã mở outfit để phối lại');
    };
  });

  grid.querySelectorAll('[data-del-look]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('Xóa outfit này khỏi Bộ sưu tập?')) return;
      await remove('looks', b.dataset.delLook);
      await reload();
      syncDatabaseToDrive();
    };
  });
}

function switchTab(tab) {
  document.querySelectorAll('.tab-pill, .tab').forEach(x => {
    x.classList.toggle('active', x.dataset.tab === tab);
  });
  $('studio').classList.toggle('hidden', tab !== 'studio');
  $('saved').classList.toggle('hidden', tab !== 'saved');
}

async function deleteItem(id) {
  const i = items.find(x => x.id === id);
  if (!i) return;
  if (!confirm(`Xóa “${i.name}” khỏi tủ đồ? Món này cũng sẽ không hiện trong các outfit đã lưu.`)) return;
  await remove('items', id);
  selectedIds = selectedIds.filter(x => x !== id);
  syncLegacyBoard();
  await reload();
  syncDatabaseToDrive(false, i.driveFileId ? [i.driveFileId] : []);
}

// =============================================================================
// 7. LOOKBOOK STUDIO & TƯ DUY THỜI TRANG (FASHION STYLING ENGINE)
// =============================================================================
function getItemZone(it) {
  const name = (it.name || '').toLowerCase();
  const note = (it.note || '').toLowerCase();
  if (it.cat === 'Váy liền' || /\b(đầm|váy liền|jumpsuit)\b/.test(name)) return 'DRESS';
  if (/nón|mũ|cap|hat|beanie|beret|kính|kẹp|băng đô|cài tóc/.test(name)) return 'HEAD';
  if (/cổ áo|cổ giả|khăn|choàng cổ|vòng cổ|dây chuyền|choker|cà vạt|nơ cổ/.test(name)) return 'NECK';
  if (/đai|corset|thắt lưng|belt/.test(name)) return 'WAIST';
  if (
    it.cat === 'Áo' ||
    it.cat === 'Áo khoác' ||
    /áo|sơ mi|cúp ngực|croptop|crop top|babydoll|peplum|sweater|cardigan|blazer|gile|vest|hoodie|ba lỗ|2s|hai dây/.test(name)
  ) {
    return 'UPPER';
  }
  if (it.cat === 'Quần' || it.cat === 'Chân váy' || /quần|chân váy|jeans|short|kaki|váy xếp ly/.test(name)) return 'LOWER';
  if (it.cat === 'Giày dép' || /giày|dép|boot|sandal|sneaker|cao gót/.test(name)) return 'FOOT';
  if (it.cat === 'Túi xách' || /túi|balo|ví|clutch|tote/.test(name)) return 'SIDE';
  if (/phối với áo sơ mi/.test(note)) return 'UPPER';
  return 'SIDE';
}

// Phân tích cấu trúc vật lý món đồ (Physical Topology: độ dài vạt áo, kiểu đóng/mở cúc, cổ áo, độ xuyên thấu)
function classifyGarmentProfile(it) {
  const name = (it.name || '').toLowerCase();
  const note = (it.note || '').toLowerCase();
  const season = (it.season || '').toLowerCase();
  const zone = getItemZone(it);

  let role = zone;
  if (zone === 'UPPER') {
    if (/cúp ngực|2s|hai dây|ba lỗ|quây|bra|tank/.test(name)) {
      role = 'BASE_TOP';
    } else if (/xuyên thấu|lưới|mesh|ren/.test(name)) {
      role = 'SHEER_LAYER';
    } else if (it.cat === 'Áo khoác' || /cardigan|blazer|sweater|khoác|choàng|len nâu nút vàng/.test(name)) {
      role = 'OUTERWEAR';
    } else if (/sơ mi|caro|bóng chày/.test(name)) {
      role = 'BUTTON_SHIRT';
    } else if (/peplum|đắp chéo|siết eo|thắt eo|babydoll|trễ vai|cột nơ|kiểu/.test(name)) {
      role = 'STATEMENT_TOP';
    } else {
      role = 'CORE_TOP';
    }
  } else if (zone === 'NECK' && /cổ áo|cổ giả/.test(name)) {
    role = 'FAKE_COLLAR';
  } else if (zone === 'WAIST') {
    role = 'CORSET_BELT';
  }

  let hemType = 'STRAIGHT_UNTUCKED';
  if (/cúp ngực|croptop|crop top/.test(name)) {
    hemType = 'CROPPED';
  } else if (/peplum|babydoll|đắp chéo|cột nơ|thắt eo|siết eo/.test(name)) {
    hemType = 'SHAPED_WAIST_FLARE';
  } else if (/sweater|oversize|giấu quần|đấu tuyển|blazer|cardigan|khoác|choàng/.test(name + ' ' + note)) {
    hemType = 'LONG_HIP';
  }

  let closureType = 'CLOSED_PULLOVER';
  if (/blazer|khoác|choàng|cardigan/.test(name)) {
    closureType = 'OPEN_OUTER';
  } else if (/sơ mi|caro|bóng chày|nút/.test(name) && !/cột nơ|tiểu thư|kiểu|đắp chéo|peplum/.test(name)) {
    closureType = 'FRONT_BUTTON_PLACKET';
  }

  const isTransparent = role === 'SHEER_LAYER';
  const hasCollar = /sơ mi|có cổ|golf|polo|bóng chày|blazer|cổ áo/.test(name);
  const isStraplessBandeau = /cúp ngực|quây/.test(name);

  let volume = 'REGULAR';
  const cleanNote = note.replace(/ko nên mặc với quần rộng|không nên mặc với quần rộng/g, '');
  if (/ống rộng|oversize|rộng|babydoll|giấu quần|túi hộp|voan/.test(name + ' ' + cleanNote)) {
    volume = 'OVERSIZED';
  } else if (/ôm|cúp ngực|2s|ba lỗ|siết eo|thắt eo|cạp cao|corset|eo nhỏ|croptop|crop top/.test(name + ' ' + cleanNote)) {
    volume = 'FITTED';
  }

  let directive = '';
  if (/đóng thùng|chặt thùng/.test(note) && hemType !== 'SHAPED_WAIST_FLARE' && hemType !== 'CROPPED') {
    directive = 'FULL_TUCK';
  } else if (/giấu quần/.test(note)) {
    directive = 'BOYFRIEND_UNTUCKED';
  } else if (/thắt eo|siết eo|tôn dáng/.test(name + ' ' + note)) {
    directive = 'WAIST_CINCH';
  } else if (/phối với áo sơ mi/.test(note)) {
    directive = 'INNER_BANDEAU_LAYER';
  } else if (/tập gym|đồ tập|đi tập/.test(name + ' ' + note + ' ' + season)) {
    directive = 'ATHLEISURE';
  }

  return { zone, role, hemType, closureType, isTransparent, hasCollar, isStraplessBandeau, volume, directive };
}

function selectedPieces() {
  if (!selectedIds.length && Object.keys(board).length) {
    selectedIds = Object.values(board).filter(Boolean);
  }
  return selectedIds
    .map(id => items.find(x => x.id === id))
    .filter(Boolean)
    .map(it => {
      const profile = classifyGarmentProfile(it);
      return { cat: it.cat, zone: profile.zone, profile, it };
    });
}

function updateMixCount() {
  const x = $('mixCount');
  if (!x) return;
  const sel = selectedPieces();
  if (!sel.length) {
    x.textContent = '0 món';
    return;
  }
  const plan = buildFashionStylingPlan(sel);
  x.textContent = plan.mode === 'DUAL_STYLE' ? `${sel.length} món · 2 Style` : `${sel.length} món`;
}

// Bố cục Flat-lay tự nhiên như bản cũ + Vật lý tự đẩy nhau (Force-Directed Repulsion) để không bao giờ đè lên nhau và luôn nằm trọn trong Canvas
function computeCanvasLayout(pieces) {
  const N = pieces.length;
  if (N === 1) {
    return [{ ...pieces[0], p: { x: 19, y: 14, w: 62, h: 70, r: -2, z: 4 } }];
  }

  // Các điểm neo flat-lay tự nhiên quanh bộ đồ chính (trên-phải, trên-trái, dưới-phải, giữa-trái, giữa-phải, dưới-trái)
  const accAnchors = [
    { x: 67, y: 7, w: 29, h: 25, r: 7, z: 8 },
    { x: 3, y: 8, w: 29, h: 25, r: -6, z: 8 },
    { x: 67, y: 67, w: 29, h: 25, r: -5, z: 8 },
    { x: 3, y: 38, w: 28, h: 24, r: 5, z: 8 },
    { x: 68, y: 37, w: 28, h: 24, r: 8, z: 8 },
    { x: 3, y: 68, w: 28, h: 24, r: -8, z: 9 }
  ];

  // Giữ kích thước lớn tự nhiên như bản cũ
  const scale = N <= 4 ? 1 : (N === 5 ? 0.94 : Math.max(0.80, 2.0 / Math.sqrt(N)));

  let accIdx = 0;
  let upperIdx = 0;
  const totalUppers = pieces.filter(p => p.zone === 'UPPER').length;
  const nodes = pieces.map((piece, idx) => {
    let base = { ...(POSITIONS[piece.cat] || POSITIONS['Phụ kiện']) };

    if (piece.zone === 'UPPER') {
      if (totalUppers === 1) {
        base = { x: 27, y: 7, w: 45, h: 36, r: -3, z: 4 };
      } else if (totalUppers === 2) {
        // Khi có 2 món thân trên: đặt cân xứng Trái (Style 01) - Phải (Style 02) phía trên quần/váy
        base = upperIdx === 0
          ? { x: 6, y: 8, w: 41, h: 35, r: -4, z: 4 }
          : { x: 53, y: 8, w: 41, h: 35, r: 4, z: 5 };
      } else {
        const slots = [
          { x: 5, y: 8, w: 36, h: 32, r: -5, z: 4 },
          { x: 33, y: 7, w: 38, h: 33, r: -2, z: 5 },
          { x: 60, y: 9, w: 35, h: 32, r: 5, z: 5 }
        ];
        base = slots[upperIdx % slots.length];
      }
      upperIdx++;
    } else if (piece.zone === 'LOWER') {
      base = { x: 28, y: 48, w: 44, h: 44, r: 3, z: 3 };
    } else if (piece.zone === 'DRESS') {
      base = { x: 25, y: 12, w: 50, h: 70, r: -2, z: 4 };
    } else if (piece.cat === 'Túi xách') {
      base = { x: 66, y: 36, w: 29, h: 27, r: 8, z: 7 };
    } else if (piece.zone !== 'FOOT') {
      base = { ...accAnchors[accIdx % accAnchors.length] };
      accIdx++;
    }

    const w = base.w * scale;
    const h = base.h * scale;
    const cx = base.x + base.w / 2;
    const cy = base.y + base.h / 2;

    return {
      ...piece,
      cx,
      cy,
      anchorX: cx,
      anchorY: cy,
      w,
      h,
      r: base.r,
      z: base.z || (idx + 3)
    };
  });

  // Lực đẩy đàn hồi 2D: không cho đè lên nhau, luôn có padding và nằm trọn trong Canvas
  const PAD = 2.0;
  const MIN_X = 2;
  const MAX_X = 98;
  const MIN_Y = 7;
  const MAX_Y = 96;

  for (let iter = 0; iter < 90; iter++) {
    let maxOverlap = 0;

    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const reqDx = (a.w + b.w) / 2 + PAD;
        const reqDy = (a.h + b.h) / 2 + PAD;
        let dx = b.cx - a.cx;
        let dy = b.cy - a.cy;

        if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) {
          dx = (j - i) * 1.5;
          dy = 1.5;
        }

        const ox = reqDx - Math.abs(dx);
        const oy = reqDy - Math.abs(dy);

        if (ox > 0 && oy > 0) {
          maxOverlap = Math.max(maxOverlap, Math.min(ox, oy));
          const sx = dx >= 0 ? 1 : -1;
          const sy = dy >= 0 ? 1 : -1;
          if (ox < oy) {
            const push = ox / 2 + 0.15;
            a.cx -= push * sx;
            b.cx += push * sx;
            // Đẩy nhẹ trục phụ để thoát kẹt góc tường
            a.cy -= 0.25 * sy;
            b.cy += 0.25 * sy;
          } else {
            const push = oy / 2 + 0.15;
            a.cy -= push * sy;
            b.cy += push * sy;
            a.cx -= 0.25 * sx;
            b.cx += 0.25 * sx;
          }
        }
      }
    }

    // Chỉ kéo nhẹ về điểm neo ở 25 vòng đầu, sau đó ưu tiên triệt tiêu va chạm 100%
    const pull = iter < 25 ? 0.04 : 0;
    for (const n of nodes) {
      if (pull > 0) {
        n.cx += (n.anchorX - n.cx) * pull;
        n.cy += (n.anchorY - n.cy) * pull;
      }
      n.cx = Math.max(MIN_X + n.w / 2, Math.min(MAX_X - n.w / 2, n.cx));
      n.cy = Math.max(MIN_Y + n.h / 2, Math.min(MAX_Y - n.h / 2, n.cy));
    }

    // Chỉ thu nhẹ 1.5% khi thật sự còn 2 món đang chạm nhau mà hết chỗ trống
    if (iter >= 20 && iter % 8 === 0 && maxOverlap > 0.4) {
      for (const n of nodes) {
        n.w = Math.max(18, n.w * 0.982);
        n.h = Math.max(16, n.h * 0.982);
      }
    }
  }

  return nodes.map(n => ({
    cat: n.cat,
    zone: n.zone,
    it: n.it,
    p: {
      x: +(n.cx - n.w / 2).toFixed(2),
      y: +(n.cy - n.h / 2).toFixed(2),
      w: +n.w.toFixed(2),
      h: +n.h.toFixed(2),
      r: n.r,
      z: n.z
    }
  }));
}

function mixOutfit(silent = false) {
  const selected = selectedPieces();
  const canvas = $('mixCanvas');
  updateMixCount();

  if (canvas && !canvas.dataset.dropBound) {
    canvas.dataset.dropBound = '1';
    canvas.ondragover = e => e.preventDefault();
    canvas.ondrop = e => {
      e.preventDefault();
      const id = e.dataTransfer.getData('text/plain');
      if (id) toggleItemSelection(id, true);
    };
  }

  if (!selected.length) {
    canvas.innerHTML = '';
    canvas.classList.add('empty');
    if (!silent) toast('Hãy chọn ít nhất một món trước nha');
    return;
  }

  canvas.classList.remove('empty');
  const active = computeCanvasLayout(selected);

  canvas.innerHTML = active.map(({ it, p }, i) => `
    <figure class="mixpiece" data-piece-id="${esc(it.id)}" style="left:${p.x}%;top:${p.y}%;width:${p.w}%;height:${p.h}%;z-index:${p.z};transform:rotate(${p.r}deg);animation-delay:${i * 55}ms">
      <button type="button" class="mixpiece-remove" data-remove-id="${esc(it.id)}" title="Bỏ món này" aria-label="Bỏ món này"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      <img src="${it.photo}" alt="${esc(it.name)}" draggable="false">
      <figcaption title="${esc(it.name)}">${esc(it.name)}</figcaption>
    </figure>
  `).join('');

  canvas.querySelectorAll('[data-remove-id]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      toggleItemSelection(btn.dataset.removeId);
    };
  });

  if (!silent) toast('Đã dàn set ' + selected.length + ' món lên Lookbook');
}

// =============================================================================
// 8. TÁCH NỀN SIÊU TỐC & AI (BACKGROUND REMOVAL ENGINE)
// =============================================================================

// Thuật toán tách nền tức thì bằng Canvas Flood-Fill (< 30ms)
async function fastRemoveBackground(dataUrl, tolerance = 38) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const w = img.width;
      const h = img.height;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);

      const imgData = ctx.getImageData(0, 0, w, h);
      const data = imgData.data;

      // Lấy mẫu màu nền đại diện từ các góc và viền
      const samples = [
        [0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1],
        [Math.floor(w / 4), 0], [Math.floor((3 * w) / 4), 0],
        [Math.floor(w / 4), h - 1], [Math.floor((3 * w) / 4), h - 1],
        [0, Math.floor(h / 4)], [0, Math.floor((3 * h) / 4)],
        [w - 1, Math.floor(h / 4)], [w - 1, Math.floor((3 * h) / 4)]
      ];

      let rSum = 0, gSum = 0, bSum = 0;
      for (const [sx, sy] of samples) {
        const idx = (sy * w + sx) * 4;
        rSum += data[idx];
        gSum += data[idx + 1];
        bSum += data[idx + 2];
      }
      const bgR = rSum / samples.length;
      const bgG = gSum / samples.length;
      const bgB = bSum / samples.length;

      // Khoảng cách màu Euclide
      function colorDiff(idx) {
        const dr = data[idx] - bgR;
        const dg = data[idx + 1] - bgG;
        const db = data[idx + 2] - bgB;
        return Math.sqrt(dr * dr + dg * dg + db * db);
      }

      const totalPixels = w * h;
      const visited = new Uint8Array(totalPixels);
      const queue = new Int32Array(totalPixels);
      let head = 0;
      let tail = 0;

      // Đưa các pixel biên có màu tương đồng vào hàng đợi BFS
      for (let x = 0; x < w; x++) {
        const topIdx = x;
        if (colorDiff(topIdx * 4) <= tolerance) {
          visited[topIdx] = 1;
          queue[tail++] = topIdx;
        }
        const btmIdx = (h - 1) * w + x;
        if (colorDiff(btmIdx * 4) <= tolerance) {
          visited[btmIdx] = 1;
          queue[tail++] = btmIdx;
        }
      }

      for (let y = 0; y < h; y++) {
        const leftIdx = y * w;
        if (!visited[leftIdx] && colorDiff(leftIdx * 4) <= tolerance) {
          visited[leftIdx] = 1;
          queue[tail++] = leftIdx;
        }
        const rightIdx = y * w + (w - 1);
        if (!visited[rightIdx] && colorDiff(rightIdx * 4) <= tolerance) {
          visited[rightIdx] = 1;
          queue[tail++] = rightIdx;
        }
      }

      // Lan truyền Flood-fill chỉ trên vùng nền bên ngoài (bảo vệ áo ở giữa)
      while (head < tail) {
        const p = queue[head++];
        const px = p % w;
        const py = (p / w) | 0;

        if (px > 0) {
          const np = p - 1;
          if (!visited[np] && colorDiff(np * 4) <= tolerance) {
            visited[np] = 1;
            queue[tail++] = np;
          }
        }
        if (px < w - 1) {
          const np = p + 1;
          if (!visited[np] && colorDiff(np * 4) <= tolerance) {
            visited[np] = 1;
            queue[tail++] = np;
          }
        }
        if (py > 0) {
          const np = p - w;
          if (!visited[np] && colorDiff(np * 4) <= tolerance) {
            visited[np] = 1;
            queue[tail++] = np;
          }
        }
        if (py < h - 1) {
          const np = p + w;
          if (!visited[np] && colorDiff(np * 4) <= tolerance) {
            visited[np] = 1;
            queue[tail++] = np;
          }
        }
      }

      // Xóa trong suốt nền
      for (let i = 0; i < totalPixels; i++) {
        if (visited[i]) {
          data[i * 4 + 3] = 0;
        }
      }

      ctx.putImageData(imgData, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('Lỗi xử lý ảnh'));
    img.src = dataUrl;
  });
}

let removeBackgroundFn = null;
async function getRemover() {
  if (removeBackgroundFn) return removeBackgroundFn;
  try {
    // Load từ package npm đã cài đặt
    const mod = await import('@imgly/background-removal');
    if (typeof mod.removeBackground === 'function') {
      removeBackgroundFn = mod.removeBackground;
      return removeBackgroundFn;
    }
  } catch (localErr) {
    // Fallback qua CDN nếu môi trường không hỗ trợ bundle cục bộ
  }
  const mod = await import('https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm');
  if (typeof mod.removeBackground !== 'function') throw new Error('Không khởi tạo được AI tách nền');
  removeBackgroundFn = mod.removeBackground;
  return removeBackgroundFn;
}

function getBgMode() {
  const checked = document.querySelector('input[name="bgMode"]:checked');
  return checked ? checked.value : 'fast';
}

function updatePreviews() {
  $('previews').innerHTML = photos.map((p, i) => `
    <div class="preview-tile">
      <img src="${p.photo}" alt="Xem trước ảnh ${i + 1}">
      <small>${p.removed ? 'Đã tách nền' : 'Ảnh gốc'}</small>
    </div>
  `).join('');
  if ($('aiAutoTagBtn')) {
    $('aiAutoTagBtn').classList.toggle('hidden', photos.length === 0);
  }
}

let rawUploadedFiles = [];

async function processPhotos(files, mode = getBgMode()) {
  const generation = ++photoGeneration;
  photos = [];
  processing = true;
  $('submitItem').disabled = true;
  $('previews').textContent = 'Đang xử lý ảnh...';

  try {
    for (let j = 0; j < files.length; j++) {
      if (generation !== photoGeneration) return;
      const f = files[j];
      const isFile = f instanceof File || f instanceof Blob;
      if (!isFile && typeof f !== 'string') continue;

      $('bgStatus').textContent = `Đang xử lý ${j + 1}/${files.length}...`;
      const original = typeof f === 'string' ? f : await shrink(f);
      let photo = original;
      let removed = false;

      if (mode === 'fast') {
        const t0 = performance.now();
        photo = await fastRemoveBackground(original, 38);
        removed = true;
        const dt = Math.round(performance.now() - t0);
        $('bgStatus').textContent = `Đã tách nền siêu tốc trong ${dt}ms.`;
      } else if (mode === 'ai') {
        try {
          $('bgStatus').textContent = `AI đang tách nền ảnh ${j + 1}/${files.length}...`;
          const removeBg = await getRemover();
          const inputBlob = await (await fetch(original)).blob();
          const outputBlob = await removeBg(inputBlob, {
            model: 'isnet_quint8',
            output: { format: 'image/png', type: 'foreground' }
          });
          photo = await shrink(new File([outputBlob], 'tach-nen.png', { type: 'image/png' }));
          removed = true;
        } catch (err) {
          console.warn('AI tách nền lỗi, fallback về tách nhanh:', err);
          photo = await fastRemoveBackground(original, 38);
          removed = true;
        }
      }

      if (generation !== photoGeneration) return;
      photos.push({ photo, original, removed });
      updatePreviews();
    }

    if (generation === photoGeneration) {
      if (mode === 'none') {
        $('bgStatus').textContent = 'Đang giữ ảnh gốc nguyên bản.';
      } else {
        $('bgStatus').textContent = `Đã xử lý ${photos.length} ảnh. Sẵn sàng cất vào tủ.`;
      }
    }
  } catch (err) {
    $('bgStatus').textContent = 'Không đọc được ảnh: ' + err.message;
  } finally {
    if (generation === photoGeneration) {
      processing = false;
      $('submitItem').disabled = false;
    }
  }
}

// =============================================================================
// 9. HỘP THOẠI THÊM & SỬA TRANG PHỤC (MODAL)
// =============================================================================
function openModal(id = null) {
  editId = id;
  photoGeneration++;
  photos = [];
  rawUploadedFiles = [];
  processing = false;
  restoreRequested = false;
  $('photoInput').value = '';
  $('previews').innerHTML = '';
  $('bgStatus').textContent = '';
  $('submitItem').disabled = false;

  // Đặt lại radio mode về fast
  const fastRadio = document.querySelector('input[name="bgMode"][value="fast"]');
  if (fastRadio) fastRadio.checked = true;
  document.querySelectorAll('.mode-option').forEach(el => el.classList.remove('active'));
  $('modeFastOpt')?.classList.add('active');

  const i = items.find(x => x.id === id);
  $('restoreOriginal').classList.toggle('hidden', !i?.original);
  $('dialogTitle').textContent = id ? 'Chỉnh sửa trang phục' : 'Thêm đồ vào tủ';
  $('itemName').value = i?.name || '';
  $('itemCat').value = i?.cat || 'Áo';
  $('itemColor').value = i?.color || '';
  $('itemSeason').value = i?.season || '';
  $('itemNote').value = i?.note || '';
  $('dialogBack').classList.remove('hidden');
}

function closeModal() {
  photoGeneration++;
  processing = false;
  $('dialogBack').classList.add('hidden');
  if ($('aiAutoTagBtn')) $('aiAutoTagBtn').classList.add('hidden');
}

$('photoInput').onchange = async e => {
  rawUploadedFiles = [...e.target.files].slice(0, 40);
  if (rawUploadedFiles.length) {
    await processPhotos(rawUploadedFiles, getBgMode());
  }
};

// Đổi chế độ tách nền tức thì trên các ảnh đã chọn
document.querySelectorAll('input[name="bgMode"]').forEach(radio => {
  radio.onchange = () => {
    document.querySelectorAll('.mode-option').forEach(el => el.classList.remove('active'));
    radio.closest('.mode-option')?.classList.add('active');

    if (rawUploadedFiles.length && !processing) {
      processPhotos(rawUploadedFiles, radio.value);
    } else if (photos.length && !processing) {
      const originals = photos.map(p => p.original);
      processPhotos(originals, radio.value);
    }
  };
});

$('restoreOriginal').onclick = () => {
  restoreRequested = true;
  $('bgStatus').textContent = 'Sẽ sử dụng ảnh gốc sau khi bấm Lưu.';
};

// Cất vào tủ: Tự động tải ảnh lên Google Drive qua Apps Script Web App
$('submitItem').onclick = async () => {
  if (busy || processing) return;

  const name = $('itemName').value.trim();
  const cat = $('itemCat').value;
  const color = $('itemColor').value.trim();
  const season = $('itemSeason').value;
  const note = $('itemNote').value.trim();

  if (!editId && !photos.length) return toast('Hãy chọn ảnh trang phục trước nhé!');

  busy = true;
  $('submitItem').disabled = true;

  try {
    if (editId) {
      const old = items.find(x => x.id === editId);
      let imgFields = {};

      if (photos.length) {
        let finalPhoto = photos[0].photo;
        let driveFileId = old.driveFileId || null;

        if (finalPhoto.startsWith('data:image/')) {
          toast('Đang tải ảnh cập nhật lên Cloudflare R2...');
          try {
            const cloudRes = await uploadImageToCloud(finalPhoto, `${name || old.name || 'item'}-${Date.now()}.png`, 'maianh-closet/items');
            finalPhoto = cloudRes.url;
            driveFileId = cloudRes.id;
          } catch (uploadErr) {
            console.warn('Lỗi tải ảnh lên cloud, giữ ảnh cục bộ:', uploadErr.message);
          }
        }

        imgFields = {
          photo: finalPhoto,
          original: photos[0].original,
          removed: photos[0].removed,
          driveFileId
        };
      } else if (restoreRequested && old.original) {
        imgFields = { photo: old.original, original: old.original, removed: false };
      }

      await persist('items', {
        ...old,
        name: name || old.name,
        cat,
        color,
        season,
        note,
        ...imgFields
      });
    } else {
      for (let j = 0; j < photos.length; j++) {
        const p = photos[j];
        let finalPhoto = p.photo;
        let driveFileId = null;

        if (p.photo.startsWith('data:image/')) {
          toast(`Đang lưu ảnh ${j + 1}/${photos.length} lên Cloudflare R2...`);
          try {
            const cloudRes = await uploadImageToCloud(p.photo, `${name || cat}-${Date.now()}-${j}.png`, 'maianh-closet/items');
            finalPhoto = cloudRes.url;
            driveFileId = cloudRes.id;
          } catch (uploadErr) {
            console.warn('Lỗi tải ảnh lên cloud, lưu cục bộ:', uploadErr.message);
          }
        }

        await persist('items', {
          id: uuid(),
          name: name ? (photos.length > 1 ? `${name} ${j + 1}` : name) : `${cat} ${items.length + j + 1}`,
          cat,
          color,
          season,
          note,
          photo: finalPhoto,
          original: p.original,
          removed: p.removed,
          driveFileId,
          added: Date.now() + j
        });
      }
    }

    closeModal();
    await reload();
    toast('Đã cất trang phục vào tủ');
    syncDatabaseToDrive();
  } catch (e) {
    alert('Không lưu được đồ: ' + e.message);
  } finally {
    busy = false;
    $('submitItem').disabled = false;
  }
};

$('saveLook').onclick = async () => {
  const validPieces = selectedPieces();
  if (!validPieces.length) return toast('Thêm ít nhất một món vào outfit trước nha');

  const name = $('lookName').value.trim() || `Outfit ${new Date().toLocaleDateString('vi-VN')}`;
  syncLegacyBoard();
  const look = {
    id: uuid(),
    name,
    items: validPieces.map(x => x.it.id),
    board: { ...board },
    added: Date.now()
  };

  try {
    await persist('looks', look);
    await reload();
    toast('Đã lưu outfit vào Bộ sưu tập');
    syncDatabaseToDrive();
  } catch (e) {
    alert('Lưu outfit thất bại: ' + e.message);
  }
};

$('clearBoard').onclick = () => {
  selectedIds = [];
  board = {};
  $('lookName').value = '';
  $('aiNote')?.classList.add('hidden');
  $('aiResultBox')?.classList.add('hidden');
  renderBoard();
  renderCloset();
};

$('search').oninput = renderCloset;
if ($('seasonFilter')) $('seasonFilter').onchange = renderCloset;
$('uploadBtn').onclick = () => openModal();
$('closeDialog').onclick = closeModal;
$('cancelDialog').onclick = closeModal;
$('dialogBack').onclick = e => {
  if (e.target === $('dialogBack')) closeModal();
};

// =============================================================================
// 10. ĐIỀU HƯỚNG & ĐỒNG BỘ
// =============================================================================
function openLightbox(src, caption = '') {
  if (!src || !$('lightbox')) return;
  $('lightboxImg').src = src;
  $('lightboxImg').alt = caption;
  $('lightboxCaption').textContent = caption;
  $('lightbox').classList.remove('hidden');
}

function closeLightbox() {
  $('lightbox')?.classList.add('hidden');
}

if ($('closeLightbox')) $('closeLightbox').onclick = closeLightbox;
if ($('lightbox')) {
  $('lightbox').onclick = e => {
    if (e.target === $('lightbox')) closeLightbox();
  };
}

if ($('zoomAiImg')) {
  $('zoomAiImg').onclick = () => {
    if (lastAiDataUrl) openLightbox(lastAiDataUrl, $('lookName')?.value.trim() || 'Ảnh phối đồ AI');
  };
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeModal();
    closeLightbox();
  }
});

document.querySelectorAll('.tab-pill, .tab').forEach(b => {
  b.onclick = () => switchTab(b.dataset.tab);
});

if ($('syncCloudBtn')) {
  $('syncCloudBtn').onclick = async () => {
    toast('Đang đồng bộ...');
    await fetchCloudDatabase(true);
    await syncDatabaseToDrive();
  };
}

// =============================================================================
// 11. MUSE AI STUDIO (GỌI QUA PROXY /api/muse)
// =============================================================================
let lastAiDataUrl = '';

function parseJsonBlock(rawText) {
  const cleaned = String(rawText || '').replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : cleaned);
}

async function callMuseApi(payload) {
  const res = await fetch('/api/muse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const raw = await res.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch (_) {}
  if (!res.ok) {
    throw new Error(data?.error || (raw ? raw.slice(0, 140) : `HTTP ${res.status}`));
  }
  if (!data) throw new Error('Phản hồi server không hợp lệ');
  return data;
}

async function callMuseChat(prompt, imageUrl = null) {
  const content = imageUrl
    ? [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: imageUrl } }
      ]
    : prompt;
  const data = await callMuseApi({ action: 'chat', messages: [{ role: 'user', content }] });
  return data.text || '';
}

async function callMuseImage(prompt, images = [], onTick = null) {
  const start = await callMuseApi({ action: 'image_start', prompt, images });
  const taskId = start.taskId;
  if (!taskId) throw new Error('Không khởi tạo được tiến trình tạo ảnh');

  const t0 = Date.now();
  for (let i = 0; i < 45; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const elapsed = Math.round((Date.now() - t0) / 1000);
    if (onTick) onTick(elapsed);

    const poll = await callMuseApi({ action: 'image_poll', taskId });
    if (poll.status === 'failed') {
      throw new Error(poll.error || 'Tạo ảnh thất bại');
    }
    if (poll.status === 'succeeded' && poll.dataUrl) {
      return poll.dataUrl;
    }
  }
  throw new Error('Quá thời gian chờ tạo ảnh (135s), hãy thử lại');
}

// 11A. AI tự điền tên, loại, màu, dịp mặc khi thêm đồ mới
if ($('aiAutoTagBtn')) {
  $('aiAutoTagBtn').onclick = async () => {
    if (!photos.length) return toast('Hãy chọn ảnh món đồ trước nhé');
    const btn = $('aiAutoTagBtn');
    const oldHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i><span>Đang phân tích ảnh...</span>';
    try {
      const prompt = `Bạn là stylist thời trang. Nhìn ảnh trang phục này và trả về DUY NHẤT 1 JSON hợp lệ (không giải thích thêm):
{"name":"Tên ngắn gọn tiếng Việt (VD: Áo sơ mi lụa trắng)","cat":"Chọn đúng 1 trong: ${CATS.join(', ')}","color":"Màu chủ đạo tiếng Việt","season":"Chọn đúng 1 trong: Đi làm, Đi chơi dạo phố, Dự tiệc, Du lịch, Đi tập, Mặc ở nhà","note":"Gợi ý phối đồ ngắn dưới 12 từ"}`;
      const raw = await callMuseChat(prompt, photos[0].original || photos[0].photo);
      const info = parseJsonBlock(raw);
      if (info.name) $('itemName').value = String(info.name).slice(0, 100);
      if (info.cat && CATS.includes(info.cat)) $('itemCat').value = info.cat;
      if (info.color) $('itemColor').value = String(info.color).slice(0, 50);
      if (info.season) {
        const opts = [...$('itemSeason').options].map(o => o.value || o.text);
        if (opts.includes(info.season)) $('itemSeason').value = info.season;
      }
      if (info.note) $('itemNote').value = String(info.note).slice(0, 250);
      toast('AI đã tự điền thông tin món đồ');
    } catch (err) {
      toast('AI chưa phân tích được: ' + (err?.message || err));
    } finally {
      btn.disabled = false;
      btn.innerHTML = oldHtml;
    }
  };
}

// 11B. Hệ thống Ma-nơ-canh Chuẩn Số Đo & Gu Tối Giản Hàn–Nhật (Petite Asian Boutique Dressmaker Form: Vai 35cm - Eo 58cm tỉ lệ 0.62 - Lưng:Chân 1:2.3 - Cổ kem phẳng - Chân gỗ sồi sáng 3 chạc)
function drawCoutureMannequinFigure(ctx, cx, scale, opts = {}) {
  ctx.save();
  ctx.translate(cx, opts.topY || 0);
  ctx.scale(scale, scale);

  const hasHeadCrown = !!opts.hasHeadCrown;

  // 1. Bóng tiếp đất cực nhẹ dưới 3 chân gỗ
  const floorShadow = ctx.createRadialGradient(0, 998, 8, 0, 998, 135);
  floorShadow.addColorStop(0, 'rgba(60, 50, 38, 0.10)');
  floorShadow.addColorStop(1, 'rgba(60, 50, 38, 0)');
  ctx.fillStyle = floorShadow;
  ctx.beginPath();
  ctx.ellipse(0, 998, 135, 14, 0, 0, Math.PI * 2);
  ctx.fill();

  // 2. Trụ giữa thanh mảnh & Chân đế 3 chạc gỗ sồi sáng uốn cong ở đáy (đúng chuẩn ảnh mẫu 8% đáy khung hình)
  const oakGrad = ctx.createLinearGradient(-90, 900, 90, 1005);
  oakGrad.addColorStop(0, '#AE8B63');
  oakGrad.addColorStop(0.48, '#CBB08C');
  oakGrad.addColorStop(1, '#9A7852');

  // Trụ dọc gỗ sáng mảnh (chỉ đỡ dưới đáy thân ma-nơ-canh)
  ctx.fillStyle = oakGrad;
  ctx.fillRect(-10, 510, 20, 488);

  // Khối trụ tiện gỗ nơi giao 3 chạc chân
  ctx.beginPath();
  ctx.roundRect(-22, 926, 44, 46, 8);
  ctx.fill();

  // Hai chạc gỗ sồi uốn cong chữ S mềm mại sang hai bên
  ctx.strokeStyle = oakGrad;
  ctx.lineWidth = 22;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-12, 934);
  ctx.bezierCurveTo(-36, 950, -52, 988, -96, 1006);
  ctx.moveTo(12, 934);
  ctx.bezierCurveTo(36, 950, 52, 988, 96, 1006);
  ctx.stroke();

  // 3. Chất liệu vải nỉ/linen trắng kem mịn đồng tông nền (#ECE9E2 -> #DBD6CC), KHÔNG có chóp gỗ nâu trên cổ, KHÔNG có tay khớp gỗ
  const fabricGrad = ctx.createLinearGradient(-130, 30, 130, 520);
  fabricGrad.addColorStop(0, '#F1EFEA');
  fabricGrad.addColorStop(0.45, '#E8E4DC');
  fabricGrad.addColorStop(0.85, '#DCD7CD');
  fabricGrad.addColorStop(1, '#CFC9BE');

  if (hasHeadCrown) {
    // Khi có Nón/Kính: Vòm đầu điêu khắc không mặt bọc cùng chất vải kem sáng (không dùng gỗ nâu)
    ctx.fillStyle = fabricGrad;
    ctx.fillRect(-30, 56, 60, 54);
    ctx.beginPath();
    ctx.ellipse(0, 26, 42, 50, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Cổ trụ bọc vải kem cắt phẳng đỉnh đầu tối giản (đúng chuẩn ảnh mẫu khách ưng nhất)
    ctx.fillStyle = fabricGrad;
    ctx.beginPath();
    ctx.moveTo(-31, 32);
    ctx.quadraticCurveTo(-33, 76, -46, 98);
    ctx.lineTo(46, 98);
    ctx.quadraticCurveTo(33, 76, 31, 32);
    ctx.closePath();
    ctx.fill();

    // Mặt cắt phẳng đỉnh cổ màu kem sáng
    ctx.fillStyle = '#E3DFD6';
    ctx.beginPath();
    ctx.ellipse(0, 32, 31, 7, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // 4. Thân Ma-nơ-canh Petite Asian Hourglass (Vai nhỏ 256px - Eo siêu thon 158px tại y=356 [tỉ lệ 0.62] - Hông chữ A mềm 222px)
  ctx.fillStyle = fabricGrad;
  ctx.beginPath();
  ctx.moveTo(-44, 94); // Chân cổ trái
  ctx.quadraticCurveTo(-76, 114, -124, 128); // Cầu vai trái thanh mảnh
  ctx.quadraticCurveTo(-132, 134, -128, 162); // Đầu vai trái không lộ khớp gỗ
  ctx.bezierCurveTo(-118, 222, -104, 268, -79, 356); // Ngực thu gọn sắc nét về eo nhỏ 58-60cm (y=356)
  ctx.bezierCurveTo(-74, 384, -108, 430, -111, 486); // Eo mở êm ra hông chữ A (222px)
  ctx.quadraticCurveTo(-106, 522, -46, 526); // Đáy thân ma-nơ-canh trái
  ctx.lineTo(46, 526); // Đáy thân ma-nơ-canh phải
  ctx.quadraticCurveTo(106, 522, 111, 486); // Hông phải
  ctx.bezierCurveTo(108, 430, 74, 384, 79, 356); // Eo phải (158px -> Waist/Shoulder = 0.617)
  ctx.bezierCurveTo(104, 268, 118, 222, 128, 162); // Ngực lên đầu vai phải
  ctx.quadraticCurveTo(132, 134, 124, 128); // Cầu vai phải
  ctx.quadraticCurveTo(76, 114, 44, 94); // Chân cổ phải
  ctx.closePath();
  ctx.fill();

  // Đường chỉ may chìm cực mảnh định vị đúng điểm thắt eo cao 1 : 2.3 (y=356)
  ctx.strokeStyle = 'rgba(145, 138, 126, 0.22)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, 96);
  ctx.lineTo(0, 524);
  ctx.moveTo(-72, 132);
  ctx.bezierCurveTo(-60, 220, -46, 356, -56, 520);
  ctx.moveTo(72, 132);
  ctx.bezierCurveTo(60, 220, 46, 356, 56, 520);
  ctx.moveTo(-79, 356);
  ctx.quadraticCurveTo(0, 363, 79, 356);
  ctx.stroke();

  if (opts.badge) {
    ctx.fillStyle = '#3C4A3E';
    ctx.font = '600 15px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(opts.badge, 0, 1030);
  }

  ctx.restore();
}

function getAdaptiveMannequinDataUrl(selected, stylingPlan) {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 1024;
  const ctx = c.getContext('2d');

  // Phông studio trắng ngà phẳng mịn #F5F5F3 chuẩn Lookbook Hàn–Nhật (không viền tối vignette)
  const bg = ctx.createLinearGradient(0, 0, 0, 1024);
  bg.addColorStop(0, '#F6F6F4');
  bg.addColorStop(1, '#F2F1EE');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 1024, 1024);

  const hasHeadCrown = selected.some(s => s.zone === 'HEAD');

  if (stylingPlan?.mode === 'DUAL_STYLE') {
    drawCoutureMannequinFigure(ctx, 290, 0.88, {
      topY: 56,
      hasHeadCrown,
      badge: 'STYLE 01'
    });
    drawCoutureMannequinFigure(ctx, 734, 0.88, {
      topY: 56,
      hasHeadCrown,
      badge: 'STYLE 02'
    });
  } else {
    drawCoutureMannequinFigure(ctx, 512, 0.99, {
      topY: 4,
      hasHeadCrown
    });
  }

  return c.toDataURL('image/png');
}

// Mô tả quy tắc ghép vạt áo vật lý + giữ trọn tỉ lệ eo thon 0.62 & lưng ngắn chân dài 1 : 2.3
function describePhysicalHemline(topPiece, lowerPiece) {
  const { role, hemType, directive } = topPiece.profile;
  const topName = `"${topPiece.it.name}"`;
  const lowerName = lowerPiece ? `"${lowerPiece.it.name}"` : null;

  if (hemType === 'CROPPED') {
    return `${topName} is a cropped/bandeau piece: preserve 100% of its exact photographed cropped length, tapering sleekly to the ultra-slim 58cm high waist so its bottom edge meets cleanly right at the top edge of ${lowerName || 'the high waist'} (30% upper torso : 70% lower body proportion).`;
  }
  if (hemType === 'SHAPED_WAIST_FLARE') {
    return `${topName} has a structured peplum/wrap/babydoll hem: cinch snugly at the narrow 58cm high waist (0.62 waist-to-shoulder ratio) while keeping its flared/shaped hem and ties on the exterior overlapping ${lowerName ? `the top waistband of ${lowerName}` : 'the hip'} — NEVER stuff the flared hem inside pants.`;
  }
  if ((directive === 'FULL_TUCK' || role === 'BASE_TOP') && lowerName) {
    return `${topName}: fit sleekly to the petite bust and cinch cleanly into/at the 58cm high waistband of ${lowerName} to highlight the 0.62 waist-to-shoulder ratio and 1:2.3 leg-lengthening proportion.`;
  }
  return `1:1 PETITE-TAILORED UNTUCKED OVERLAP FOR ${topName}: Tailor ${topName} cleanly to the petite 35cm shoulders and slim 58cm torso while keeping it UNTUCKED in its exact photographed cut, closure, sleeve length, and bottom hemline. Its bottom hem hangs naturally outside and over ${lowerName ? `the top waistband of ${lowerName} with a clean fabric edge (do NOT stuff inside ${lowerName}, do NOT tie fake knots, do NOT roll sleeves)` : 'the slim off-white mannequin waist'}.`;
}

// Kiểm tra 2 món thân trên có thể ghép chồng vật lý trên CÙNG 1 Ma-nơ-canh mà không biến dạng & không che khuất 100% nhau hay không
function checkPhysicalStackability(u1, u2) {
  const p1 = u1.profile;
  const p2 = u2.profile;

  // 1. Một món là lớp lưới/xuyên thấu (SHEER_LAYER) + Một món là áo đặc bên trong -> Ghép 2 lớp trực tiếp trên 1 Ma-nơ-canh
  if (p1.isTransparent !== p2.isTransparent) {
    const inner = p1.isTransparent ? u2 : u1;
    const outer = p1.isTransparent ? u1 : u2;
    return {
      canStackOnOne: true,
      inner,
      outer,
      assemblyRule: `Layer z=2 (Inner Base): Fit "${inner.it.name}" sleekly onto the petite torso tapering to the narrow 58cm waist. Layer z=3 (Sheer Exterior Overlay): Layer the sheer/open-knit "${outer.it.name}" directly OVER "${inner.it.name}" in its exact 1:1 cropped silhouette — render realistic optical sheer knit transparency at the collarbones and slim hanging sleeves (allowing soft off-white studio light to pass through single-layer mesh while deepening tone over "${inner.it.name}").`
    };
  }

  // 2. Một món là Áo khoác mở vạt (Blazer, Cardigan, Áo khoác, Áo choàng) + Một món là Áo mặc trong -> Ghép 2 lớp trực tiếp trên 1 Ma-nơ-canh
  const isOpenCoat1 = p1.role === 'OUTERWEAR' && p1.closureType === 'OPEN_OUTER';
  const isOpenCoat2 = p2.role === 'OUTERWEAR' && p2.closureType === 'OPEN_OUTER';
  if (isOpenCoat1 !== isOpenCoat2) {
    const inner = isOpenCoat1 ? u2 : u1;
    const outer = isOpenCoat1 ? u1 : u2;
    return {
      canStackOnOne: true,
      inner,
      outer,
      assemblyRule: `Layer z=2 (Inner Top): Dress the petite torso in "${inner.it.name}" keeping 100% of its photographed shape. Layer z=3 (Exterior Open Outerwear): Drape "${outer.it.name}" cleanly onto the narrow 35cm shoulders OVER "${inner.it.name}" with an open front and slim natural vertical sleeves (NO visible mannequin arms or hands sticking out of cuffs).`
    };
  }

  // 3. Một món là Sweater chui đầu (CLOSED_PULLOVER OUTERWEAR) + Một món là Sơ mi có cổ (hasCollar) -> Mặc sơ mi bên trong lộ cổ áo & vạt dưới
  const isPulloverCoat1 = p1.role === 'OUTERWEAR' && p1.closureType === 'CLOSED_PULLOVER';
  const isPulloverCoat2 = p2.role === 'OUTERWEAR' && p2.closureType === 'CLOSED_PULLOVER';
  if (isPulloverCoat1 !== isPulloverCoat2) {
    const inner = isPulloverCoat1 ? u2 : u1;
    const outer = isPulloverCoat1 ? u1 : u2;
    if (inner.profile.hasCollar) {
      return {
        canStackOnOne: true,
        inner,
        outer,
        assemblyRule: `Layer z=2 (Inner Collared Shirt): Dress "${inner.it.name}" underneath. Layer z=3 (Exterior Pullover Sweater): Layer "${outer.it.name}" over the petite torso with slim natural vertical sleeves, allowing ONLY the collar of "${inner.it.name}" to peek out cleanly at the neck opening and the bottom hem of "${inner.it.name}" to peek out ~3cm below the sweater hem.`
      };
    }
  }

  return { canStackOnOne: false };
}

// Lắp ráp ngăn xếp vật lý từ lớp trong ra lớp ngoài cho 1 Ma-nơ-canh (z=1 Quần/Váy -> z=2 Áo trong -> z=3 Lớp phủ/Khoác/Đai -> z=4 Phụ kiện)
function buildMannequinPhysicalStackInstruction(label, upperItems, lowerPiece, dressPiece, footwearPiece, accessories, customLayerRule = '') {
  const steps = [];

  if (dressPiece) {
    steps.push(`Layer z=1 (Full-Body Dress): Fit "${dressPiece.it.name}" onto the petite 35cm shoulders and ultra-slim 58cm waist (0.62 waist-to-shoulder ratio), draping vertically with soft natural folds above the curved light-oak 3-legged tripod stand.`);
  } else if (lowerPiece) {
    steps.push(`Layer z=1 (High-Waisted Lower Body, 70% vertical proportion): Fit "${lowerPiece.it.name}" snugly at the narrowest 58cm high waist (0.62 waist-to-shoulder ratio), opening gently over the hip (1.39 hip-to-waist ratio) and hanging straight down with soft vertical fabric pleats/drape — NO stiff mannequin legs inside, only the curved light-oak 3-legged wooden tripod stand peeking cleanly underneath the bottom hem.`);
  } else {
    steps.push('NO LOWER GARMENT SELECTED: Leave the lower off-white fabric dressmaker hip form and slim light-oak wooden tripod stand completely BARE below the top hem. Do NOT invent or add any pants, jeans, shorts, or skirt.');
  }

  if (upperItems.length === 0 && !dressPiece) {
    steps.push('NO UPPER GARMENT SELECTED: Leave the upper matte off-white fabric dressmaker torso and flat-capped neck completely BARE above the waistband (NO mannequin arms). Do NOT invent or add any shirt or top.');
  } else if (customLayerRule) {
    steps.push(customLayerRule);
    for (const u of upperItems) {
      steps.push(describePhysicalHemline(u, lowerPiece || dressPiece));
    }
  } else {
    upperItems.forEach((u, idx) => {
      steps.push(`Layer z=${idx + 2} (Upper Body, 30% compact torso proportion): Dress "${u.it.name}" onto the petite 35cm shoulders and slim 58cm waist in its exact 1:1 photographed shape, with sleeves hanging slim and naturally filled straight down along the sides ending in clean empty cuffs (NO visible mannequin arms, NO wooden joints, NO hands). ${describePhysicalHemline(u, lowerPiece || dressPiece)}`);
    });
  }

  // Kiểm tra vật lý của Cổ áo giả (chỉ gắn vào áo không cổ) và Đai corset (luôn nằm ở lớp ngoài cùng tại eo z=4)
  const hasCollaredUpper = upperItems.some(u => u.profile.hasCollar);
  for (const acc of accessories) {
    if (acc.profile.role === 'FAKE_COLLAR') {
      if (!hasCollaredUpper && (upperItems.length > 0 || dressPiece)) {
        steps.push(`Layer z=1.5 (Inner Neckline Collar): Tuck "${acc.it.name}" inside the collarless neckline so only its crisp shirt collar points peek out naturally against the matte off-white neck.`);
      } else {
        steps.push(`Accessory "${acc.it.name}": Display neatly beside the wooden tripod base (do not stack a second collar onto an already-collared shirt).`);
      }
    } else if (acc.profile.role === 'CORSET_BELT') {
      steps.push(`Layer z=4 (Exterior Waist Cincher): Fasten "${acc.it.name}" snugly around the narrowest 58cm high waist ON THE EXTERIOR OVER the top/dress in its exact 1:1 shape.`);
    }
  }

  if (footwearPiece) {
    steps.push(`Footwear: Place "${footwearPiece.it.name}" neatly beside/in front of the curved light-oak tripod feet at the bottom.`);
  }

  return `${label}: ${steps.join(' ')}`;
}

function buildFashionStylingPlan(selected) {
  const allUppers = selected.filter(s => s.zone === 'UPPER');
  const dresses = selected.filter(s => s.zone === 'DRESS');
  const lowers = selected.filter(s => s.zone === 'LOWER');
  const footwear = selected.filter(s => s.zone === 'FOOT');
  const accessories = selected.filter(s => !['UPPER', 'LOWER', 'DRESS', 'FOOT'].includes(s.zone));

  const primaryBottom = lowers[0] || null;
  const primaryDress = dresses[0] || null;
  const primaryFoot = footwear[0] || null;

  const coats = allUppers.filter(s => s.profile.role === 'OUTERWEAR');
  const nonCoatUppers = allUppers.filter(s => s.profile.role !== 'OUTERWEAR');

  // TRƯỜNG HỢP 1: Có đúng 2 món thân trên -> Kiểm tra xem chúng có ghép chồng vật lý thành 1 bộ được không hay phải tách 2 Ma-nơ-canh
  if (allUppers.length === 2) {
    const [u1, u2] = allUppers;
    const stackCheck = checkPhysicalStackability(u1, u2);

    // Nếu 2 món thực chất là 1 lớp trong + 1 lớp ngoài tương thích vật lý (VD: Áo + Áo khoác mở, Áo + Áo lưới xuyên thấu, Sơ mi có cổ + Sweater) -> Ghép chuẩn 1:1 trên 1 Ma-nơ-canh!
    if (stackCheck.canStackOnOne) {
      const orderedUppers = [stackCheck.inner, stackCheck.outer];
      const singleInstruction = buildMannequinPhysicalStackInstruction(
        'SINGLE MANNEQUIN 1:1 PHYSICAL LAYERED ASSEMBLY',
        orderedUppers,
        primaryBottom,
        primaryDress,
        primaryFoot,
        accessories,
        stackCheck.assemblyRule
      );
      return {
        mode: 'SINGLE_STYLE',
        singleInstruction,
        accessories
      };
    }

    // Nếu là 1 Áo nền (Cúp ngực / Áo 2s / Áo ba lỗ) + 1 Áo sơ mi cài cúc trước (FRONT_BUTTON_PLACKET):
    // Tạo 2 cách ghép vật lý hợp lệ trên 2 Ma-nơ-canh mà KHÔNG làm biến dạng phom áo (không buộc vạt, không xắn tay, không nhét vào quần)
    const isBase1 = u1.profile.role === 'BASE_TOP' && u2.profile.closureType === 'FRONT_BUTTON_PLACKET';
    const isBase2 = u2.profile.role === 'BASE_TOP' && u1.profile.closureType === 'FRONT_BUTTON_PLACKET';
    if (isBase1 || isBase2) {
      const baseTop = isBase1 ? u1 : u2;
      const shirtTop = isBase1 ? u2 : u1;
      const sharedLowerAndFoot = [primaryBottom, primaryDress, primaryFoot].filter(Boolean);

      const style1Rule = `Layer z=2 (Inner Base): Fit "${baseTop.it.name}" onto the mannequin bust in its exact 1:1 shape. Layer z=3 (Exterior Open-Placket Overshirt): Wear "${shirtTop.it.name}" OVER "${baseTop.it.name}" with ONLY its front vertical button placket open so "${baseTop.it.name}" is visible in the center — preserve 100% of "${shirtTop.it.name}"'s exact sleeve length, collar, and straight UNTUCKED bottom hemline (NO waist knots, NO rolled sleeves, NO tucking).`;
      const style1Inst = buildMannequinPhysicalStackInstruction(
        'LEFT MANNEQUIN (STYLE 01 — Open-Placket Physical Layering)',
        [baseTop, shirtTop],
        primaryBottom,
        primaryDress,
        primaryFoot,
        accessories,
        style1Rule
      );

      let style2Inst = '';
      let style2Pieces = [];
      if (baseTop.profile.isStraplessBandeau) {
        // Cúp ngực không dây + Sơ mi đóng cúc: Ghép Cúp ngực ôm bên ngoài sơ mi đóng cúc (Bustier-over-Shirt 1:1)
        const style2Rule = `Layer z=2 (Inner Closed Shirt): Dress "${shirtTop.it.name}" in its exact 1:1 photographed buttoned-up shape with its untucked bottom hem hanging naturally over the waistband. Layer z=3 (Exterior Bustier Overlay): Fit the strapless bandeau "${baseTop.it.name}" cleanly around the exterior mid-bust OVER "${shirtTop.it.name}" keeping 100% of both garments' original shapes.`;
        style2Inst = buildMannequinPhysicalStackInstruction(
          'RIGHT MANNEQUIN (STYLE 02 — Exterior Bandeau-Over-Closed-Shirt Physical Assembly)',
          [shirtTop, baseTop],
          primaryBottom,
          primaryDress,
          primaryFoot,
          accessories,
          style2Rule
        );
        style2Pieces = [shirtTop, baseTop, ...sharedLowerAndFoot];
      } else {
        // Áo 2 dây / ba lỗ + Sơ mi đóng cúc: Tách riêng Sơ mi đóng cúc nguyên bản ở Style 02
        style2Inst = buildMannequinPhysicalStackInstruction(
          `RIGHT MANNEQUIN (STYLE 02 — Exact Closed "${shirtTop.it.name}" Standalone Assembly, do NOT put "${baseTop.it.name}" on Right Mannequin)`,
          [shirtTop],
          primaryBottom,
          primaryDress,
          primaryFoot,
          accessories
        );
        style2Pieces = [shirtTop, ...sharedLowerAndFoot];
      }

      return {
        mode: 'DUAL_STYLE',
        subMode: 'PHYSICAL_LAYERING_DUET',
        style1: {
          title: 'STYLE 01 (LEFT MANNEQUIN)',
          mainPieces: [baseTop, shirtTop, ...sharedLowerAndFoot],
          instruction: style1Inst
        },
        style2: {
          title: 'STYLE 02 (RIGHT MANNEQUIN)',
          mainPieces: style2Pieces,
          instruction: style2Inst
        },
        accessories
      };
    }
  }

  // TRƯỜNG HỢP 2: Có 2 Áo độc lập xung đột vật lý (VD: 2 áo sơ mi, 2 áo thun/polo, áo sơ mi + áo trễ vai/peplum/babydoll/đắp chéo, hoặc 2 áo + 1 áo khoác)
  // -> Tách thành 2 Ma-nơ-canh song song (STYLE 01 mặc Áo 1 nguyên bản, STYLE 02 mặc Áo 2 nguyên bản, giữ nguyên vạt áo phủ tự nhiên ngoài cạp quần)
  if (nonCoatUppers.length >= 2 || allUppers.length >= 2) {
    const [top1, top2] = nonCoatUppers.length >= 2 ? nonCoatUppers : allUppers;
    const sharedCoat = coats[0] && coats[0] !== top1 && coats[0] !== top2 ? coats[0] : null;
    const sharedLowerAndFoot = [primaryBottom, primaryDress, primaryFoot].filter(Boolean);

    const stack1 = sharedCoat ? [top1, sharedCoat] : [top1];
    const stack2 = sharedCoat ? [top2, sharedCoat] : [top2];

    const check1 = sharedCoat ? checkPhysicalStackability(top1, sharedCoat) : { canStackOnOne: false };
    const check2 = sharedCoat ? checkPhysicalStackability(top2, sharedCoat) : { canStackOnOne: false };

    const style1Inst = buildMannequinPhysicalStackInstruction(
      `LEFT MANNEQUIN (STYLE 01 — Physical 1:1 Assembly featuring ONLY "${top1.it.name}" on upper torso, NEVER put "${top2.it.name}" on Left Mannequin)`,
      stack1,
      primaryBottom,
      primaryDress,
      primaryFoot,
      accessories,
      check1.canStackOnOne ? check1.assemblyRule : ''
    );

    const style2Inst = buildMannequinPhysicalStackInstruction(
      `RIGHT MANNEQUIN (STYLE 02 — Physical 1:1 Assembly featuring ONLY "${top2.it.name}" on upper torso, NEVER put "${top1.it.name}" on Right Mannequin)`,
      stack2,
      primaryBottom,
      primaryDress,
      primaryFoot,
      accessories,
      check2.canStackOnOne ? check2.assemblyRule : ''
    );

    return {
      mode: 'DUAL_STYLE',
      subMode: 'CAPSULE_AB_LOOKS',
      style1: {
        title: 'STYLE 01 (LEFT MANNEQUIN — LOOK A)',
        mainPieces: [...stack1, ...sharedLowerAndFoot],
        instruction: style1Inst
      },
      style2: {
        title: 'STYLE 02 (RIGHT MANNEQUIN — LOOK B)',
        mainPieces: [...stack2, ...sharedLowerAndFoot],
        instruction: style2Inst
      },
      accessories
    };
  }

  // TRƯỜNG HỢP 3: Bộ đơn chuẩn (0 hoặc 1 món thân trên + Quần/Váy + Phụ kiện) -> Ghép vật lý 1:1 trên 1 Ma-nơ-canh
  const singleInstruction = buildMannequinPhysicalStackInstruction(
    'SINGLE MANNEQUIN 1:1 PHYSICAL GARMENT ASSEMBLY',
    allUppers,
    primaryBottom,
    primaryDress,
    primaryFoot,
    accessories
  );

  return {
    mode: 'SINGLE_STYLE',
    singleInstruction,
    accessories
  };
}

async function loadCanvasSafeImage(src) {
  if (!src) return null;
  let dataSrc = src;
  if (!src.startsWith('data:image/')) {
    try {
      const res = await callMuseApi({ action: 'proxy_img', url: src });
      if (res?.dataUrl) dataSrc = res.dataUrl;
    } catch (_) {}
  }
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = dataSrc;
  });
}

// Gom nhiều món vào 1 bảng 1024x1024 có gắn nhãn vùng đeo [#1 HEAD, #2 NECK, #3 WAIST...]
async function buildLabeledGridBoard(pieceList, boardTitle) {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 1024;
  const ctx = c.getContext('2d');

  ctx.fillStyle = '#FAF8F5';
  ctx.fillRect(0, 0, 1024, 1024);

  ctx.fillStyle = '#1A3323';
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText(boardTitle, 36, 44);

  const imgs = await Promise.all(pieceList.map(p => loadCanvasSafeImage(p.it.photo)));
  const N = pieceList.length;
  const cols = N <= 1 ? 1 : (N <= 4 ? 2 : 3);
  const rows = Math.ceil(N / cols);
  const pad = 24;
  const topY = 64;
  const cellW = (1024 - pad * (cols + 1)) / cols;
  const cellH = (1024 - topY - pad * (rows + 1)) / rows;

  pieceList.forEach((p, idx) => {
    const r = Math.floor(idx / cols);
    const col = idx % cols;
    const x = pad + col * (cellW + pad);
    const y = topY + pad + r * (cellH + pad);

    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = 'rgba(26, 51, 35, 0.16)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x, y, cellW, cellH, 16);
    ctx.fill();
    ctx.stroke();

    const img = imgs[idx];
    if (img) {
      const boxW = cellW - 24;
      const boxH = cellH - 58;
      const scale = Math.min(boxW / img.width, boxH / img.height);
      const drawW = img.width * scale;
      const drawH = img.height * scale;
      ctx.drawImage(img, x + (cellW - drawW) / 2, y + 12 + (boxH - drawH) / 2, drawW, drawH);
    }

    ctx.fillStyle = '#1A3323';
    ctx.font = 'bold 18px sans-serif';
    const label = `#${idx + 1} [${p.zone}] ${p.it.name}`.slice(0, 34);
    ctx.fillText(label, x + 14, y + cellH - 16);
  });

  return c.toDataURL('image/png');
}

// Đóng gói tối đa 4 slot ảnh cho muse-image:
// - Chế độ 2 Style: Slot 1 = Twin Mannequins (STYLE 01 & STYLE 02), Slot 2 = Bảng đồ STYLE 01, Slot 3 = Bảng đồ STYLE 02, Slot 4 = Bảng Phụ kiện chung
// - Chế độ 1 Style: Slot 1 = Adaptive Single Mannequin, Slot 2..4 = Đồ chính & Bảng Phụ kiện
async function buildAiReferenceBoards(selected, stylingPlan) {
  const mannequinBase = getAdaptiveMannequinDataUrl(selected, stylingPlan);
  const refs = [mannequinBase];

  if (stylingPlan?.mode === 'DUAL_STYLE') {
    refs.push(await buildLabeledGridBoard(stylingPlan.style1.mainPieces, 'STYLE 01 (LEFT MANNEQUIN) OUTFIT'));
    refs.push(await buildLabeledGridBoard(stylingPlan.style2.mainPieces, 'STYLE 02 (RIGHT MANNEQUIN) OUTFIT'));
    if (stylingPlan.accessories.length >= 1) {
      refs.push(await buildLabeledGridBoard(stylingPlan.accessories, 'SHARED ACCESSORIES (BOTH MANNEQUINS)'));
    }
    return refs.slice(0, 4);
  }

  const mainGarments = selected.filter(s => ['UPPER', 'DRESS', 'LOWER', 'FOOT'].includes(s.zone));
  const accessories = selected.filter(s => !['UPPER', 'DRESS', 'LOWER', 'FOOT'].includes(s.zone));

  if (selected.length <= 3) {
    for (const s of selected) {
      if (s.it.photo) refs.push(s.it.photo);
    }
    return refs;
  }

  const upperGarments = mainGarments.filter(s => s.zone === 'UPPER' || s.zone === 'DRESS');
  const lowerGarments = mainGarments.filter(s => s.zone === 'LOWER' || s.zone === 'FOOT');

  if (upperGarments.length === 1) {
    refs.push(upperGarments[0].it.photo);
  } else if (upperGarments.length > 1) {
    refs.push(await buildLabeledGridBoard(upperGarments, 'UPPER BODY & LAYERING GARMENTS'));
  }

  if (lowerGarments.length === 1) {
    refs.push(lowerGarments[0].it.photo);
  } else if (lowerGarments.length > 1) {
    refs.push(await buildLabeledGridBoard(lowerGarments, 'LOWER BODY & FOOTWEAR'));
  }

  if (accessories.length === 1 && refs.length < 4) {
    refs.push(accessories[0].it.photo);
  } else if (accessories.length >= 1) {
    refs.push(await buildLabeledGridBoard(accessories, 'ACCESSORIES & BAGS (PLACE BY [ZONE] TAG)'));
  }

  return refs.slice(0, 4);
}

if ($('aiGenerateBtn')) {
  $('aiGenerateBtn').onclick = async () => {
    const selected = selectedPieces();
    if (!selected.length) return toast('Hãy chọn ít nhất 1 món đồ trên bảng trước');

    const stylingPlan = buildFashionStylingPlan(selected);
    const isDual = stylingPlan.mode === 'DUAL_STYLE';

    const btn = $('aiGenerateBtn');
    const oldHtml = btn.innerHTML;
    const box = $('aiResultBox');
    const stage = $('aiResultStage');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>';
    box.classList.remove('hidden');
    stage.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="margin-right:8px" aria-hidden="true"></i>${
      isDual
        ? 'Đang phân tích tư duy thời trang & dựng 2 Style trên cặp Ma-nơ-canh...'
        : 'Đang phân tích tỉ lệ trang phục & chuẩn bị Ma-nơ-canh...'
    }`;

    try {
      const refImages = await buildAiReferenceBoards(selected, stylingPlan);

      const zonePlacementGuide = {
        HEAD: 'Fit naturally onto the matte off-white faceless head dome',
        NECK: 'Drape or fasten cleanly around the matte off-white mannequin neck/collarbone',
        UPPER: 'Dress onto the petite 35cm shoulders and slim 58cm waist; sleeves hang slim and naturally filled straight down along the sides with clean empty cuffs (NO visible mannequin arms or wooden joints)',
        DRESS: 'Dress full-length onto the petite torso (0.62 waist-to-shoulder ratio) draping vertically above the curved light-oak 3-legged tripod stand',
        WAIST: 'Fasten snugly around the narrowest 58cm high waist point OVER the top/dress',
        LOWER: 'Fit snugly at the 58cm high waist (30% upper torso : 70% lower body ratio) and drape straight down with natural vertical pleats/gravity above the curved light-oak 3-legged wooden tripod stand (NO mannequin legs)',
        FOOT: 'Place neatly beside the curved light-oak tripod feet at the bottom',
        SIDE: 'Hang cleanly from the shoulder strap or display neatly beside the wooden tripod base'
      };

      const normalizedBlock = selected
        .map((s, idx) => `- Item #${idx + 1} [${s.zone} — ${s.cat}]: "${s.it.name}"${s.it.color ? `, exact color: ${s.it.color}` : ''}${s.it.note ? `, stylist note: ${s.it.note}` : ''}. Placement: ${zonePlacementGuide[s.zone] || 'On mannequin'}.`)
        .join('\n');

      const prompt = isDual
        ? `Use Reference Image #1 as the EXACT Twin-Mannequin Japanese/Korean boutique studio blueprint: TWO armless headless matte off-white fabric dressmaker mannequins (flat-capped off-white fabric necks with NO brown wooden neck knobs, petite 35cm shoulders, ultra-slim 58cm high waists with 0.62 waist-to-shoulder ratio, 1:2.3 short-torso-to-long-lower-body proportion, and curved light-oak 3-legged wooden tripod stands peeking cleanly at the bottom 8% of the frame, labeled STYLE 01 on the left and STYLE 02 on the right) against a clean flat #F5F5F3 off-white studio background with soft diffused front lighting and no vignette.

Execute a strict two-stage 1:1 garment shape normalization and petite-proportioned physical z-layer assembly:

STAGE 1 — 1:1 IMMUTABLE GARMENT SHAPE & TEXTURE EXTRACTION:
Extract every item (${selected.length} items total) from the reference boards. Remove any human body, hands, hangers, or background from source photos while locking 100% of each item's exact photographed silhouette, neckline, collar, closure state, sleeve/leg length, bottom hemline contour, sheer/opaque knit texture, and color:
${normalizedBlock}

STAGE 2 — STRICT PHYSICAL Z-LAYER ASSEMBLY ON THE TWIN PETITE BOUTIQUE MANNEQUINS:
Assemble the extracted garments from Stage 1 onto the Twin Mannequins preserving the slender petite Asian hourglass silhouette (0.62 waist-to-shoulder ratio, 30% upper torso : 70% lower body):
- ${stylingPlan.style1.instruction} (Reference Image #2: STYLE 01 OUTFIT).
- ${stylingPlan.style2.instruction} (Reference Image #3: STYLE 02 OUTFIT).
${stylingPlan.accessories.length ? `- Shared Accessories: Position ${stylingPlan.accessories.map(a => `"${a.it.name}" [${a.zone}]`).join(', ')} accurately in their physical zones.` : ''}
- CRITICAL MANNEQUIN & GARMENT RULES: NO visible mannequin arms, NO wooden ball-joints, NO hands, NO mannequin legs, NO brown wooden neck cap. Sleeves hang slim and naturally filled straight down along the sides with empty cuffs; bottoms drape straight down with natural vertical folds above the curved light-oak 3-legged wooden tripod feet.`
        : `Use Reference Image #1 as the EXACT Japanese/Korean minimalist boutique dressmaker mannequin blueprint: armless headless matte off-white fabric torso with a flat minimal off-white fabric neck cap (NO brown wooden neck knob), petite narrow 35cm shoulders, ultra-cinched 58cm high waist (0.62 waist-to-shoulder width ratio), 30% upper-torso : 70% lower-body (1:2.3) vertical proportion, and a curved light-oak 3-legged wooden tripod stand peeking cleanly at the bottom 8% of the frame, against a clean flat #F5F5F3 off-white studio background with soft diffused front lighting, generous ~68% negative space, and zero dark vignette.

Execute a strict two-stage 1:1 garment shape normalization and petite-proportioned physical z-layer assembly:

STAGE 1 — 1:1 IMMUTABLE GARMENT SHAPE & TEXTURE EXTRACTION:
Extract every listed item (${selected.length} items total) from the reference images/boards. Strip away any human body, hands, hangers, or background from source photos while locking 100% of each item's exact photographed silhouette, neckline, collar, closure state, sleeve/leg length, bottom hemline contour, sheer/opaque fabric texture, and color:
${normalizedBlock}

STAGE 2 — STRICT PHYSICAL Z-LAYER ASSEMBLY ON THE PETITE BOUTIQUE MANNEQUIN:
Assemble ALL ${selected.length} normalized items from Stage 1 onto the mannequin from Reference Image #1 preserving the slender petite Asian hourglass silhouette (0.62 waist-to-shoulder ratio, 1:2.3 torso-to-lower-body ratio, ~32% total horizontal frame width):
- ${stylingPlan.singleInstruction}
- CRITICAL MANNEQUIN & GARMENT RULES: Every selected item (${selected.map(s => s.it.name).join(', ')}) must retain 100% of its original photographed shape, texture, and hemline. NO visible mannequin arms, NO wooden ball-joints, NO hands, NO mannequin legs, NO brown wooden neck knob, and NO unrequested clothing on bare mannequin zones. Sleeves hang slim and naturally filled straight down beside the waist with clean empty cuffs; bottoms drape vertically with soft natural pleats above the curved light-oak 3-legged wooden tripod base.`;

      const dataUrl = await callMuseImage(prompt, refImages, elapsed => {
        stage.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="margin-right:8px" aria-hidden="true"></i>${
          isDual
            ? `Đang chuẩn hóa ${selected.length} món & phối 2 Style song song (${elapsed}s)...`
            : `Đang chuẩn hóa ${selected.length} món & lên phom Ma-nơ-canh (${elapsed}s)...`
        }`;
      });
      lastAiDataUrl = dataUrl;
      const imgEl = document.createElement('img');
      imgEl.src = dataUrl;
      imgEl.alt = 'Ảnh phối đồ AI';
      stage.innerHTML = '';
      stage.appendChild(imgEl);
      toast(isDual ? 'Đã tạo xong 2 Style phối đồ' : 'Đã tạo xong ảnh phối đồ');
    } catch (err) {
      stage.innerHTML = '<i class="fa-solid fa-circle-exclamation" style="margin-right:6px" aria-hidden="true"></i>' + esc(err?.message || String(err));
      toast('Không tạo được ảnh: ' + (err?.message || err));
    } finally {
      btn.disabled = false;
      btn.innerHTML = oldHtml;
    }
  };
}

if ($('closeAiResult')) {
  $('closeAiResult').onclick = () => $('aiResultBox')?.classList.add('hidden');
}

if ($('downloadAiImg')) {
  $('downloadAiImg').onclick = () => {
    if (!lastAiDataUrl) return;
    const a = document.createElement('a');
    a.href = lastAiDataUrl;
    a.download = `mai-anh-lookbook-${Date.now()}.webp`;
    a.click();
    toast('Đã tải ảnh về máy');
  };
}

// Lưu ảnh AI vừa tạo trực tiếp vào Bộ sưu tập (kèm tải ảnh lên Drive + đồng bộ)
if ($('saveAiToLooks')) {
  $('saveAiToLooks').onclick = async () => {
    if (!lastAiDataUrl) return;
    const btn = $('saveAiToLooks');
    const oldHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i><span>Đang lưu...</span>';
    try {
      const validPieces = selectedPieces();
      syncLegacyBoard();
      const name = $('lookName')?.value.trim() || `Outfit ${new Date().toLocaleDateString('vi-VN')}`;

      let aiPhotoUrl = lastAiDataUrl;
      if (lastAiDataUrl.startsWith('data:image/')) {
        try {
          const cloudRes = await uploadImageToCloud(lastAiDataUrl, `Lookbook-${name}-${Date.now()}.webp`, 'maianh-closet/looks');
          if (cloudRes?.url) aiPhotoUrl = cloudRes.url;
        } catch (err) {
          console.warn('Không tải được ảnh Lookbook lên cloud, giữ cục bộ:', err.message);
        }
      }

      const look = {
        id: uuid(),
        name,
        items: validPieces.map(x => x.it.id),
        board: { ...board },
        aiPhoto: aiPhotoUrl,
        added: Date.now()
      };

      await persist('looks', look);
      await reload();
      syncDatabaseToDrive();
      toast('Đã lưu vào Bộ sưu tập');
    } catch (err) {
      toast('Lưu thất bại: ' + (err?.message || err));
    } finally {
      btn.disabled = false;
      btn.innerHTML = oldHtml;
    }
  };
}

// =============================================================================
// 12. KHỞI CHẠY ỨNG DỤNG
// =============================================================================
(async () => {
  try {
    $('itemCat').innerHTML = CATS.map(c => `<option>${c}</option>`).join('');
    db = await openDB();
    await reload();
    fetchCloudDatabase(false);
  } catch (e) {
    toast('Trình duyệt chặn lưu dữ liệu: ' + esc(e.message));
  }
})();
