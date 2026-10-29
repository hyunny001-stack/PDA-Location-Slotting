import { CONFIG } from './config.js';

// Start screen for the worker: survey → move → putaway. Jobs come from the slotting app
// (prototype-server "PDA로 작업 등록"); its putaway jobs use "입고" as the FROM location.
export const INBOUND_FROM = '입고';

export function summarizeJobs(rows) {
  let moves = 0;
  let putaway = 0;
  for (const row of rows ?? []) {
    if (String(row.from_location ?? '').trim() === INBOUND_FROM) putaway += 1;
    else moves += 1;
  }
  return { moves, putaway };
}

export function menuLinks(config = CONFIG) {
  return [
    { id: 'survey', label: '공로케이션 조사', hint: '빈 로케이션 확인', href: config.SURVEY_URL },
    { id: 'move', label: '로케이션 이동', hint: '자리 비우기 · 잔존재고 이동', href: 'index.html?mode=location-first' },
    { id: 'putaway', label: '입고 적치', hint: '품번 QR 스캔 후 적치', href: 'index.html' },
  ];
}

async function loadActiveJobs() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/item_mappings?select=from_location&status=eq.active`, {
      headers: { apikey: CONFIG.SUPABASE_ANON_KEY, Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}` },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return summarizeJobs(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function render(counts) {
  const countText = (id) => {
    if (id === 'survey') return '';
    if (!counts) return '<span class="menu-count">남은 작업 확인 중…</span>';
    const left = id === 'move' ? counts.moves : counts.putaway;
    return `<span class="menu-count">${left > 0 ? `남은 작업 ${left}건` : '남은 작업 없음'}</span>`;
  };
  document.getElementById('app').innerHTML = `
    <div class="app-header"><span class="step-label">로케이션 작업</span></div>
    <div class="guide-text">작업을 선택하세요</div>
    <nav class="menu-grid">
      ${menuLinks().map((link, index) => `
        <a class="menu-btn" id="menu-${link.id}" href="${esc(link.href)}">
          <span class="menu-step">${index + 1}</span>
          <span class="menu-label">${esc(link.label)}</span>
          <span class="menu-hint">${esc(link.hint)}</span>
          ${countText(link.id)}
        </a>`).join('')}
    </nav>
    <button class="btn-next" id="refreshBtn">남은 작업 새로고침</button>`;
  document.getElementById('refreshBtn').addEventListener('click', start);
}

async function start() {
  render(null);
  const counts = await loadActiveJobs();
  render(counts ?? { moves: '?', putaway: '?' });
}

if (typeof document !== 'undefined') start();
