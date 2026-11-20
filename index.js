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
// 4. GOOGLE DRIVE DIRECT UPLOAD QUA GOOGLE APPS SCRIPT WEB APP
// =============================================================================
async function uploadToAppsScript(base64Data, fileName) {
  if (!appsScriptUrl) throw new Error('Chưa thiết lập đường dẫn Google Apps Script');

  const payload = {
    action: 'upload',
    name: fileName || `item-${Date.now()}.png`,
    base64: base64Data,
    mimeType: 'image/png'
  };

  // Sử dụng 'text/plain' để tránh trình duyệt gửi CORS OPTIONS preflight request tới Google Apps Script
  const response = await fetch(appsScriptUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8'
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch (err) {
    if (text.includes('Sign in') || text.includes('AccountsSignInUi') || text.includes('Unauthorized')) {
      throw new Error('Apps Script đang chặn quyền truy cập. Hãy vào Apps Script ➔ Deploy ➔ Manage deployments ➔ Đổi "Who has access" thành "Anyone" nhé!');
    }
    throw new Error('Phản hồi từ Apps Script không hợp lệ: ' + text.slice(0, 120));
  }

  if (result.status === 'error') {
    throw new Error(result.message || 'Lỗi khi lưu ảnh vào Google Drive');
  }

  // Trả về URL xem ảnh công khai qua Google CDN
  const fileId = result.id || result.fileId;
  const viewUrl = result.url || (fileId ? `https://lh3.googleusercontent.com/d/${fileId}` : null);
  return { id: fileId, url: viewUrl || base64Data };
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

      for (const local of localItems) {
        if (local.driveFileId && deletedSet.has(local.driveFileId)) {
          await req(tx('items', 'readwrite').delete(local.id));
        }
      }

      for (const item of data.items) {
        if (item.driveFileId && deletedSet.has(item.driveFileId)) continue;
        const existingByFile = item.driveFileId ? localByFileId.get(item.driveFileId) : null;
        if (existingByFile && existingByFile.id !== item.id) {
          if (item.id.startsWith('drive-')) continue;
          await req(tx('items', 'readwrite').delete(existingByFile.id));
        }
        await req(tx('items', 'readwrite').put(item));
      }
      if (Array.isArray(data.looks)) {
        for (const look of data.looks) {
          await req(tx('looks', 'readwrite').put(look));
        }
      }
      await reload();
      if (statusEl) statusEl.textContent = 'Đã đồng bộ';
      if (showToast) toast(`Đã đồng bộ ${data.items.length} món đồ từ Drive`);
      return true;
    }
  } catch (err) {
    console.warn('Không thể tải từ Drive:', err.message);
    if (showToast) toast('Chưa kết nối được Drive: ' + err.message);
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
      if (statusEl) statusEl.textContent = 'Đã lưu';
      if (showToast) toast('Đã cập nhật dữ liệu tủ đồ lên Drive');
    }
  } catch (err) {
    console.warn('Lỗi lưu dữ liệu lên Drive:', err.message);
  } finally {
    if (iconEl) iconEl.classList.remove('fa-spin');
    setTimeout(() => {
      if (statusEl && statusEl.textContent === 'Đã lưu') {
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
        <img src="${i.photo}" alt="${esc(i.name)}" loading="lazy">
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

// Quy tắc giới hạn thông minh theo loại đồ (Phụ kiện & Túi xách: KHÔNG GIỚI HẠN)
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

  const bottomGroup = ['Quần', 'Chân váy', 'Váy liền'];
  if (bottomGroup.includes(it.cat)) {
    selectedIds = selectedIds.filter(eid => {
      const e = items.find(x => x.id === eid);
      return e && !bottomGroup.includes(e.cat);
    });
  } else if (it.cat === 'Giày dép' || it.cat === 'Áo khoác') {
    selectedIds = selectedIds.filter(eid => {
      const e = items.find(x => x.id === eid);
      return e && e.cat !== it.cat;
    });
  } else if (it.cat === 'Áo') {
    const existingTops = selectedIds.filter(eid => items.find(x => x.id === eid)?.cat === 'Áo');
    if (existingTops.length >= 2) {
      selectedIds = selectedIds.filter(eid => eid !== existingTops[0]);
    }
  }
  // 'Phụ kiện' & 'Túi xách' -> không giới hạn số lượng

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
// 7. LOOKBOOK STUDIO (NON-OVERLAPPING AUTO-PACKING CANVAS)
// =============================================================================
function getItemZone(it) {
  const name = (it.name || '').toLowerCase();
  if (it.cat === 'Váy liền') return 'DRESS';
  if (it.cat === 'Áo' || it.cat === 'Áo khoác') return 'UPPER';
  if (it.cat === 'Quần' || it.cat === 'Chân váy') return 'LOWER';
  if (it.cat === 'Giày dép') return 'FOOT';
  if (it.cat === 'Túi xách') return 'SIDE';
  if (/nón|mũ|kính|kẹp|băng đô|cài/.test(name)) return 'HEAD';
  if (/khăn|choàng|vòng cổ|dây chuyền|choker|cà vạt|nơ/.test(name)) return 'NECK';
  if (/đai|corset|thắt lưng|belt/.test(name)) return 'WAIST';
  return 'SIDE';
}

function selectedPieces() {
  if (!selectedIds.length && Object.keys(board).length) {
    selectedIds = Object.values(board).filter(Boolean);
  }
  return selectedIds
    .map(id => items.find(x => x.id === id))
    .filter(Boolean)
    .map(it => ({ cat: it.cat, zone: getItemZone(it), it }));
}

function updateMixCount() {
  const x = $('mixCount');
  if (x) x.textContent = selectedPieces().length + ' món';
}

// Thuật toán chia ô tự động KHÔNG ĐÈ NHAU, luôn có padding >= 3% và nằm trọn 100% trong Canvas
function computeCanvasLayout(pieces) {
  const PAD_X = 3;
  const PAD_Y = 3.5;
  const MARGIN_X = 3;
  const MARGIN_Y = 4;

  const head = pieces.filter(p => p.zone === 'HEAD');
  const neck = pieces.filter(p => p.zone === 'NECK');
  const upper = pieces.filter(p => p.zone === 'UPPER' || p.zone === 'DRESS');
  const waist = pieces.filter(p => p.zone === 'WAIST');
  const lower = pieces.filter(p => p.zone === 'LOWER');
  const foot = pieces.filter(p => p.zone === 'FOOT');
  const side = pieces.filter(p => p.zone === 'SIDE');

  // Xây các hàng của cột trung tâm (Trục cơ thể từ đầu -> chân)
  const centerRows = [];
  if (head.length === 1) centerRows.push({ items: head, weight: 0.78 });
  else if (head.length > 1) side.unshift(...head);

  if (neck.length === 1 && !upper.length) centerRows.push({ items: neck, weight: 0.85 });
  else if (neck.length) side.unshift(...neck);

  if (upper.length) centerRows.push({ items: upper, weight: upper.some(p => p.zone === 'DRESS') ? 1.65 : 1.32 });

  if (waist.length === 1) centerRows.push({ items: waist, weight: 0.72 });
  else if (waist.length > 1) side.push(...waist);

  if (lower.length) centerRows.push({ items: lower, weight: 1.38 });
  if (foot.length) centerRows.push({ items: foot, weight: 0.82 });

  // Chia đều các phụ kiện / túi sang 2 cột trái & phải
  const leftRows = [];
  const rightRows = [];
  if (!centerRows.length) {
    // Nếu chỉ chọn toàn phụ kiện/túi -> chia lưới đều ở chính giữa
    const cols = side.length <= 2 ? 1 : 2;
    for (let i = 0; i < side.length; i += cols) {
      centerRows.push({ items: side.slice(i, i + cols), weight: 1 });
    }
  } else {
    side.forEach((p, idx) => {
      const row = { items: [p], weight: 1 };
      if (idx % 2 === 0) leftRows.push(row);
      else rightRows.push(row);
    });
  }

  // Tính tọa độ X và bề rộng cho các cột hoạt động (luôn cách nhau PAD_X = 3%)
  const activeCols = [];
  const hasLeft = leftRows.length > 0;
  const hasRight = rightRows.length > 0;

  if (!hasLeft && !hasRight) {
    activeCols.push({ x: 11, w: 78, rows: centerRows });
  } else if (hasLeft && !hasRight) {
    activeCols.push({ x: MARGIN_X, w: 26, rows: leftRows });
    activeCols.push({ x: MARGIN_X + 26 + PAD_X, w: 100 - MARGIN_X * 2 - 26 - PAD_X, rows: centerRows });
  } else {
    const sideW = 22.5;
    const centerW = 100 - MARGIN_X * 2 - sideW * 2 - PAD_X * 2;
    activeCols.push({ x: MARGIN_X, w: sideW, rows: leftRows });
    activeCols.push({ x: MARGIN_X + sideW + PAD_X, w: centerW, rows: centerRows });
    activeCols.push({ x: MARGIN_X + sideW + PAD_X + centerW + PAD_X, w: sideW, rows: rightRows });
  }

  const placed = [];
  for (const col of activeCols) {
    const R = col.rows.length;
    if (!R) continue;
    const availH = 100 - MARGIN_Y * 2 - (R - 1) * PAD_Y;
    const totalW = col.rows.reduce((sum, r) => sum + r.weight, 0);
    const maxSingleH = R === 1 ? 66 : (R === 2 ? 43 : 999);

    const rowHeights = col.rows.map(r => Math.min(maxSingleH, (availH * r.weight) / totalW));
    const usedH = rowHeights.reduce((a, b) => a + b, 0) + (R - 1) * PAD_Y;
    let curY = MARGIN_Y + Math.max(0, (100 - MARGIN_Y * 2 - usedH) / 2);

    col.rows.forEach((row, rIdx) => {
      const h = rowHeights[rIdx];
      const K = row.items.length;
      const itemW = (col.w - (K - 1) * PAD_X) / K;
      row.items.forEach((piece, kIdx) => {
        placed.push({
          ...piece,
          p: {
            x: +(col.x + kIdx * (itemW + PAD_X)).toFixed(2),
            y: +curY.toFixed(2),
            w: +itemW.toFixed(2),
            h: +h.toFixed(2)
          }
        });
      });
      curY += h + PAD_Y;
    });
  }

  return placed;
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
    <figure class="mixpiece" data-piece-id="${esc(it.id)}" style="left:${p.x}%;top:${p.y}%;width:${p.w}%;height:${p.h}%;animation-delay:${i * 45}ms">
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

        if (appsScriptUrl && finalPhoto.startsWith('data:image/')) {
          toast('Đang tải ảnh cập nhật lên Drive...');
          try {
            const driveRes = await uploadToAppsScript(finalPhoto, `${name || old.name || 'item'}-${Date.now()}.png`);
            finalPhoto = driveRes.url;
            driveFileId = driveRes.id;
          } catch (uploadErr) {
            console.warn('Lỗi tải Drive, giữ ảnh cục bộ:', uploadErr.message);
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

        if (appsScriptUrl && p.photo.startsWith('data:image/')) {
          toast(`Đang lưu ảnh ${j + 1}/${photos.length} lên Drive...`);
          try {
            const driveRes = await uploadToAppsScript(p.photo, `${name || cat}-${Date.now()}-${j}.png`);
            finalPhoto = driveRes.url;
            driveFileId = driveRes.id;
          } catch (uploadErr) {
            console.warn('Lỗi tải Drive, lưu cục bộ:', uploadErr.message);
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
    toast('Đang đồng bộ dữ liệu với Drive...');
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

// 11B. Ảnh Ma-nơ-canh gốc chuẩn (Canonical Base Mannequin 1024x1024) + Bảng ghép 4 vùng cơ thể (Anatomical Zone Boards)
let cachedMannequinBaseUrl = '';

function getBaseMannequinDataUrl() {
  if (cachedMannequinBaseUrl) return cachedMannequinBaseUrl;
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 1024;
  const ctx = c.getContext('2d');

  // Phông studio kem ấm đồng nhất 100%
  const bg = ctx.createRadialGradient(512, 420, 80, 512, 512, 680);
  bg.addColorStop(0, '#F7F4EE');
  bg.addColorStop(1, '#EAE4DA');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 1024, 1024);

  // Bóng sàn studio mềm
  const floorShadow = ctx.createRadialGradient(512, 935, 10, 512, 935, 175);
  floorShadow.addColorStop(0, 'rgba(60, 48, 35, 0.18)');
  floorShadow.addColorStop(1, 'rgba(60, 48, 35, 0)');
  ctx.fillStyle = floorShadow;
  ctx.beginPath();
  ctx.ellipse(512, 935, 175, 24, 0, 0, Math.PI * 2);
  ctx.fill();

  // Trụ gỗ sồi & chân đế chữ thập thanh mảnh
  const woodGrad = ctx.createLinearGradient(496, 0, 528, 0);
  woodGrad.addColorStop(0, '#A5794C');
  woodGrad.addColorStop(0.5, '#C89E6E');
  woodGrad.addColorStop(1, '#8C6239');
  ctx.fillStyle = woodGrad;
  ctx.fillRect(502, 540, 20, 385);

  // Chân đế gỗ 3 chạc
  ctx.strokeStyle = '#9D7246';
  ctx.lineWidth = 16;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(512, 895);
  ctx.lineTo(410, 932);
  ctx.moveTo(512, 895);
  ctx.lineTo(614, 932);
  ctx.moveTo(512, 885);
  ctx.lineTo(512, 940);
  ctx.stroke();

  // Chóp cổ gỗ sồi tiện tròn
  ctx.fillStyle = woodGrad;
  ctx.beginPath();
  ctx.roundRect(488, 128, 48, 38, 12);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(512, 126, 20, 10, 0, 0, Math.PI * 2);
  ctx.fill();

  // Thân Ma-nơ-canh nữ bọc vải linen kem chuẩn tỉ lệ Haute Couture (vai 38 - eo thon 60 - hông 88)
  const torsoGrad = ctx.createLinearGradient(375, 160, 650, 550);
  torsoGrad.addColorStop(0, '#EFE7D8');
  torsoGrad.addColorStop(0.42, '#E2D5C1');
  torsoGrad.addColorStop(0.85, '#CBBAA1');
  torsoGrad.addColorStop(1, '#B8A58B');

  ctx.fillStyle = torsoGrad;
  ctx.beginPath();
  ctx.moveTo(486, 156); // Cổ trái
  ctx.quadraticCurveTo(478, 182, 392, 198); // Cầu vai trái
  ctx.quadraticCurveTo(372, 204, 376, 232); // Đỉnh vai trái
  ctx.bezierCurveTo(385, 290, 412, 315, 438, 368); // Ngực xuống eo trái
  ctx.bezierCurveTo(446, 392, 412, 438, 408, 488); // Eo mở ra hông trái
  ctx.quadraticCurveTo(410, 536, 464, 544); // Đáy hông trái
  ctx.lineTo(560, 544); // Đáy hông phải
  ctx.quadraticCurveTo(614, 536, 616, 488); // Hông phải
  ctx.bezierCurveTo(612, 438, 578, 392, 586, 368); // Eo phải
  ctx.bezierCurveTo(612, 315, 639, 290, 648, 232); // Ngực lên đỉnh vai phải
  ctx.quadraticCurveTo(652, 204, 632, 198); // Cầu vai phải
  ctx.quadraticCurveTo(546, 182, 538, 156); // Cổ phải
  ctx.closePath();
  ctx.fill();

  // Đường chỉ may công thái học đặc trưng của ma-nơ-canh thiết kế
  ctx.strokeStyle = 'rgba(130, 110, 86, 0.32)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(512, 158);
  ctx.lineTo(512, 544); // Đường trục giữa thân
  ctx.moveTo(436, 202);
  ctx.bezierCurveTo(448, 285, 462, 370, 452, 542); // Đường cắt cúp ngực trái
  ctx.moveTo(588, 202);
  ctx.bezierCurveTo(576, 285, 562, 370, 572, 542); // Đường cắt cúp ngực phải
  ctx.moveTo(436, 374);
  ctx.quadraticCurveTo(512, 384, 588, 374); // Đường đai eo chuẩn
  ctx.stroke();

  cachedMannequinBaseUrl = c.toDataURL('image/png');
  return cachedMannequinBaseUrl;
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

// Gom nhiều món (đặc biệt là nhiều Phụ kiện & Túi) vào 1 bảng 1024x1024 có gắn nhãn vùng đeo [#1 HEAD, #2 NECK, #3 WAIST...]
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

    // In nhãn vùng đeo ngay trên ảnh để AI đọc và đặt đúng vị trí 100%
    ctx.fillStyle = '#1A3323';
    ctx.font = 'bold 18px sans-serif';
    const label = `#${idx + 1} [${p.zone}] ${p.it.name}`.slice(0, 32);
    ctx.fillText(label, x + 14, y + cellH - 16);
  });

  return c.toDataURL('image/png');
}

// Đóng gói tối đa 4 slot ảnh cho muse-image: Slot 1 = Ma-nơ-canh gốc chuẩn, Slot 2..4 = Đồ chính & Bảng Phụ kiện không giới hạn
async function buildAiReferenceBoards(selected) {
  const mannequinBase = getBaseMannequinDataUrl();
  const mainGarments = selected.filter(s => ['UPPER', 'DRESS', 'LOWER', 'FOOT'].includes(s.zone));
  const accessories = selected.filter(s => !['UPPER', 'DRESS', 'LOWER', 'FOOT'].includes(s.zone));

  const refs = [mannequinBase];

  if (selected.length <= 3) {
    // Nếu tổng <= 3 món: gửi thẳng Ma-nơ-canh gốc + từng ảnh gốc
    for (const s of selected) {
      if (s.it.photo) refs.push(s.it.photo);
    }
    return refs;
  }

  // Nếu có nhiều món / nhiều phụ kiện (> 3 món): chia thành các Bảng Vùng 1024x1024 để không bị cắt mất món nào
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

    const btn = $('aiGenerateBtn');
    const oldHtml = btn.innerHTML;
    const box = $('aiResultBox');
    const stage = $('aiResultStage');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>';
    box.classList.remove('hidden');
    stage.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:8px" aria-hidden="true"></i>Đang đóng gói ảnh Ma-nơ-canh gốc & bảng phụ kiện...';

    try {
      const refImages = await buildAiReferenceBoards(selected);

      const zonePlacementGuide = {
        HEAD: 'Place on the top/head position above the mannequin neck finial',
        NECK: 'Drape or tie neatly around the mannequin neck/collar area',
        UPPER: 'Dress onto the mannequin upper torso/shoulders',
        DRESS: 'Dress full-length onto the mannequin torso draping down over hips',
        WAIST: 'Fasten securely around the narrowest part of the mannequin waist OVER the top/dress',
        LOWER: 'Fit onto the mannequin waist and hips hanging down cleanly over the wooden stand',
        FOOT: 'Place neatly at the base of the wooden stand underneath the hemline',
        SIDE: 'Display cleanly beside the mannequin hip/shoulder as a coordinated boutique styling prop'
      };

      const normalizedBlock = selected
        .map((s, idx) => `- Item #${idx + 1} [${s.zone} — ${s.cat}]: "${s.it.name}"${s.it.color ? `, exact color: ${s.it.color}` : ''}${s.it.note ? `, detail: ${s.it.note}` : ''}. Placement: ${zonePlacementGuide[s.zone] || 'On mannequin'}.`)
        .join('\n');

      const prompt = `Use Reference Image #1 as the EXACT base mannequin (preserve its exact beige-linen headless torso proportions, slim light-oak stand, front camera angle, and warm cream studio backdrop).

Execute a strict two-stage garment shape normalization and multi-accessory assembly from the remaining reference images/boards:

STAGE 1 — 1:1 GARMENT & ACCESSORY SHAPE NORMALIZATION:
Extract every listed item (${selected.length} items total) from the reference images/labeled grids. Strip away any human body, hands, hangers, or background from the source photos, locking each item's exact 1:1 silhouette, neckline, sleeve/leg cut, fabric texture, and color shade:
${normalizedBlock}

STAGE 2 — COMPLETE MULTI-ACCESSORY ASSEMBLY ON THE BASE MANNEQUIN:
Dress and position ALL ${selected.length} normalized items from Stage 1 onto/around the exact base mannequin from Reference Image #1 following their [ZONE] tags:
- Every single listed item and accessory (${selected.map(s => s.it.name).join(', ')}) MUST be clearly visible in its designated anatomical zone.
- Keep 100% fidelity to each garment's original shape, cut, wash, and details.
- NO human, NO face, NO head, NO hair, NO hands, NO skin, NO unrequested items.`;

      const dataUrl = await callMuseImage(prompt, refImages, elapsed => {
        stage.innerHTML = `<i class="fa-solid fa-spinner fa-spin" style="margin-right:8px" aria-hidden="true"></i>Đang chuẩn hóa ${selected.length} món & ghép lên Ma-nơ-canh gốc (${elapsed}s)...`;
      });
      lastAiDataUrl = dataUrl;
      const imgEl = document.createElement('img');
      imgEl.src = dataUrl;
      imgEl.alt = 'Ảnh phối đồ AI';
      stage.innerHTML = '';
      stage.appendChild(imgEl);
      toast('Đã tạo xong ảnh phối đồ');
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
      if (appsScriptUrl && lastAiDataUrl.startsWith('data:image/')) {
        try {
          const driveRes = await uploadToAppsScript(lastAiDataUrl, `Lookbook-${name}-${Date.now()}.webp`);
          if (driveRes?.url) aiPhotoUrl = driveRes.url;
        } catch (err) {
          console.warn('Không tải được ảnh Lookbook lên Drive, giữ cục bộ:', err.message);
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
