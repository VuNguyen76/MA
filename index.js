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

// Phân tích hồ sơ món đồ theo lý thuyết sách thời trang (The Curated Closet, Rule of Thirds, Layering Architecture)
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

  let volume = 'REGULAR';
  const cleanNote = note.replace(/ko nên mặc với quần rộng|không nên mặc với quần rộng/g, '');
  if (/ống rộng|oversize|rộng|babydoll|giấu quần|túi hộp|voan/.test(name + ' ' + cleanNote)) {
    volume = 'OVERSIZED';
  } else if (/ôm|cúp ngực|2s|ba lỗ|siết eo|thắt eo|cạp cao|corset|eo nhỏ|croptop|crop top/.test(name + ' ' + cleanNote)) {
    volume = 'FITTED';
  }

  let directive = '';
  if (/đóng thùng|chặt thùng/.test(note)) {
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

  return { zone, role, volume, directive };
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
  const upperCount = sel.filter(s => s.zone === 'UPPER').length;
  x.textContent = upperCount >= 2 ? `${sel.length} món · 2 Style` : `${sel.length} món`;
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

// 11B. Hệ thống Ma-nơ-canh Linh Hoạt (Adaptive Couture Mannequin 1024x1024) & Động cơ Tư Duy Thời Trang (Fashion Book Styling Engine)
function drawCoutureMannequinFigure(ctx, cx, scale, opts = {}) {
  ctx.save();
  ctx.translate(cx, opts.topY || 70);
  ctx.scale(scale, scale);

  const hasHeadCrown = !!opts.hasHeadCrown;
  const pose = opts.pose || 'editorial_left';

  // 1. Bóng đổ sàn & Bệ đứng đá Travertine / Gỗ sồi tối giản (không dùng cọc giữa háng để quần ống rộng/short vào phom chuẩn 3D)
  const floorShadow = ctx.createRadialGradient(0, 865, 12, 0, 865, 165);
  floorShadow.addColorStop(0, 'rgba(52, 42, 30, 0.22)');
  floorShadow.addColorStop(1, 'rgba(52, 42, 30, 0)');
  ctx.fillStyle = floorShadow;
  ctx.beginPath();
  ctx.ellipse(0, 865, 165, 24, 0, 0, Math.PI * 2);
  ctx.fill();

  // Đế tròn bảo tàng (Museum Plinth) + Trụ đỡ lệch phía sau bắp chân
  const plinthGrad = ctx.createLinearGradient(-115, 835, 115, 875);
  plinthGrad.addColorStop(0, '#D8CFC2');
  plinthGrad.addColorStop(0.5, '#EFEAE1');
  plinthGrad.addColorStop(1, '#B8AC9B');
  ctx.fillStyle = plinthGrad;
  ctx.beginPath();
  ctx.ellipse(0, 854, 112, 18, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(120, 102, 82, 0.35)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Chất liệu vải Linen / Bisque cao cấp của ma-nơ-canh nhà mốt
  const linenGrad = ctx.createLinearGradient(-145, 70, 145, 780);
  linenGrad.addColorStop(0, '#F3ECE0');
  linenGrad.addColorStop(0.45, '#E4D8C5');
  linenGrad.addColorStop(0.85, '#CEBEA6');
  linenGrad.addColorStop(1, '#BAA78D');

  const limbGrad = ctx.createLinearGradient(-150, 120, 150, 820);
  limbGrad.addColorStop(0, '#EDE4D5');
  limbGrad.addColorStop(0.6, '#DACBB5');
  limbGrad.addColorStop(1, '#C3B197');

  const woodGrad = ctx.createLinearGradient(-28, 0, 28, 0);
  woodGrad.addColorStop(0, '#9E7347');
  woodGrad.addColorStop(0.5, '#C89F70');
  woodGrad.addColorStop(1, '#845C33');

  // 2. Đôi chân điêu khắc chuẩn tỉ lệ 1:2 (giúp quần tây, quần ống rộng, quần short và chân váy rủ tự nhiên)
  ctx.fillStyle = limbGrad;
  // Chân trái
  ctx.beginPath();
  ctx.moveTo(-78, 430);
  ctx.bezierCurveTo(-86, 540, -76, 650, -56, 838);
  ctx.lineTo(-24, 838);
  ctx.bezierCurveTo(-20, 660, -14, 545, -10, 442);
  ctx.closePath();
  ctx.fill();

  // Chân phải (dáng đứng contrapposto thanh thoát)
  const rightLegShift = pose === 'contrapposto_right' ? 14 : 6;
  ctx.beginPath();
  ctx.moveTo(10, 442);
  ctx.bezierCurveTo(16, 545, 22 + rightLegShift * 0.4, 660, 26 + rightLegShift, 838);
  ctx.lineTo(58 + rightLegShift, 838);
  ctx.bezierCurveTo(78 + rightLegShift * 0.5, 650, 86, 540, 78, 430);
  ctx.closePath();
  ctx.fill();

  // 3. Tay khớp gỗ/linen linh hoạt (Articulated Atelier Arms) giúp tay áo sơ mi, blazer, áo trễ vai và quai túi vào phom thật
  ctx.strokeStyle = '#D5C4AC';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Cánh tay trái
  ctx.lineWidth = 28;
  ctx.beginPath();
  if (pose === 'contrapposto_right') {
    // Tay trái hơi chống nhẹ gần hông tạo độ mở cho áo khoác/sơ mi
    ctx.moveTo(-118, 148);
    ctx.quadraticCurveTo(-156, 255, -112, 355);
  } else {
    // Tay trái buông tự nhiên dọc thân
    ctx.moveTo(-118, 148);
    ctx.quadraticCurveTo(-142, 265, -126, 395);
  }
  ctx.stroke();

  // Cánh tay phải
  ctx.beginPath();
  if (pose === 'editorial_left') {
    // Cẳng tay phải hơi nâng nhẹ tạo điểm treo túi hoặc khoe tay áo xắn
    ctx.moveTo(118, 148);
    ctx.quadraticCurveTo(154, 252, 114, 348);
  } else {
    ctx.moveTo(118, 148);
    ctx.quadraticCurveTo(142, 265, 126, 395);
  }
  ctx.stroke();

  // Khớp cầu vai gỗ sồi của ma-nơ-canh thiết kế
  ctx.fillStyle = woodGrad;
  ctx.beginPath();
  ctx.arc(-118, 148, 15, 0, Math.PI * 2);
  ctx.arc(118, 148, 15, 0, Math.PI * 2);
  ctx.fill();

  // 4. Đầu / Cổ linh hoạt (Có vòm đầu điêu khắc không mặt khi đội Nón/Kính, hoặc chóp gỗ Couture khi không đội nón)
  if (hasHeadCrown) {
    // Cổ thanh mảnh + Vòm đầu điêu khắc không mặt bọc vải linen để đội nón kết/mũ chuẩn góc
    ctx.fillStyle = linenGrad;
    ctx.fillRect(-21, 56, 42, 46);
    ctx.beginPath();
    ctx.ellipse(0, 18, 44, 56, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Cổ linen + Chóp gỗ sồi tiện tròn chuẩn Haute Couture
    ctx.fillStyle = linenGrad;
    ctx.fillRect(-22, 68, 44, 34);
    ctx.fillStyle = woodGrad;
    ctx.beginPath();
    ctx.roundRect(-22, 42, 44, 30, 10);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(0, 40, 17, 8, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // 5. Thân Ma-nơ-canh chuẩn tỉ lệ Vàng 1/3 - 2/3 (Cầu vai 38 - Eo 1/3 tại y=292 - Hông 445)
  ctx.fillStyle = linenGrad;
  ctx.beginPath();
  ctx.moveTo(-23, 94); // Chân cổ trái
  ctx.quadraticCurveTo(-35, 116, -110, 130); // Cầu vai trái
  ctx.quadraticCurveTo(-128, 136, -122, 164); // Đỉnh vai trái
  ctx.bezierCurveTo(-110, 215, -90, 245, -66, 292); // Ngực thu về eo 1/3 trái
  ctx.bezierCurveTo(-58, 314, -88, 360, -90, 412); // Eo mở ra hông trái
  ctx.quadraticCurveTo(-86, 452, -38, 458); // Đáy hông trái
  ctx.lineTo(38, 458); // Đáy hông phải
  ctx.quadraticCurveTo(86, 452, 90, 412); // Hông phải
  ctx.bezierCurveTo(88, 360, 58, 314, 66, 292); // Eo phải
  ctx.bezierCurveTo(90, 245, 110, 215, 122, 164); // Ngực lên đỉnh vai phải
  ctx.quadraticCurveTo(128, 136, 110, 130); // Cầu vai phải
  ctx.quadraticCurveTo(35, 116, 23, 94); // Chân cổ phải
  ctx.closePath();
  ctx.fill();

  // Đường chỉ may công thái học & Đai eo Tỉ lệ vàng 1/3 (Waist Landmark)
  ctx.strokeStyle = 'rgba(122, 102, 78, 0.34)';
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(0, 96);
  ctx.lineTo(0, 456); // Trục giữa thân
  ctx.moveTo(-68, 134);
  ctx.bezierCurveTo(-56, 210, -44, 292, -52, 452); // Đường princess seam trái
  ctx.moveTo(68, 134);
  ctx.bezierCurveTo(56, 210, 44, 292, 52, 452); // Đường princess seam phải
  ctx.moveTo(-66, 294);
  ctx.quadraticCurveTo(0, 304, 66, 294); // Đai eo chuẩn 1/3
  ctx.stroke();

  // Nhãn chân đế (STYLE 01 / STYLE 02 khi ở chế độ 2 Style)
  if (opts.badge) {
    ctx.fillStyle = '#1A3323';
    ctx.font = 'bold 17px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(opts.badge, 0, 892);
  }

  ctx.restore();
}

function getAdaptiveMannequinDataUrl(selected, stylingPlan) {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 1024;
  const ctx = c.getContext('2d');

  // Phông studio kem ấm Haute Lookbook
  const bg = ctx.createRadialGradient(512, 420, 80, 512, 512, 700);
  bg.addColorStop(0, '#F8F5EF');
  bg.addColorStop(1, '#EAE3D8');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 1024, 1024);

  const hasHeadCrown = selected.some(s => s.zone === 'HEAD');

  if (stylingPlan?.mode === 'DUAL_STYLE') {
    // Vẽ 2 Ma-nơ-canh song song (STYLE 01 bên trái & STYLE 02 bên phải) để AI lên 2 cách phối/2 style rõ ràng
    drawCoutureMannequinFigure(ctx, 282, 0.88, {
      topY: 110,
      hasHeadCrown,
      pose: 'editorial_left',
      badge: 'STYLE 01'
    });
    drawCoutureMannequinFigure(ctx, 742, 0.88, {
      topY: 110,
      hasHeadCrown,
      pose: 'contrapposto_right',
      badge: 'STYLE 02'
    });
  } else {
    drawCoutureMannequinFigure(ctx, 512, 0.96, {
      topY: 74,
      hasHeadCrown,
      pose: 'editorial_left'
    });
  }

  return c.toDataURL('image/png');
}

// Tư duy thời trang từ sách styling (The Curated Closet, Rule of Thirds 1:2, Volume Counterbalance, Layering Theory)
function buildSingleGarmentStylingRule(piece, bottomPiece) {
  const { role, volume, directive } = piece.profile;
  const bottomVol = bottomPiece?.profile?.volume || 'REGULAR';
  const rules = [];

  if (directive === 'FULL_TUCK') {
    rules.push('Full tailored tuck into the high-waisted waistband (honoring item note: đóng/chặt thùng) to establish a crisp 1:2 Rule-of-Thirds leg-lengthening line');
  } else if (directive === 'BOYFRIEND_UNTUCKED') {
    rules.push('Relaxed boyfriend untucked drape covering the upper hip (2:1 street proportion as noted: mặc giấu quần)');
  } else if (directive === 'WAIST_CINCH' || role === 'STATEMENT_TOP') {
    rules.push('Sculpted waist-cinched fit accentuating the narrowest 1/3 natural waist point');
  } else if (role === 'BUTTON_SHIRT') {
    if (volume === 'OVERSIZED' && bottomVol === 'OVERSIZED') {
      rules.push('Asymmetric French tuck (half-tuck front hem into waistband) + roll sleeves to mid-forearm + unbutton top 2 collar buttons to prevent oversized-on-oversized bulk');
    } else {
      rules.push('Crisp French tuck at the front waist with sleeves neatly cuffed to mid-forearm and collar framed cleanly');
    }
  } else if (volume === 'OVERSIZED' && bottomVol === 'OVERSIZED') {
    rules.push('Structured French front-tuck at the high waist to counterbalance the wide-leg bottom silhouette');
  } else {
    rules.push('Clean 1:2 Rule-of-Thirds waist transition aligned neatly with the bottom waistband');
  }

  return rules.join('; ');
}

function buildFashionStylingPlan(selected) {
  const uppers = selected.filter(s => s.zone === 'UPPER');
  const lowers = selected.filter(s => s.zone === 'LOWER' || s.zone === 'DRESS');
  const footwear = selected.filter(s => s.zone === 'FOOT');
  const accessories = selected.filter(s => !['UPPER', 'LOWER', 'DRESS', 'FOOT'].includes(s.zone));
  const primaryBottom = lowers[0] || null;

  // KHI CÓ TỪ 2 MÓN THÂN TRÊN TRỞ LÊN: Tự động kích hoạt Tư duy 2 Style (Dual-Mannequin Editorial Lookbook)
  if (uppers.length >= 2) {
    const [u1, u2, ...restUppers] = uppers;
    const r1 = u1.profile.role;
    const r2 = u2.profile.role;

    const isBase = r => r === 'BASE_TOP' || r === 'CORE_TOP';
    const isOuterOrShirt = r => r === 'BUTTON_SHIRT' || r === 'OUTERWEAR' || r === 'SHEER_LAYER';

    let canLayerTogether = false;
    let innerPiece = u1;
    let outerPiece = u2;

    if (isBase(r1) && isOuterOrShirt(r2)) {
      canLayerTogether = true;
      innerPiece = u1;
      outerPiece = u2;
    } else if (isBase(r2) && isOuterOrShirt(r1)) {
      canLayerTogether = true;
      innerPiece = u2;
      outerPiece = u1;
    } else if (r1 === 'SHEER_LAYER' || r2 === 'SHEER_LAYER') {
      canLayerTogether = true;
      innerPiece = r1 === 'SHEER_LAYER' ? u2 : u1;
      outerPiece = r1 === 'SHEER_LAYER' ? u1 : u2;
    } else if (r1 === 'OUTERWEAR' || r2 === 'OUTERWEAR') {
      canLayerTogether = true;
      innerPiece = r1 === 'OUTERWEAR' ? u2 : u1;
      outerPiece = r1 === 'OUTERWEAR' ? u1 : u2;
    }

    // Trường hợp A: 2 áo có thể phối Layering với nhau -> Tạo 2 biến tấu Layering khác biệt trên 2 Ma-nơ-canh
    if (canLayerTogether) {
      const outerRole = outerPiece.profile.role;
      let style1Instruction = '';
      let style2Instruction = '';
      let style1Vi = '';
      let style2Vi = '';

      if (outerRole === 'BUTTON_SHIRT') {
        style1Instruction = `LEFT MANNEQUIN (STYLE 01 — Effortless Open-Overshirt Layering, 1:2 Proportion): Wear "${innerPiece.it.name}" as a sleek fitted inner base tucked/aligned at the high waist; layer "${outerPiece.it.name}" COMPLETELY UNBUTTONED as a breezy open overshirt with sleeves rolled neatly to mid-forearm.`;
        style2Instruction = `RIGHT MANNEQUIN (STYLE 02 — Sculpted Waist-Knot / French-Tuck Layering): Wear "${innerPiece.it.name}" underneath peeking cleanly at the V-neckline; style "${outerPiece.it.name}" HALF-BUTTONED and KNOTTED/TIED at the natural 1/3 waist (or asymmetric one-side French tuck) to cinch an hourglass X-silhouette.`;
        style1Vi = `Style 01 (Trái): "${innerPiece.it.name}" mặc trong ôm gọn + "${outerPiece.it.name}" mở cúc khoác ngoài phóng khoáng, xắn tay 1/3 cẳng tay.`;
        style2Vi = `Style 02 (Phải): "${outerPiece.it.name}" buộc vạt/sơ vin lệch (French Tuck) chiết eo cao 1:2 trên nền "${innerPiece.it.name}".`;
      } else if (outerRole === 'SHEER_LAYER') {
        style1Instruction = `LEFT MANNEQUIN (STYLE 01 — High-Contrast Cropped Overlay): Wear "${innerPiece.it.name}" as the clean structured base layer (neatly tucked if long), and layer the sheer/mesh "${outerPiece.it.name}" directly OVER it to create a sharp 1/3 cropped waist division and rich texture contrast.`;
        style2Instruction = `RIGHT MANNEQUIN (STYLE 02 — Asymmetric Off-Shoulder Editorial Layering): Pair "${innerPiece.it.name}" and "${outerPiece.it.name}" with an effortless off-one-shoulder drape and relaxed waist styling for soft editorial movement.`;
        style1Vi = `Style 01 (Trái): Phối lớp tương phản chất liệu — "${innerPiece.it.name}" làm nền + "${outerPiece.it.name}" phủ ngoài phân tách tỉ lệ eo 1:2.`;
        style2Vi = `Style 02 (Phải): Biến tấu trễ nhẹ một bên vai / thả phom bất đối xứng mềm mại giữa "${outerPiece.it.name}" và "${innerPiece.it.name}".`;
      } else {
        style1Instruction = `LEFT MANNEQUIN (STYLE 01 — Tailored Worn-On Layering): Wear "${innerPiece.it.name}" neatly tucked at the 1/3 waist line, with "${outerPiece.it.name}" worn properly on the arms, open-front/unbuttoned, cuffs pushed slightly to reveal wrist proportion.`;
        style2Instruction = `RIGHT MANNEQUIN (STYLE 02 — Parisian Shoulder-Drape Editorial): Showcase "${innerPiece.it.name}" defining the full waist silhouette while draping "${outerPiece.it.name}" effortlessly over the shoulders like a couture editorial cape.`;
        style1Vi = `Style 01 (Trái): Layering chuẩn mực — "${innerPiece.it.name}" sơ vin gọn tôn eo 1:2, mặc "${outerPiece.it.name}" mở cúc thanh lịch.`;
        style2Vi = `Style 02 (Phải): Phong cách Parisian Chic — Khoác hờ "${outerPiece.it.name}" trên cầu vai để khoe trọn phom eo của "${innerPiece.it.name}".`;
      }

      const sharedMain = [...lowers, ...footwear, ...restUppers];
      return {
        mode: 'DUAL_STYLE',
        subMode: 'DUAL_LAYERING_VARIATIONS',
        style1: {
          title: 'STYLE 01 (LEFT MANNEQUIN)',
          mainPieces: [innerPiece, outerPiece, ...sharedMain],
          instruction: style1Instruction,
          summaryVi: style1Vi
        },
        style2: {
          title: 'STYLE 02 (RIGHT MANNEQUIN)',
          mainPieces: [innerPiece, outerPiece, ...sharedMain],
          instruction: style2Instruction,
          summaryVi: style2Vi
        },
        accessories
      };
    }

    // Trường hợp B: 2 áo độc lập (VD: 2 áo sơ mi, hoặc áo sơ mi + áo đắp chéo/peplum/babydoll) -> Không nhồi chồng lên 1 người mà tách thành 2 Look A/B song song
    const rule1 = buildSingleGarmentStylingRule(u1, primaryBottom);
    const rule2 = buildSingleGarmentStylingRule(u2, primaryBottom);
    const sharedMain = [...lowers, ...footwear, ...restUppers];

    return {
      mode: 'DUAL_STYLE',
      subMode: 'CAPSULE_AB_LOOKS',
      style1: {
        title: 'STYLE 01 (LEFT MANNEQUIN — LOOK A)',
        mainPieces: [u1, ...sharedMain],
        instruction: `LEFT MANNEQUIN (STYLE 01 — Look A featuring ONLY "${u1.it.name}" on upper body, do NOT put "${u2.it.name}" on Left Mannequin): Dress Left Mannequin in "${u1.it.name}" paired with ${lowers.map(l => `"${l.it.name}"`).join(', ') || 'the lower garment'}. Styling technique: ${rule1}.`,
        summaryVi: `Style 01 (Trái — Look A): Phối "${u1.it.name}" theo phom riêng (${u1.profile.directive === 'FULL_TUCK' ? 'đóng thùng gọn 1:2' : (u1.profile.volume === 'FITTED' ? 'ôm chiết eo tôn dáng' : 'sơ vin vạt trước French Tuck cân bằng tỉ lệ')}).`
      },
      style2: {
        title: 'STYLE 02 (RIGHT MANNEQUIN — LOOK B)',
        mainPieces: [u2, ...sharedMain],
        instruction: `RIGHT MANNEQUIN (STYLE 02 — Look B featuring ONLY "${u2.it.name}" on upper body, do NOT put "${u1.it.name}" on Right Mannequin): Dress Right Mannequin in "${u2.it.name}" paired with ${lowers.map(l => `"${l.it.name}"`).join(', ') || 'the lower garment'}. Styling technique: ${rule2}.`,
        summaryVi: `Style 02 (Phải — Look B): Biến tấu sang "${u2.it.name}" trên cùng nền quần/phụ kiện (${u2.profile.directive === 'BOYFRIEND_UNTUCKED' ? 'thả vạt phóng khoáng 2:1' : (u2.profile.role === 'STATEMENT_TOP' ? 'nhấn eo chữ X chuẩn tỉ lệ vàng' : 'biến tấu cổ và tay áo thanh thoát')}).`
      },
      accessories
    };
  }

  // CHẾ ĐỘ 1 STYLE (SINGLE MANNEQUIN) VỚI TƯ DUY SÁCH THỜI TRANG
  const topPiece = uppers[0] || null;
  const singleRule = topPiece
    ? buildSingleGarmentStylingRule(topPiece, primaryBottom)
    : 'Balanced 1:2 Rule-of-Thirds couture drape with clean waist definition';

  let summaryVi = 'Tỉ lệ vàng 1:2 (Rule of Thirds) · Chuẩn hóa phom thực tế & cân bằng độ phồng trên/dưới.';
  if (topPiece && primaryBottom) {
    if (topPiece.profile.directive === 'FULL_TUCK') {
      summaryVi = `Tư duy Stylist: Đóng thùng gọn "${topPiece.it.name}" vào "${primaryBottom.it.name}" theo đúng ghi chú món đồ để kéo dài chân tỉ lệ 1:2.`;
    } else if (topPiece.profile.directive === 'BOYFRIEND_UNTUCKED') {
      summaryVi = `Tư duy Stylist: Thả vạt "${topPiece.it.name}" tự nhiên theo phong cách Boyfriend 2:1 đúng ghi chú món đồ.`;
    } else if (topPiece.profile.volume === 'OVERSIZED' && primaryBottom.profile.volume === 'OVERSIZED') {
      summaryVi = `Tư duy Stylist: Áo và quần đều phom rộng — tự động sơ vin nửa vạt trước (French Tuck) và xắn nhẹ tay áo để mở khóa vòng eo 1/3.`;
    } else {
      summaryVi = `Tư duy Stylist: Cân bằng phom "${topPiece.it.name}" (${topPiece.profile.volume === 'FITTED' ? 'ôm gọn' : 'thoải mái'}) cùng "${primaryBottom.it.name}" theo tỉ lệ 1:2.`;
    }
  }

  return {
    mode: 'SINGLE_STYLE',
    singleInstruction: singleRule,
    summaryVi,
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
        HEAD: 'Fit naturally onto the sculpted faceless mannequin head crown at an editorial angle',
        NECK: 'Drape or fasten cleanly around the mannequin neck/collarbone',
        UPPER: 'Dress onto the mannequin upper torso and articulated arms with realistic sleeve drape',
        DRESS: 'Dress full-length onto the mannequin torso draping naturally over hips and legs',
        WAIST: 'Fasten securely around the narrowest 1/3 natural waist point OVER the top/dress',
        LOWER: 'Fit onto the mannequin high waist, hips, and sculpted legs with authentic trouser/skirt drape (no pole blocking the legs)',
        FOOT: 'Place cleanly on/at the mannequin ankles on the studio plinth',
        SIDE: 'Hang naturally from the articulated forearm/shoulder or display on the plinth beside the mannequin'
      };

      const normalizedBlock = selected
        .map((s, idx) => `- Item #${idx + 1} [${s.zone} — ${s.cat}]: "${s.it.name}"${s.it.color ? `, exact color: ${s.it.color}` : ''}${s.it.note ? `, stylist note: ${s.it.note}` : ''}. Placement: ${zonePlacementGuide[s.zone] || 'On mannequin'}.`)
        .join('\n');

      const prompt = isDual
        ? `Use Reference Image #1 as the EXACT Twin-Mannequin studio blueprint (TWO sculpted beige-linen articulated couture mannequins standing side-by-side on circular plinths labeled STYLE 01 on the left and STYLE 02 on the right, against the warm cream studio backdrop).

Execute a two-stage 1:1 garment normalization and Dual-Style Haute Lookbook styling:

STAGE 1 — 1:1 GARMENT & ACCESSORY SHAPE NORMALIZATION:
Extract every item (${selected.length} items total) from the reference boards. Remove any human body, hands, hangers, or background from source photos while preserving each item's exact 1:1 silhouette, neckline, collar, sleeve/leg cut, fabric texture, pattern, and color:
${normalizedBlock}

STAGE 2 — DUAL-STYLE EDITORIAL STYLING ON THE TWIN MANNEQUINS (RULE OF THIRDS 1:2 & SILHOUETTE COUNTERBALANCE):
Render BOTH mannequins side-by-side in one cohesive luxury lookbook frame, showcasing TWO distinct fashion styling variations:
- ${stylingPlan.style1.instruction} (See Reference Image #2: STYLE 01 OUTFIT).
- ${stylingPlan.style2.instruction} (See Reference Image #3: STYLE 02 OUTFIT).
${stylingPlan.accessories.length ? `- Include all shared accessories (${stylingPlan.accessories.map(a => `"${a.it.name}" [${a.zone}]`).join(', ')}) positioned accurately on/around the mannequins.` : ''}
- Keep faceless matte-linen couture mannequins with articulated arms and sculpted legs (NO human skin, NO real face, NO hair, NO extra unrequested clothing).`
        : `Use Reference Image #1 as the EXACT articulated couture mannequin blueprint (preserve its matte beige-linen torso, articulated atelier arms, sculpted legs on the circular floor plinth, front camera angle, and warm cream studio backdrop).

Execute a two-stage 1:1 garment shape normalization and fashion-theory styling assembly:

STAGE 1 — 1:1 GARMENT & ACCESSORY SHAPE NORMALIZATION:
Extract every listed item (${selected.length} items total) from the reference images/boards. Strip away any human body, hands, hangers, or background from source photos, locking each item's exact 1:1 silhouette, neckline, sleeve/leg cut, fabric texture, and color shade:
${normalizedBlock}

STAGE 2 — COUTURE STYLING & MULTI-ACCESSORY ASSEMBLY (RULE OF THIRDS 1:2 & VOLUME BALANCE):
Dress ALL ${selected.length} normalized items from Stage 1 onto the articulated mannequin from Reference Image #1:
- Fashion Styling Technique: ${stylingPlan.singleInstruction}.
- Every single listed item (${selected.map(s => s.it.name).join(', ')}) MUST be clearly visible in its designated anatomical zone.
- Trousers/shorts/skirts must drape naturally over the mannequin's sculpted hips and legs; sleeves must follow the articulated arms with natural fabric folds.
- Keep faceless matte-linen couture mannequin (NO human face, NO real skin, NO hair, NO unrequested items).`;

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
