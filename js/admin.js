import { supabase } from './supabaseClient.js';

// SheetJS는 admin.html에서 script 태그로 로드
const XLSX = window.XLSX;

// parsedRows: 엑셀 행 단위 { item_code, from_location, to_location, qty, error }
let parsedRows = [];

// ── DOM 참조 ──
const tabBtns      = document.querySelectorAll('.tab-btn');
const tabPanels    = document.querySelectorAll('.tab-panel');
const dropzone     = document.getElementById('dropzone');
const fileInput    = document.getElementById('fileInput');
const previewSec   = document.getElementById('previewSection');
const previewBody  = document.getElementById('previewBody');
const saveBtn      = document.getElementById('saveBtn');
const saveFeedback = document.getElementById('saveFeedback');
const dashBody      = document.getElementById('dashboardBody');
const statusFilter  = document.getElementById('statusFilter');
const refreshBtn    = document.getElementById('refreshBtn');
const bulkDeleteBtn  = document.getElementById('bulkDeleteBtn');
const excelDownBtn   = document.getElementById('excelDownBtn');
const checkAll       = document.getElementById('checkAll');

let dashboardData = [];

// ── 탭 전환 ──
tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    tabBtns.forEach(b => b.classList.toggle('active', b === btn));
    tabPanels.forEach(p => p.classList.toggle('active', p.id === target));
    if (target === 'dashboard') loadDashboard();
  });
});

// ── 템플릿 다운로드 ──
document.getElementById('templateBtn').addEventListener('click', () => {
  const ws = XLSX.utils.aoa_to_sheet([
    ['품번', '현재 로케이션', '이동 로케이션', '수량'],
    ['A', 'TEMP_LOC', 'AM-01-101', 150],
    ['A', 'TEMP_LOC', 'AM-01-102', 150],
    ['A', 'TEMP_LOC', 'AM-01-103', 200],
    ['B', 'TEMP_LOC', 'AM-02-201', 100],
    ['B', 'TEMP_LOC', 'AM-02-202', 100],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '매핑');
  XLSX.writeFile(wb, '로케이션_매핑_템플릿.xlsx');
});

// ── 파일 업로드 ──
dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});
dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
  fileInput.value = '';
});

function handleFile(file) {
  const reader = new FileReader();
  reader.onload = e => {
    const wb = XLSX.read(e.target.result, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    processRows(raw);
  };
  reader.readAsArrayBuffer(file);
}

// ── 엑셀 파싱: 1행 = TO 로케이션 1개 ──
function processRows(raw) {
  const dataRows = raw.slice(1).filter(r => r.some(c => String(c).trim()));
  const seen = new Set(); // (item_code|from_location|to_location) 중복 검사

  parsedRows = dataRows.map(r => {
    const item_code     = String(r[0] ?? '').trim();
    const from_location = String(r[1] ?? '').trim();
    const to_location   = String(r[2] ?? '').trim();
    const qty           = parseInt(r[3], 10);

    let error = null;
    if (!item_code)           error = '품번 누락';
    else if (!from_location)  error = '현재 로케이션 누락';
    else if (!to_location)    error = '이동 로케이션 누락';
    else if (to_location.includes('~')) error = '범위 형식 불가 — 로케이션 1개씩 입력하세요';
    else if (isNaN(qty) || qty < 1)    error = '수량은 1 이상 정수여야 합니다';
    else {
      const key = `${item_code}|${from_location}|${to_location.toLowerCase()}`;
      if (seen.has(key)) error = '동일 TO 로케이션 중복';
      else seen.add(key);
    }

    return { item_code, from_location, to_location, qty: isNaN(qty) ? 0 : qty, error };
  });

  renderPreview();
}

function renderPreview() {
  previewSec.style.display = 'block';
  previewBody.innerHTML = '';
  saveFeedback.textContent = '';

  let hasError = false;
  for (const row of parsedRows) {
    if (row.error) hasError = true;
    const tr = document.createElement('tr');
    if (row.error) tr.classList.add('row-error');
    tr.innerHTML = `
      <td>${esc(row.item_code)}</td>
      <td>${esc(row.from_location)}</td>
      <td>${esc(row.to_location)}</td>
      <td>${row.error ? '-' : esc(String(row.qty))}</td>
      <td>${row.error ? `⚠️ ${esc(row.error)}` : '✅'}</td>
    `;
    previewBody.appendChild(tr);
  }

  saveBtn.disabled = hasError || parsedRows.length === 0;
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Supabase 저장: 같은 (품번+FROM)끼리 묶어서 1행으로 upsert ──
saveBtn.addEventListener('click', async () => {
  saveBtn.disabled = true;
  saveBtn.textContent = '저장 중…';
  saveFeedback.textContent = '';

  // (item_code, from_location) 기준으로 그룹핑
  const groupMap = new Map();
  for (const r of parsedRows) {
    const key = `${r.item_code}|${r.from_location}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        item_code:     r.item_code,
        from_location: r.from_location,
        to_locations:  [],
        to_quantities: [],
      });
    }
    const g = groupMap.get(key);
    g.to_locations.push(r.to_location);
    g.to_quantities.push(r.qty);
  }

  const rows = [...groupMap.values()].map(g => ({
    item_code:     g.item_code,
    from_location: g.from_location,
    to_locations:  g.to_locations,
    to_quantities: g.to_quantities,
    to_display:    g.to_locations.join(', '),
    status:        'active',
    updated_at:    new Date().toISOString(),
  }));

  const { error } = await supabase
    .from('item_mappings')
    .upsert(rows, { onConflict: 'item_code,from_location' });

  saveBtn.textContent = '전체 저장';
  if (error) {
    saveFeedback.textContent = '저장 실패: ' + error.message;
    saveFeedback.className = 'feedback error';
    saveBtn.disabled = false;
  } else {
    saveFeedback.textContent = `✅ ${rows.length}건 저장 완료 (총 ${parsedRows.length}개 로케이션)`;
    saveFeedback.className = 'feedback success';
  }
});

// ── 체크박스 선택 상태 갱신 ──
function updateBulkDeleteBtn() {
  const checked = dashBody.querySelectorAll('.row-check:checked').length;
  bulkDeleteBtn.disabled = checked === 0;
  bulkDeleteBtn.textContent = checked > 0 ? `선택 삭제 (${checked})` : '선택 삭제';
}

checkAll.addEventListener('change', () => {
  dashBody.querySelectorAll('.row-check').forEach(cb => { cb.checked = checkAll.checked; });
  updateBulkDeleteBtn();
});

bulkDeleteBtn.addEventListener('click', async () => {
  const checked = [...dashBody.querySelectorAll('.row-check:checked')];
  if (!checked.length) return;
  const ok = confirm(`선택한 이동지시건 ${checked.length}건을 삭제하시겠습니까?\n스캔 이력도 모두 함께 삭제됩니다.`);
  if (!ok) return;

  const ids = checked.map(cb => cb.dataset.id);

  const { error: logErr } = await supabase
    .from('placement_logs')
    .delete()
    .in('mapping_id', ids);
  if (logErr) { alert('이력 삭제 실패: ' + logErr.message); return; }

  const { error: mapErr } = await supabase
    .from('item_mappings')
    .delete()
    .in('id', ids);
  if (mapErr) { alert('이동지시건 삭제 실패: ' + mapErr.message); return; }

  loadDashboard();
});

// ── 대시보드 로드 ──
async function loadDashboard() {
  checkAll.checked = false;
  bulkDeleteBtn.disabled = true;
  bulkDeleteBtn.textContent = '선택 삭제';
  dashBody.innerHTML = '<tr><td colspan="10" class="loading-cell">로딩 중…</td></tr>';

  let query = supabase
    .from('item_mappings')
    .select('*, placement_logs(result, scanned_to)')
    .order('created_at', { ascending: false });

  if (statusFilter.value !== 'all') {
    query = query.eq('status', statusFilter.value);
  }

  const { data, error } = await query;
  if (error) {
    dashBody.innerHTML = `<tr><td colspan="10" class="loading-cell">오류: ${esc(error.message)}</td></tr>`;
    return;
  }
  dashboardData = data;
  excelDownBtn.disabled = data.length === 0;
  renderDashboard(data);
}

function renderDashboard(items) {
  dashBody.innerHTML = '';
  if (!items.length) {
    dashBody.innerHTML = '<tr><td colspan="10" class="loading-cell">데이터 없음</td></tr>';
    return;
  }

  for (const item of items) {
    const logs         = item.placement_logs ?? [];
    const passLogs     = logs.filter(l => l.result === 'pass');
    const fail         = logs.filter(l => l.result === 'fail').length;
    const toLocations  = item.to_locations  ?? [];
    const toQuantities = item.to_quantities ?? [];
    const totalLocs    = toLocations.length;
    const date         = item.created_at ? item.created_at.slice(5, 10) : '-';

    // 완료된 고유 로케이션 Set
    const completedLocs = new Set(passLogs.map(l => (l.scanned_to ?? '').toLowerCase()));
    const pass = completedLocs.size;

    // 이동 총수량: 완료된 로케이션의 수량 합산
    const movedQty = toLocations.reduce((acc, loc, i) => {
      return completedLocs.has(loc.toLowerCase()) ? acc + (toQuantities[i] ?? 0) : acc;
    }, 0);

    // 전체 수량 (참고용)
    const totalQty = toQuantities.reduce((a, b) => a + b, 0);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" class="row-check" data-id="${item.id}"></td>
      <td>${esc(item.item_code)}</td>
      <td>${esc(item.from_location)}</td>
      <td title="${esc(item.to_display)}">${esc(truncate(item.to_display, 30))}</td>
      <td><span class="badge badge-${item.status}">${item.status}</span></td>
      <td class="num moved-qty-num">${totalQty > 0 ? movedQty.toLocaleString() : '-'}</td>
      <td class="num pass-num">${pass} / ${totalLocs}</td>
      <td class="num fail-num">${fail}</td>
      <td>${date}</td>
      <td class="action-cell">
        ${item.status === 'active' ? `
          <button class="btn-sm btn-complete" data-id="${item.id}">완료</button>
          <button class="btn-sm btn-cancel"   data-id="${item.id}">취소</button>
        ` : `
          <button class="btn-sm btn-delete" data-id="${item.id}" data-code="${esc(item.item_code)}" data-from="${esc(item.from_location)}">삭제</button>
        `}
      </td>
    `;
    dashBody.appendChild(tr);
  }

  dashBody.querySelectorAll('.row-check').forEach(cb =>
    cb.addEventListener('change', () => {
      const all = dashBody.querySelectorAll('.row-check');
      checkAll.checked = [...all].every(c => c.checked);
      updateBulkDeleteBtn();
    }));
  dashBody.querySelectorAll('.btn-complete').forEach(btn =>
    btn.addEventListener('click', () => updateStatus(btn.dataset.id, 'completed')));
  dashBody.querySelectorAll('.btn-cancel').forEach(btn =>
    btn.addEventListener('click', () => updateStatus(btn.dataset.id, 'cancelled')));
  dashBody.querySelectorAll('.btn-delete').forEach(btn =>
    btn.addEventListener('click', () => deleteMapping(btn.dataset.id, btn.dataset.code, btn.dataset.from)));
}

function truncate(str, len) {
  return str && str.length > len ? str.slice(0, len) + '…' : (str ?? '');
}

async function deleteMapping(id, itemCode, fromLocation) {
  const ok = confirm(`[${itemCode} / ${fromLocation}] 이동지시건을 삭제하시겠습니까?\n스캔 이력도 모두 함께 삭제됩니다.`);
  if (!ok) return;

  const { error: logErr } = await supabase
    .from('placement_logs')
    .delete()
    .eq('mapping_id', id);

  if (logErr) { alert('이력 삭제 실패: ' + logErr.message); return; }

  const { error: mapErr } = await supabase
    .from('item_mappings')
    .delete()
    .eq('id', id);

  if (mapErr) { alert('이동지시건 삭제 실패: ' + mapErr.message); return; }

  loadDashboard();
}

async function updateStatus(id, status) {
  const { error } = await supabase
    .from('item_mappings')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) { alert('상태 변경 실패: ' + error.message); return; }
  loadDashboard();
}

statusFilter.addEventListener('change', loadDashboard);
refreshBtn.addEventListener('click', loadDashboard);

excelDownBtn.addEventListener('click', () => {
  if (!dashboardData.length) return;

  const rows = dashboardData.map(item => {
    const logs         = item.placement_logs ?? [];
    const passLogs     = logs.filter(l => l.result === 'pass');
    const fail         = logs.filter(l => l.result === 'fail').length;
    const toLocations  = item.to_locations  ?? [];
    const toQuantities = item.to_quantities ?? [];
    const totalLocs    = toLocations.length;
    const completedLocs = new Set(passLogs.map(l => (l.scanned_to ?? '').toLowerCase()));
    const pass = completedLocs.size;
    const movedQty = toLocations.reduce((acc, loc, i) =>
      completedLocs.has(loc.toLowerCase()) ? acc + (toQuantities[i] ?? 0) : acc, 0);
    const totalQty = toQuantities.reduce((a, b) => a + b, 0);
    const date = item.created_at ? item.created_at.slice(0, 10) : '-';

    return {
      '품번':        item.item_code,
      '현재 로케이션': item.from_location,
      '이동 로케이션': item.to_display,
      '상태':        item.status,
      '이동 총수량':  totalQty > 0 ? movedQty : 0,
      'PASS':       `${pass} / ${totalLocs}`,
      'FAIL':       fail,
      '등록일':      date,
    };
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '현황');

  const today = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `로케이션_이동현황_${today}.xlsx`);
});
