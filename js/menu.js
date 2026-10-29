import { CONFIG } from './config.js';

// Start screen for the worker: empty-location survey, then location moves. Move jobs come from the
// slotting app (prototype-server "PDA로 작업 등록"). Putaway itself is done in WMS with its own PDA flow.
export function countActiveJobs(rows) {
  return Array.isArray(rows) ? rows.length : 0;
}

export function menuLinks(config = CONFIG) {
  return [
    { id: 'survey', label: '공로케이션 조사', hint: '빈 로케이션 확인', href: config.SURVEY_URL },
    { id: 'move', label: '로케이션 이동', hint: '자리 비우기 · 잔존재고 이동', href: 'index.html?mode=location-first' },
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
    return countActiveJobs(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function render(left) {
  const countText = (id) => {
    if (id !== 'move') return '';
    if (left === null) return '<span class="menu-count">남은 작업 확인 중…</span>';
    if (left === undefined) return '<span class="menu-count">남은 작업을 불러오지 못했습니다</span>';
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
  render((await loadActiveJobs()) ?? undefined);
}

if (typeof document !== 'undefined') start();
