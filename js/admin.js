import { supabase } from './supabaseClient.js';
import { parseLocations, validateToLocation } from './locationParser.js';

// SheetJS는 admin.html에서 script 태그로 로드
const XLSX = window.XLSX;

let parsedRows = []; // { item_code, from_location, to_display, to_locations, error }

// ── DOM 참조 ──
const tabBtns      = document.querySelectorAll('.tab-btn');
const tabPanels    = document.querySelectorAll('.tab-panel');
const dropzone     = document.getElementById('dropzone');
const fileInput    = document.getElementById('fileInput');
const previewSec   = document.getElementById('previewSection');
const previewBody  = document.getElementById('previewBody');
const saveBtn      = document.getElementById('saveBtn');
const saveFeedback = document.getElementById('saveFeedback');
const dashBody     = document.getElementById('dashboardBody');
const statusFilter = document.getElementById('statusFilter');
const refreshBtn   = document.getElementById('refreshBtn');

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
    ['품번', '현재 로케이션', '이동 로케이션'],
    ['A', 'aa-01-101', 'aa-01-109~111'],
    ['A', 'aa-01-102', 'aa-01-109~111'],
    ['B', 'aa-01-106', 'aa-01-112'],
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

function processRows(raw) {
  const dataRows = raw.slice(1).filter(r => r.some(c => String(c).trim()));
  const seen = new Set();

  parsedRows = dataRows.map(r => {
    const item_code     = String(r[0] ?? '').trim();
    const from_location = String(r[1] ?? '').trim();
    const to_display    = String(r[2] ?? '').trim();

    let error = null;
    if (!item_code)       error = '품번 누락';
    else if (!from_location) error = '현재 로케이션 누락';
    else {
      error = validateToLocation(to_display);
      if (!error) {
        const key = `${item_code}|${from_location}`;
        if (seen.has(key)) error = '중복된 품번+로케이션 조합';
        else seen.add(key);
      }
    }

    const to_locations = error ? [] : parseLocations(to_display);
    return { item_code, from_location, to_display, to_locations, error };
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
      <td>${esc(row.error ? row.to_display : row.to_locations.join(', '))}</td>
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

// ── Supabase 저장 ──
saveBtn.addEventListener('click', async () => {
  saveBtn.disabled = true;
  saveBtn.textContent = '저장 중…';
  saveFeedback.textContent = '';

  const rows = parsedRows.map(r => ({
    item_code:     r.item_code,
    from_location: r.from_location,
    to_locations:  r.to_locations,
    to_display:    r.to_display,
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
    saveFeedback.textContent = `✅ ${rows.length}건 저장 완료`;
    saveFeedback.className = 'feedback success';
  }
});

// ── 대시보드 로드 ──
async function loadDashboard() {
  dashBody.innerHTML = '<tr><td colspan="8" class="loading-cell">로딩 중…</td></tr>';

  let query = supabase
    .from('item_mappings')
    .select('*, placement_logs(result)')
    .order('created_at', { ascending: false });

  if (statusFilter.value !== 'all') {
    query = query.eq('status', statusFilter.value);
  }

  const { data, error } = await query;
  if (error) {
    dashBody.innerHTML = `<tr><td colspan="8" class="loading-cell">오류: ${esc(error.message)}</td></tr>`;
    return;
  }
  renderDashboard(data);
}

function renderDashboard(items) {
  dashBody.innerHTML = '';
  if (!items.length) {
    dashBody.innerHTML = '<tr><td colspan="8" class="loading-cell">데이터 없음</td></tr>';
    return;
  }

  for (const item of items) {
    const logs = item.placement_logs ?? [];
    const pass = logs.filter(l => l.result === 'pass').length;
    const fail = logs.filter(l => l.result === 'fail').length;
    const date = item.created_at ? item.created_at.slice(5, 10) : '-';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(item.item_code)}</td>
      <td>${esc(item.from_location)}</td>
      <td>${esc(item.to_display)}</td>
      <td><span class="badge badge-${item.status}">${item.status}</span></td>
      <td class="num pass-num">${pass}</td>
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

  dashBody.querySelectorAll('.btn-complete').forEach(btn =>
    btn.addEventListener('click', () => updateStatus(btn.dataset.id, 'completed')));
  dashBody.querySelectorAll('.btn-cancel').forEach(btn =>
    btn.addEventListener('click', () => updateStatus(btn.dataset.id, 'cancelled')));
  dashBody.querySelectorAll('.btn-delete').forEach(btn =>
    btn.addEventListener('click', () => deleteMapping(btn.dataset.id, btn.dataset.code, btn.dataset.from)));
}

async function deleteMapping(id, itemCode, fromLocation) {
  const ok = confirm(`[${itemCode} / ${fromLocation}] 작업지서를 삭제하시겠습니까?\n스캔 이력도 모두 함께 삭제됩니다.`);
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

  if (mapErr) { alert('작업지서 삭제 실패: ' + mapErr.message); return; }

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
