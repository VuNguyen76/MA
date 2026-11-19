/**
 * Mai Anh’s Green Closet - Frontend Application Script
 * Tủ đồ ảo & Phối đồ thời trang cá nhân
 */

'use strict';

// =============================================================================
// 1. CẤU HÌNH & HẰNG SỐ DANH MỤC
// =============================================================================
const CATS = ['Áo', 'Quần', 'Chân váy', 'Váy liền', 'Áo khoác', 'Giày dép', 'Túi xách', 'Phụ kiện'];
const SLOTS = ['Áo', 'Quần', 'Chân váy', 'Váy liền', 'Áo khoác', 'Giày dép', 'Túi xách', 'Phụ kiện'];

// Vị trí và góc xoay tương đối cho từng loại trang phục trong Mix & Match Flat-lay
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
  window._toastTimer = setTimeout(() => t.classList.add('hidden'), 2900);
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

// Nén ảnh để tối ưu bộ nhớ trên trình duyệt và di động
async function shrink(f) {
  const data = await fileToDataURL(f);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, 1100 / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const ctx = canvas.getContext('2d');
      if (f.type !== 'image/png') {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL(f.type === 'image/png' ? 'image/png' : 'image/jpeg', f.type === 'image/png' ? undefined : 0.82));
    };
    image.onerror = () => reject(new Error('Ảnh không đọc được'));
    image.src = data;
  });
}

// =============================================================================
// 4. CƠ SỞ DỮ LIỆU INDEXEDDB (OFFLINE-FIRST)
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

let basePersist = async function (store, obj) {
  await req(tx(store, 'readwrite').put(obj));
};

let baseRemove = async function (store, id) {
  await req(tx(store, 'readwrite').delete(id));
};

let persist = async function (store, obj) {
  await basePersist(store, obj);
};

let remove = async function (store, id) {
  await baseRemove(store, id);
};

async function reload() {
  items = await req(tx('items').getAll());
  looks = await req(tx('looks').getAll());
  items.sort((a, b) => b.added - a.added);
  looks.sort((a, b) => b.added - a.added);
  render();
}

// =============================================================================
// 5. RENDER GIAO DIỆN CHÍNH
// =============================================================================
function render() {
  $('count').textContent = items.length + ' món đồ';
  $('savedCount').textContent = '(' + looks.length + ')';
  renderFilters();
  renderCloset();
  renderBoard();
  renderLooks();
}

function renderFilters() {
  const container = $('filters');
  container.innerHTML = ['Tất cả', ...CATS].map(c => `
    <button class="chip ${activeFilter === c ? 'active' : ''}" data-cat="${esc(c)}">
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
    closetEl.innerHTML = `<div class="empty">Chưa có món nào ở đây 🧺<br>Nhấn “Thêm quần áo” để bắt đầu nhé!</div>`;
    return;
  }

  closetEl.innerHTML = shown.map(i => `
    <div class="item" draggable="true" data-id="${esc(i.id)}">
      <img src="${i.photo}" alt="${esc(i.name)}" loading="lazy">
      <div class="info">
        <div class="name" title="${esc(i.name)}">${esc(i.name)}</div>
        <div class="sub">${esc(i.cat)}${i.color ? ' · ' + esc(i.color) : ''}</div>
        <div class="actions">
          <button type="button" class="small add" data-add="${esc(i.id)}">＋ Phối</button>
          <button type="button" class="small" title="Sửa" data-edit="${esc(i.id)}">✎</button>
          <button type="button" class="small" title="Xóa" data-delete="${esc(i.id)}">🗑</button>
        </div>
      </div>
    </div>
  `).join('');

  // Drag & drop cho máy tính
  closetEl.querySelectorAll('[draggable]').forEach(el => {
    el.ondragstart = e => e.dataTransfer.setData('text/plain', el.dataset.id);
  });

  // Nút hành động trực quan (tối ưu cảm ứng di động)
  closetEl.querySelectorAll('[data-add]').forEach(el => {
    el.onclick = () => addToBoard(el.dataset.add);
  });

  closetEl.querySelectorAll('[data-edit]').forEach(el => {
    el.onclick = () => openModal(el.dataset.edit);
  });

  closetEl.querySelectorAll('[data-delete]').forEach(el => {
    el.onclick = () => deleteItem(el.dataset.delete);
  });
}

function addToBoard(id, slot) {
  const it = items.find(x => x.id === id);
  if (!it) return;
  board[slot || it.cat] = id;
  renderBoard();
  toast('Đã thêm vào outfit ✨');
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
          <button type="button" class="slotremove" data-remove="${esc(c)}" title="Bỏ khỏi outfit" aria-label="Bỏ khỏi outfit">×</button>
          <img alt="${esc(it.name)}" src="${it.photo}">
          <div class="slotcaption">${esc(it.name)}</div>
        ` : `
          <div style="font-size:28px;opacity:.27;margin-bottom:4px">＋</div>
          <div class="sub">Thả ảnh vào đây</div>
        `}
      </div>
    `;
  }).join('');

  boardEl.querySelectorAll('.slot').forEach(s => {
    s.ondragover = e => {
      e.preventDefault();
      s.classList.add('dropdrag');
    };
    s.ondragleave = () => s.classList.remove('dropdrag');
    s.ondrop = e => {
      e.preventDefault();
      s.classList.remove('dropdrag');
      const id = e.dataTransfer.getData('text/plain');
      addToBoard(id, s.dataset.slot);
    };
  });

  boardEl.querySelectorAll('[data-remove]').forEach(b => {
    b.onclick = (e) => {
      e.stopPropagation();
      delete board[b.dataset.remove];
      renderBoard();
    };
  });
}

function renderLooks() {
  const grid = $('savedGrid');
  if (!looks.length) {
    grid.innerHTML = '<div class="empty">Chưa lưu outfit nào ♡<br>Qua tab Tủ đồ để mix bộ đầu tiên nha.</div>';
    return;
  }

  grid.innerHTML = looks.map(l => {
    const selected = Object.entries(l.board)
      .map(([slot, id]) => ({ slot, it: items.find(i => i.id === id) }))
      .filter(x => x.it);

    return `
      <article class="lookcard">
        <div class="lookpics">
          ${selected.slice(0, 6).map(x => `
            <img src="${x.it.photo}" title="${esc(x.slot)}: ${esc(x.it.name)}" alt="${esc(x.it.name)}">
          `).join('') || '<div class="placeholder">Chưa có ảnh</div>'}
        </div>
        <div class="lookname">${esc(l.name)}</div>
        <div class="muted">${selected.length} món · ${new Date(l.added).toLocaleDateString('vi-VN')}</div>
        <div class="btnrow" style="margin-top:10px">
          <button type="button" class="small add" data-load="${esc(l.id)}">Mở để phối lại</button>
          <button type="button" class="small" data-del-look="${esc(l.id)}">Xóa</button>
        </div>
      </article>
    `;
  }).join('');

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
      if (!confirm('Xóa outfit này nhé?')) return;
      await remove('looks', b.dataset.delLook);
      await reload();
    };
  });
}

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(x => {
    x.classList.toggle('active', x.dataset.tab === tab);
  });
  $('studio').classList.toggle('hidden', tab !== 'studio');
  $('saved').classList.toggle('hidden', tab !== 'saved');
}

async function deleteItem(id) {
  const i = items.find(x => x.id === id);
  if (!i) return;
  if (!confirm(`Xóa “${i.name}” khỏi tủ đồ? Món này cũng sẽ không hiện trong outfit đã lưu.`)) return;
  await remove('items', id);
  for (let k in board) {
    if (board[k] === id) delete board[k];
  }
  await reload();
}

// =============================================================================
// 6. FLAT-LAY STUDIO (MIX & MATCH KHÔNG DÙNG MANNEQUIN)
// =============================================================================
function selectedPieces() {
  return SLOTS.map(cat => ({ cat, it: items.find(x => x.id === board[cat]) })).filter(x => x.it);
}

function updateMixCount() {
  const x = $('mixCount');
  if (x) x.textContent = selectedPieces().length + ' món';
}

function mixOutfit() {
  const selected = selectedPieces();
  const canvas = $('mixCanvas');
  updateMixCount();

  if (!selected.length) {
    canvas.innerHTML = '';
    canvas.classList.add('empty');
    toast('M chọn ít nhất một món trước nha ♡');
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

  toast('Đã mix ' + selected.length + ' món! 🌿');
}

// =============================================================================
// 7. TÁCH NỀN AI (BACKGROUND REMOVAL ON-DEVICE)
// =============================================================================
let removeBackgroundFn = null;

async function getRemover() {
  if (removeBackgroundFn) return removeBackgroundFn;
  const mod = await import('https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm');
  if (typeof mod.removeBackground !== 'function') throw new Error('Không khởi tạo được AI tách nền');
  removeBackgroundFn = mod.removeBackground;
  return removeBackgroundFn;
}

function updatePreviews() {
  $('previews').innerHTML = photos.map((p, i) => `
    <div class="preview-tile">
      <img src="${p.photo}" alt="Xem trước ảnh ${i + 1}">
      <small>${p.removed ? 'Đã tách nền' : 'Ảnh gốc'}</small>
    </div>
  `).join('');
}

// =============================================================================
// 8. HỘP THOẠI THÊM & SỬA MÓN ĐỒ (MODAL)
// =============================================================================
function openModal(id = null) {
  editId = id;
  photoGeneration++;
  photos = [];
  processing = false;
  restoreRequested = false;
  $('photoInput').value = '';
  $('previews').innerHTML = '';
  $('bgStatus').textContent = '';
  $('submitItem').disabled = false;
  $('autoRemove').checked = true;

  const i = items.find(x => x.id === id);
  $('restoreOriginal').classList.toggle('hidden', !i?.original);
  $('dialogTitle').textContent = id ? 'Sửa món đồ' : 'Thêm quần áo';
  $('itemName').value = i?.name || '';
  $('itemCat').value = i?.cat || 'Áo';
  $('itemColor').value = i?.color || '';
  $('itemSeason').value = i?.season || '';
  $('itemNote').value = i?.note || '';
  $('fileField').querySelector('label').textContent = id ? 'Thay ảnh (nếu muốn)' : 'Ảnh đồ (có thể chọn nhiều ảnh một lúc)';
  $('dialogBack').classList.remove('hidden');
}

function closeModal() {
  photoGeneration++;
  processing = false;
  $('dialogBack').classList.add('hidden');
}

$('photoInput').onchange = async e => {
  const generation = ++photoGeneration;
  const fs = [...e.target.files].slice(0, 40);
  photos = [];
  processing = true;
  $('submitItem').disabled = true;
  $('previews').textContent = 'Đang chuẩn bị ảnh...';

  try {
    for (let j = 0; j < fs.length; j++) {
      if (generation !== photoGeneration) return;
      const f = fs[j];
      if (!f.type.startsWith('image/')) continue;

      $('bgStatus').textContent = `Đang đọc ảnh ${j + 1}/${fs.length}...`;
      const original = await shrink(f);
      let photo = original;
      let removed = false;

      if ($('autoRemove').checked) {
        try {
          $('bgStatus').textContent = `✨ AI đang tách nền ảnh ${j + 1}/${fs.length}. Lần đầu có thể cần tải mô hình...`;
          const removeBg = await getRemover();
          const inputBlob = await (await fetch(original)).blob();
          const outputBlob = await removeBg(inputBlob, {
            model: 'isnet_quint8',
            output: { format: 'image/png', type: 'foreground' }
          });
          photo = await shrink(new File([outputBlob], 'tach-nen.png', { type: 'image/png' }));
          removed = true;
        } catch (err) {
          console.warn('Tách nền thất bại', err);
          $('bgStatus').textContent = '⚠️ AI chưa chạy được (kiểm tra internet). Đã giữ lại ảnh gốc.';
        }
      }

      if (generation !== photoGeneration) return;
      photos.push({ photo, original, removed });
      updatePreviews();
    }

    if (generation === photoGeneration) {
      $('bgStatus').textContent = photos.some(p => p.removed)
        ? `✅ Hoàn tất: ${photos.filter(p => p.removed).length}/${photos.length} ảnh đã tách nền. Có thể lưu vào tủ.`
        : $('autoRemove').checked
          ? '⚠️ Chưa tách được nền. M vẫn có thể lưu ảnh gốc hoặc thử lại khi có internet.'
          : 'Đã chuẩn bị ảnh gốc, không tách nền.';
    }
  } catch (err) {
    $('bgStatus').textContent = 'Không đọc được ảnh: ' + err.message;
  } finally {
    if (generation === photoGeneration) {
      processing = false;
      $('submitItem').disabled = false;
    }
  }
};

$('autoRemove').onchange = () => {
  if (photos.length && !processing) {
    $('bgStatus').textContent = 'Đổi chế độ rồi chọn lại ảnh để áp dụng nha.';
  }
};

$('restoreOriginal').onclick = () => {
  restoreRequested = true;
  $('bgStatus').textContent = 'Sẽ dùng ảnh gốc sau khi bấm Lưu.';
};

$('submitItem').onclick = async () => {
  if (busy || processing) return;

  const name = $('itemName').value.trim();
  const cat = $('itemCat').value;
  const color = $('itemColor').value.trim();
  const season = $('itemSeason').value;
  const note = $('itemNote').value.trim();

  if (!editId && !photos.length) return toast('M chọn ảnh món đồ trước nha!');

  busy = true;
  $('submitItem').disabled = true;

  try {
    if (editId) {
      const old = items.find(x => x.id === editId);
      const newPhoto = photos[0];
      const imgFields = newPhoto
        ? { photo: newPhoto.photo, original: newPhoto.original, removed: newPhoto.removed }
        : restoreRequested && old.original
          ? { photo: old.original, original: old.original, removed: false }
          : {};

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
        await persist('items', {
          id: uuid(),
          name: name ? (photos.length > 1 ? `${name} ${j + 1}` : name) : `${cat} ${items.length + j + 1}`,
          cat,
          color,
          season,
          note,
          ...p,
          added: Date.now() + j
        });
      }
    }

    closeModal();
    await reload();
    toast('Đã cất đồ vào tủ! ♡');
  } catch (e) {
    alert('Không lưu được ảnh. Có thể bộ nhớ trình duyệt đã đầy. Hãy sao lưu và thử ảnh nhỏ hơn.\n' + e.message);
  } finally {
    busy = false;
    $('submitItem').disabled = false;
  }
};

$('saveLook').onclick = async () => {
  const valid = Object.entries(board).filter(([s, id]) => items.some(i => i.id === id));
  if (!valid.length) return toast('Thêm ít nhất một món vào outfit trước nha!');

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
    toast('Đã lưu outfit xinh xẻo! ♡');
  } catch (e) {
    alert('Lưu outfit thất bại: ' + e.message);
  }
};

$('clearBoard').onclick = () => {
  board = {};
  $('lookName').value = '';
  renderBoard();
};

$('search').oninput = renderCloset;
$('uploadBtn').onclick = () => openModal();
$('closeDialog').onclick = closeModal;
$('cancelDialog').onclick = closeModal;
$('dialogBack').onclick = e => {
  if (e.target === $('dialogBack')) closeModal();
};

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
});

document.querySelectorAll('.tab').forEach(b => {
  b.onclick = () => switchTab(b.dataset.tab);
});

$('mixButton').onclick = mixOutfit;

// =============================================================================
// 9. SAO LƯU & KHÔI PHỤC FILE DỰ PHÒNG JSON
// =============================================================================
$('backupBtn').onclick = async () => {
  const payload = {
    app: 'my-little-closet',
    version: 4,
    exportedAt: new Date().toISOString(),
    items,
    looks
  };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tu-do-ao-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Đã tải bản sao lưu 💾');
};

$('restoreBtn').onclick = () => $('restoreInput').click();

$('restoreInput').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'my-little-closet' || !Array.isArray(data.items) || !Array.isArray(data.looks)) {
      throw Error('Không đúng file sao lưu tủ đồ');
    }
    if (!confirm(`Khôi phục ${data.items.length} món và ${data.looks.length} outfit? Dữ liệu từ file sẽ được gộp vào tủ hiện tại.`)) {
      return;
    }
    for (const i of data.items) {
      if (i.id && i.photo && i.cat) await persist('items', i);
    }
    for (const l of data.looks) {
      if (l.id && l.board) await persist('looks', l);
    }
    await reload();
    toast('Khôi phục tủ đồ thành công ♡');
  } catch (err) {
    alert('Khôi phục thất bại: ' + err.message);
  } finally {
    e.target.value = '';
  }
};

// =============================================================================
// 10. ĐỒNG BỘ ĐÁM MÂY GOOGLE SYNC (FIREBASE FIRESTORE)
// =============================================================================
const CLOUD_PRESET = window.CLOUD_PRESET || null;
let firebaseSDK = null;
let cloudApp = null;
let cloudAuth = null;
let cloudDB = null;
let cloudUser = null;
let cloudBusy = false;
let cloudConfigured = false;
let cloudRetryTimer = null;

const CLOUD_PENDING_KEY = 'mai-anh-closet-sync-queue-v1';
const CLOUD_CFG_KEY = 'mai-anh-closet-firebase-v1';

function cloudSyncedKey(store) {
  return 'mai-anh-cloud-seen-' + (cloudUser?.uid || 'guest') + '-' + store;
}

function cloudSeen(store) {
  try {
    return new Set(JSON.parse(localStorage.getItem(cloudSyncedKey(store)) || '[]'));
  } catch {
    return new Set();
  }
}

function cloudSaveSeen(store, set) {
  localStorage.setItem(cloudSyncedKey(store), JSON.stringify([...set]));
}

let CLOUD_CFG = CLOUD_PRESET || (() => {
  try {
    return JSON.parse(localStorage.getItem(CLOUD_CFG_KEY) || 'null');
  } catch {
    return null;
  }
})();

function cloudLog(message, detail = '') {
  $('cloudLabel').textContent = message;
  $('cloudDetail').textContent = detail;
}

function cloudProgress(s = '') {
  $('cloudProgress').textContent = s;
}

function cloudPending() {
  try {
    return JSON.parse(localStorage.getItem(CLOUD_PENDING_KEY) || '[]');
  } catch {
    return [];
  }
}

function cloudQueue(store, id, action) {
  if (!cloudConfigured) return;
  const q = cloudPending().filter(x => !(x.store === store && x.id === id));
  q.push({ store, id, action, when: Date.now() });
  localStorage.setItem(CLOUD_PENDING_KEY, JSON.stringify(q));
  cloudProgress(`⏳ ${q.length} thay đổi chưa đồng bộ`);
  if (cloudUser) cloudSchedule();
}

function cloudSchedule() {
  clearTimeout(cloudRetryTimer);
  cloudRetryTimer = setTimeout(() => {
    cloudSync().catch(e => cloudProgress('⚠ Đồng bộ lỗi: ' + e.message));
  }, 850);
}

function cloudParseConfig(s) {
  const body = s.trim().replace(/^\s*(?:const|let|var)\s+firebaseConfig\s*=\s*/, '').replace(/;\s*$/, '');
  let cfg;
  try {
    cfg = JSON.parse(body);
  } catch {
    const x = body.match(/\{[\s\S]*\}/);
    if (!x) throw Error('Không tìm thấy phần { ... } của firebaseConfig');
    let obj = x[0];
    obj = obj.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
             .replace(/'/g, '"')
             .replace(/,\s*([}\]])/g, '$1');
    cfg = JSON.parse(obj);
  }
  if (!cfg || typeof cfg !== 'object' || !cfg.apiKey || !cfg.authDomain || !cfg.projectId || !cfg.appId) {
    throw Error('Cần đủ apiKey, authDomain, projectId và appId.');
  }
  return cfg;
}

function cloudInfo(s) {
  $('cloudSetupInfo').textContent = s;
}

function cloudDownloadConfigured() {
  const cfg = cloudParseConfig($('cloudConfig').value);
  const html = '<!doctype html>\n' + document.documentElement.outerHTML;
  
  // Hỗ trợ tìm kiếm cả cú pháp window.CLOUD_PRESET và const CLOUD_PRESET
  let mark = 'window.CLOUD_PRESET = null;';
  if (!html.includes(mark)) {
    mark = 'const CLOUD_PRESET = null;';
  }
  if (!html.includes(mark)) {
    throw Error('Không tìm thấy vị trí gắn cấu hình ứng dụng trong index.html');
  }

  const replacement = mark.startsWith('window.')
    ? 'window.CLOUD_PRESET = ' + JSON.stringify(cfg).replace(/</g, '\\u003c') + ';'
    : 'const CLOUD_PRESET = ' + JSON.stringify(cfg).replace(/</g, '\\u003c') + ';';

  const built = html.replace(mark, replacement);
  const blob = new Blob([built], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = 'index.html';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);

  localStorage.setItem(CLOUD_CFG_KEY, JSON.stringify(cfg));
  cloudInfo('✅ Đã tạo index.html chứa cấu hình dự án của m. Đưa file này cùng index.css, index.js lên hosting HTTPS. Sau đó thêm miền web trong Firebase Authentication → Authorized domains.');
}

async function cloudSDK() {
  if (firebaseSDK) return firebaseSDK;
  const [app, auth, firestore] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js')
  ]);
  firebaseSDK = { ...app, ...auth, ...firestore };
  return firebaseSDK;
}

async function cloudInit(cfg) {
  if (cloudConfigured) return;
  const F = await cloudSDK();
  cloudApp = F.initializeApp(cfg, 'mai-anh-closet-' + cfg.projectId);
  cloudAuth = F.getAuth(cloudApp);
  cloudDB = F.getFirestore(cloudApp);
  cloudConfigured = true;
  CLOUD_CFG = cfg;
  cloudLog('Google Sync đã sẵn sàng', 'Bấm Kết nối Google để đăng nhập.');

  F.onAuthStateChanged(cloudAuth, async user => {
    cloudUser = user;
    $('cloudLogout').classList.toggle('hidden', !user);
    $('cloudConnect').textContent = user ? '☁ Đồng bộ ngay' : '☁ Kết nối Google';
    if (user) {
      cloudLog('Đã đăng nhập: ' + (user.email || 'Google'), 'Đang kiểm tra dữ liệu từ cloud...');
      try {
        await cloudSync();
      } catch (e) {
        cloudProgress('⚠ ' + e.message);
      }
    } else {
      cloudLog('Google Sync đã cấu hình', 'Đăng nhập để đồng bộ tủ đồ.');
      cloudProgress('');
    }
  });
}

async function cloudLogin() {
  if (!CLOUD_CFG) {
    $('cloudPanel').classList.remove('hidden');
    cloudInfo('Chưa có cấu hình Firebase. Làm các bước trong bảng này một lần nha.');
    return;
  }
  try {
    await cloudInit(CLOUD_CFG);
    if (cloudUser) {
      await cloudSync();
      return;
    }
    const F = firebaseSDK;
    await F.signInWithPopup(cloudAuth, new F.GoogleAuthProvider());
    $('cloudPanel').classList.add('hidden');
  } catch (e) {
    cloudProgress('⚠ ' + e.message);
    if (e.code === 'auth/unauthorized-domain') {
      alert('Cần thêm tên miền trang web vào Firebase → Authentication → Settings → Authorized domains.');
    } else if (location.protocol === 'file:') {
      alert('Để đăng nhập Google ổn định, m phải mở ứng dụng qua một đường link HTTPS đã đăng lên web, không phải file HTML trong máy.');
    } else {
      alert('Google Sync chưa kết nối: ' + e.message);
    }
  }
}

function cloudDoc(store, id) {
  return firebaseSDK.doc(cloudDB, 'users', cloudUser.uid, store, id);
}

function cloudDownsize(i) {
  const obj = { ...i };
  const bytes = s => new TextEncoder().encode(s || '').length;
  if (bytes(JSON.stringify(obj)) > 850000) {
    delete obj.original;
  }
  // Giới hạn Firestore ~1 MiB; bảo vệ chống tràn bộ nhớ
  if (bytes(JSON.stringify(obj)) > 850000) {
    throw Error('Ảnh ' + (i.name || '') + ' quá lớn để lưu cloud. Hãy dùng ảnh nhỏ hơn; ảnh vẫn được giữ trên máy.');
  }
  return obj;
}

async function cloudSync() {
  if (!cloudUser || cloudBusy) return;
  cloudBusy = true;
  try {
    const F = firebaseSDK;
    const queue = cloudPending();
    cloudProgress('⏳ Đang đồng bộ...');

    for (const change of queue) {
      const target = cloudDoc(change.store, change.id);
      if (change.action === 'delete') {
        await F.deleteDoc(target);
      } else {
        const obj = await req(tx(change.store).get(change.id));
        if (obj) {
          await F.setDoc(target, change.store === 'items' ? cloudDownsize(obj) : obj);
        } else {
          await F.deleteDoc(target);
        }
      }
      const pending = cloudPending();
      localStorage.setItem(CLOUD_PENDING_KEY, JSON.stringify(pending.filter(x => !(x.store === change.store && x.id === change.id && x.when === change.when))));
    }

    for (const store of ['items', 'looks']) {
      const snapshot = await F.getDocs(F.collection(cloudDB, 'users', cloudUser.uid, store));
      const remote = new Map(snapshot.docs.map(x => [x.id, x.data()]));
      const local = await req(tx(store).getAll());
      const localMap = new Map(local.map(x => [x.id, x]));

      for (const [id, obj] of remote) {
        const existing = localMap.get(id);
        if (!existing || (obj.updated || obj.added || 0) > (existing.updated || existing.added || 0)) {
          await localPersist(store, { ...obj, id });
        }
      }

      const seen = cloudSeen(store);
      for (const obj of local) {
        if (!remote.has(obj.id)) {
          if (seen.has(obj.id)) {
            await localRemoveSilent(store, obj.id);
          } else {
            await F.setDoc(cloudDoc(store, obj.id), store === 'items' ? cloudDownsize(obj) : obj);
            remote.set(obj.id, obj);
          }
        }
      }
      cloudSaveSeen(store, new Set(remote.keys()));
    }

    await reload();
    cloudLog('✓ Đã đồng bộ Google', `${cloudUser.email || 'Tài khoản Google'} · ${new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`);
    cloudProgress('✓ Tủ đồ đã lưu trên cloud và trên thiết bị này.');
  } catch (e) {
    cloudLog('⚠ Chưa đồng bộ xong', 'Dữ liệu vẫn lưu trên thiết bị này.');
    cloudProgress('⚠ ' + e.message);
    throw e;
  } finally {
    cloudBusy = false;
  }
}

async function localPersist(store, obj) {
  await req(tx(store, 'readwrite').put(obj));
}

async function localRemoveSilent(store, id) {
  await req(tx(store, 'readwrite').delete(id));
}

// Ghi đè hàm persist và remove để hỗ trợ đồng bộ hàng đợi cloud
persist = async function (store, obj) {
  obj.updated = Date.now();
  await basePersist(store, obj);
  cloudQueue(store, obj.id, 'upsert');
};

remove = async function (store, id) {
  await baseRemove(store, id);
  cloudQueue(store, id, 'delete');
};

// =============================================================================
// 11. ĐĂNG KÝ SỰ KIỆN CLOUD & KHỞI ĐỘNG ỨNG DỤNG
// =============================================================================
$('cloudConnect').onclick = () => cloudLogin();
$('cloudLogout').onclick = async () => {
  if (cloudAuth) await firebaseSDK.signOut(cloudAuth);
};
$('cloudClose').onclick = () => $('cloudPanel').classList.add('hidden');
$('cloudBuild').onclick = () => {
  try {
    cloudDownloadConfigured();
  } catch (e) {
    cloudInfo('⚠ ' + e.message);
  }
};
$('cloudApply').onclick = async () => {
  try {
    const cfg = cloudParseConfig($('cloudConfig').value);
    localStorage.setItem(CLOUD_CFG_KEY, JSON.stringify(cfg));
    await cloudInit(cfg);
    await cloudLogin();
    cloudInfo('Đã kết nối thử. Nhớ tạo file web đã cấu hình và đưa lên hosting.');
  } catch (e) {
    cloudInfo('⚠ ' + e.message);
  }
};

window.addEventListener('online', () => {
  if (cloudUser) cloudSchedule();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && cloudUser) cloudSchedule();
});

if (CLOUD_CFG) {
  cloudInit(CLOUD_CFG).catch(e => cloudProgress('⚠ Không mở được Google Sync: ' + e.message));
}

// Khởi tạo ứng dụng
(async () => {
  try {
    $('itemCat').innerHTML = CATS.map(c => `<option>${c}</option>`).join('');
    db = await openDB();
    await reload();
  } catch (e) {
    document.querySelector('.shell').insertAdjacentHTML(
      'afterbegin',
      '<div class="topnote">⚠️ Trình duyệt đang chặn lưu dữ liệu. Hãy mở file bằng Chrome/Edge bình thường (không ở chế độ ẩn danh). ' + esc(e.message) + '</div>'
    );
  }
})();
