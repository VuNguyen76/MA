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
  const shown = items.filter(i => {
    const matchCat = activeFilter === 'Tất cả' || i.cat === activeFilter;
    const matchSearch = [i.name, i.color, i.note, i.season].join(' ').toLocaleLowerCase().includes(q);
    return matchCat && matchSearch;
  });

  const closetEl = $('closet');
  if (!shown.length) {
    closetEl.innerHTML = `<div class="empty"><i class="fa-solid fa-shirt empty-ico" aria-hidden="true"></i>Tủ đồ chưa có món nào ở mục này<br>Nhấn “Thêm đồ” để bắt đầu nhé.</div>`;
    return;
  }

  const selectedIds = new Set(Object.values(board));

  closetEl.innerHTML = shown.map(i => {
    const isSelected = selectedIds.has(i.id);
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
      const id = el.dataset.id;
      const existingSlot = Object.keys(board).find(k => board[k] === id);
      if (existingSlot) {
        delete board[existingSlot];
        renderBoard();
        renderCloset();
      } else {
        addToBoard(id);
      }
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

function addToBoard(id, slot) {
  const it = items.find(x => x.id === id);
  if (!it) return;
  board[slot || it.cat] = id;
  renderBoard();
  renderCloset();
}

function renderBoard() {
  updateMixCount();
  const boardEl = $('board');
  boardEl.innerHTML = SLOTS.map(c => {
    const it = items.find(i => i.id === board[c]);
    return `
      <div class="slot ${it ? 'filled' : ''}" data-slot="${esc(c)}">
        <span class="slotlabel">${esc(c)}</span>
        ${it ? `
          <button type="button" class="slotremove" data-remove="${esc(c)}" title="Bỏ khỏi outfit" aria-label="Bỏ khỏi outfit"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
          <img alt="${esc(it.name)}" src="${it.photo}">
          <div class="slotcaption">${esc(it.name)}</div>
        ` : `
          <i class="fa-solid fa-plus slot-empty-ico" aria-hidden="true"></i>
          <div class="sub">Chạm hoặc thả vào đây</div>
        `}
      </div>
    `;
  }).join('');

  boardEl.querySelectorAll('.slot').forEach(s => {
    const slotName = s.dataset.slot;

    s.ondragover = e => {
      e.preventDefault();
      s.classList.add('dropdrag');
    };
    s.ondragleave = () => s.classList.remove('dropdrag');
    s.ondrop = e => {
      e.preventDefault();
      s.classList.remove('dropdrag');
      const id = e.dataTransfer.getData('text/plain');
      addToBoard(id, slotName);
    };

    s.onclick = e => {
      if (e.target.closest('[data-remove]')) return;
      if (board[slotName]) {
        delete board[slotName];
        renderBoard();
        toast(`Đã bỏ ${slotName} khỏi outfit`);
      } else {
        activeFilter = slotName;
        renderFilters();
        renderCloset();
        toast(`Đang lọc tủ đồ theo “${slotName}”`);
      }
    };
  });

  boardEl.querySelectorAll('[data-remove]').forEach(b => {
    b.onclick = (e) => {
      e.stopPropagation();
      delete board[b.dataset.remove];
      renderBoard();
      renderCloset();
    };
  });

  // Tự động dàn set lên Lookbook Canvas mỗi khi chọn/bỏ món
  mixOutfit(true);
}

function renderLooks() {
  const grid = $('savedGrid');
  if (!looks.length) {
    grid.innerHTML = '<div class="empty"><i class="fa-regular fa-bookmark empty-ico" aria-hidden="true"></i>Chưa có outfit nào trong Bộ sưu tập<br>Qua tab Tủ đồ để phối set đầu tiên nhé.</div>';
    return;
  }

  grid.innerHTML = looks.map(l => {
    const selected = Object.entries(l.board)
      .map(([slot, id]) => ({ slot, it: items.find(i => i.id === id) }))
      .filter(x => x.it);

    return `
      <article class="lookcard">
        ${l.aiPhoto ? `<div class="look-ai-wrap"><img class="look-ai-thumb" src="${l.aiPhoto}" alt="${esc(l.name)}" loading="lazy"><button type="button" class="item-fab look-zoom-btn" title="Xem toàn màn hình" aria-label="Xem toàn màn hình" data-zoom-look="${esc(l.id)}"><i class="fa-solid fa-magnifying-glass-plus" aria-hidden="true"></i></button></div>` : ''}
        <div class="lookpics">
          ${selected.slice(0, 6).map(x => `
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
      board = { ...l.board };
      $('lookName').value = l.name;
      switchTab('studio');
      renderBoard();
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
  for (let k in board) {
    if (board[k] === id) delete board[k];
  }
  await reload();
  syncDatabaseToDrive(false, i.driveFileId ? [i.driveFileId] : []);
}

// =============================================================================
// 7. LOOKBOOK STUDIO (MIX & MATCH FLAT-LAY)
// =============================================================================
function selectedPieces() {
  return SLOTS.map(cat => ({ cat, it: items.find(x => x.id === board[cat]) })).filter(x => x.it);
}

function updateMixCount() {
  const x = $('mixCount');
  if (x) x.textContent = selectedPieces().length + ' món';
}

function mixOutfit(silent = false) {
  const selected = selectedPieces();
  const canvas = $('mixCanvas');
  updateMixCount();

  if (!selected.length) {
    canvas.innerHTML = '';
    canvas.classList.add('empty');
    if (!silent) toast('Hãy chọn ít nhất một món trước nha');
    return;
  }

  canvas.classList.remove('empty');
  const clothing = selected.filter(x => !['Phụ kiện', 'Túi xách', 'Giày dép'].includes(x.cat));

  let active = selected.map(({ cat, it }) => ({ cat, it, p: { ...POSITIONS[cat] } }));
  if (selected.length === 1) {
    active[0].p = { x: 19, y: 15, w: 62, h: 69, r: -2, z: 4 };
  } else if (clothing.length === 1) {
    const only = active.find(x => x.cat === clothing[0].cat);
    if (only) only.p = { x: 17, y: 12, w: 64, h: 68, r: -2, z: 4 };
  }

  if (board['Váy liền']) {
    active.filter(x => ['Áo', 'Quần', 'Chân váy'].includes(x.cat)).forEach((x, i) => {
      x.p = { x: i ? 49 : 5, y: i ? 53 : 50, w: 33, h: 31, r: i ? 6 : -6, z: 6 + i };
    });
  }

  canvas.innerHTML = active.map(({ cat, it, p }, i) => `
    <figure class="mixpiece" style="left:${p.x}%;top:${p.y}%;width:${p.w}%;height:${p.h}%;z-index:${p.z};transform:rotate(${p.r}deg);animation-delay:${i * 65}ms">
      <img src="${it.photo}" alt="${esc(it.name)}" draggable="false">
      <figcaption title="${esc(it.name)}">${esc(it.name)}</figcaption>
    </figure>
  `).join('');

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
  const valid = Object.entries(board).filter(([s, id]) => items.some(i => i.id === id));
  if (!valid.length) return toast('Thêm ít nhất một món vào outfit trước nha');

  const name = $('lookName').value.trim() || `Outfit ${new Date().toLocaleDateString('vi-VN')}`;
  const look = {
    id: uuid(),
    name,
    board: Object.fromEntries(valid),
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
  board = {};
  $('lookName').value = '';
  $('aiNote')?.classList.add('hidden');
  $('aiResultBox')?.classList.add('hidden');
  renderBoard();
  renderCloset();
};

$('search').oninput = renderCloset;
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

async function callMuseImage(prompt) {
  const data = await callMuseApi({ action: 'image', prompt });
  if (!data.dataUrl) throw new Error('API không trả về ảnh');
  return data.dataUrl;
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
{"name":"Tên ngắn gọn tiếng Việt (VD: Áo sơ mi lụa trắng)","cat":"Chọn đúng 1 trong: ${CATS.join(', ')}","color":"Màu chủ đạo tiếng Việt","season":"Chọn đúng 1 trong: Đi làm, Đi chơi dạo phố, Dự tiệc, Du lịch, Mặc ở nhà","note":"Gợi ý phối đồ ngắn dưới 12 từ"}`;
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

// 11B. Tạo ảnh phối đồ AI qua MuseAI
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
    stage.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:8px" aria-hidden="true"></i>Đang tạo ảnh phối đồ (khoảng 30–50 giây)...';

    try {
      const garmentList = selected
        .map((s, idx) => `${idx + 1}. ${s.cat}: ${s.it.name}${s.it.color ? ' (' + s.it.color + ')' : ''}${s.it.note ? ' - ' + s.it.note : ''}`)
        .join('\n');

      const prompt = `Clean realistic studio product photograph of a single minimalist headless boutique fashion mannequin (beige linen torso dress-form on a slim light wood stand, NO human, NO face, NO head, NO hair, NO skin) dressed neatly in ONLY the following exact outfit:\n${garmentList}\n\nRequirements:\n- Strictly match every garment's exact color, cut, style, and details listed above.\n- Do NOT invent extra jackets, bags, hats, or accessories not listed.\n- Front-facing full-length view centered in frame, crisp even daylight studio lighting, plain clean off-white seamless backdrop, realistic boutique e-commerce photography, no text, no watermarks.`;

      const dataUrl = await callMuseImage(prompt);
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
      const valid = Object.entries(board).filter(([s, id]) => items.some(i => i.id === id));
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
        board: Object.fromEntries(valid),
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
