import { playPassFeedback, playFailFeedback } from './audioFeedback.js';
import { CONFIG } from './config.js';

// ── Supabase 직접 fetch (AbortController 5초 타임아웃) ──
async function sbFetch(path, options = {}) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(CONFIG.SUPABASE_URL + '/rest/v1/' + path, {
      ...options,
      headers: {
        'apikey': CONFIG.SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + CONFIG.SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    clearTimeout(tid);
    if (res.status === 204) return { data: [], error: null };
    const data = await res.json();
    if (!res.ok) return { data: null, error: new Error(data?.message || res.statusText) };
    return { data, error: null };
  } catch (e) {
    clearTimeout(tid);
    return { data: null, error: e };
  }
}

// ── 상태 ──
// currentMapping : 단일 매핑 (FROM 직접 스캔 또는 품번→매핑 1개)
// allMappings    : 복수 매핑 (품번→매핑 여러 개)
let state = {
  screen: 'STEP1',
  currentMapping: null,
  allMappings: null,
  passResult: null,
  step3FailScan: null,
};

// ── 현재 스텝 핸들러 ──
let _stepHandler = null;

// ──────────────────────────────────────────
// 전역 스캔 캡처 (포커스 없어도 동작)
// ──────────────────────────────────────────
document.addEventListener('touchstart', () => {
  const input = document.getElementById('scanInput');
  if (input && !input.disabled) input.focus();
}, { passive: true });

let _gBuf = '';
let _gTimer = null;
document.addEventListener('keydown', e => {
  if (document.activeElement?.id === 'scanInput') return;
  if (!_stepHandler) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  if (e.key === 'Enter' || e.key === 'Tab' || e.keyCode === 13 || e.keyCode === 9) {
    e.preventDefault();
    const val = _gBuf.trim();
    _gBuf = '';
    clearTimeout(_gTimer);
    if (val) { _setScanInputVal(''); _stepHandler(val); }
    return;
  }
  if (e.key.length === 1) {
    _gBuf += e.key;
    clearTimeout(_gTimer);
    _gTimer = setTimeout(() => { _gBuf = ''; _setScanInputVal(''); }, 500);
    _setScanInputVal(_gBuf);
  }
});

function _setScanInputVal(v) {
  const el = document.getElementById('scanInput');
  if (el) el.value = v;
}

// ──────────────────────────────────────────
// GS1 QR 품번 추출
// ──────────────────────────────────────────
function parseItemCode(raw) {
  const normalized = raw.replace(/\x1d/g, ' ');
  for (const seg of normalized.split(' ').reverse()) {
    const clean = seg.trim();
    const dash = clean.indexOf('-');
    if (dash === -1) continue;
    const idx = clean.lastIndexOf('91', dash);
    if (idx !== -1) return clean.substring(idx + 2);
  }
  return normalized.split(' ')[0].trim();
}

// ──────────────────────────────────────────
// 렌더러
// ──────────────────────────────────────────
const app = document.getElementById('app');

function render() {
  _stepHandler = null;
  document.body.className = '';
  switch (state.screen) {
    case 'STEP1':      renderStep1();     break;
    case 'STEP3':      renderStep3();     break;
    case 'STEP3_FAIL': renderStep3Fail(); break;
    case 'PASS':       renderPass();      break;
  }
}

function scanInput(placeholder = 'QR 스캔 대기 중...') {
  return `<input type="text" class="scan-input" id="scanInput"
    placeholder="${placeholder}"
    inputmode="none"
    autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">`;
}

function dots(active) {
  return `<div class="step-dots">
    <div class="dot${active >= 1 ? ' active' : ''}"></div>
    <div class="dot${active >= 2 ? ' active' : ''}"></div>
  </div>`;
}

// ── STEP 1: 품번 또는 FROM 로케이션 스캔 ──
function renderStep1() {
  app.innerHTML = `
    <div class="app-header">
      ${dots(1)}
      <span class="step-label">STEP 1</span>
    </div>
    <div class="guide-text">품번 또는 로케이션 QR을<br>스캔하세요</div>
    ${scanInput()}
    <div id="errorBanner" class="error-banner"></div>
    <div class="spacer"></div>
  `;
  bindScan(handleStep1Scan);
}

// ── STEP 2 (TO 로케이션 스캔): 단일 매핑 또는 복수 매핑 모두 처리 ──
function renderStep3() {
  let itemCode, fromContent, toLines, toDisplayText;

  if (state.allMappings) {
    // 품번 스캔 → 복수 매핑
    itemCode = state.allMappings[0].item_code;
    fromContent = state.allMappings.map(m => `<div>${esc(m.from_location)}</div>`).join('');
    const allTo = [...new Set(state.allMappings.flatMap(m => m.to_locations))];
    toLines = allTo.map(l => `<div>${esc(l)}</div>`).join('');
    toDisplayText = state.allMappings.map(m => m.to_display).join(', ');
  } else {
    // 단일 매핑 (FROM 직접 스캔 또는 품번→1개)
    const m = state.currentMapping;
    itemCode = m.item_code;
    fromContent = esc(m.from_location);
    toLines = m.to_locations.map(l => `<div>${esc(l)}</div>`).join('');
    toDisplayText = m.to_display;
  }

  app.innerHTML = `
    <div class="app-header">
      ${dots(2)}
      <span class="step-label">STEP 2</span>
      <span class="sub-text" style="margin-left:8px">품번: ${esc(itemCode)}</span>
    </div>
    <div class="from-to">
      <div class="location-box from-box">
        <div style="font-size:13px;opacity:0.75;margin-bottom:4px">FROM</div>
        ${fromContent}
      </div>
      <div class="arrow">→</div>
      <div class="location-box to-box">
        <div style="font-size:13px;opacity:0.6;margin-bottom:4px">TO</div>
        ${toLines}
      </div>
    </div>
    <div class="sub-text">이동 로케이션 QR을 스캔하세요</div>
    ${scanInput()}
    <div class="spacer"></div>
    <button class="btn-reset" id="resetBtn">← 처음부터</button>
  `;
  bindScan(handleStep3Scan);
  document.getElementById('resetBtn').addEventListener('click', resetToStep1);
}

function renderStep3Fail() {
  document.body.classList.add('status-fail');

  let itemCode, toDisplay;
  if (state.allMappings) {
    itemCode = state.allMappings[0].item_code;
    toDisplay = state.allMappings.map(m => m.to_display).join(', ');
  } else {
    itemCode = state.currentMapping.item_code;
    toDisplay = state.currentMapping.to_display;
  }

  app.innerHTML = `
    <div class="app-header">
      ${dots(2)}
      <span class="step-label">STEP 2</span>
      <span class="sub-text" style="margin-left:8px">품번: ${esc(itemCode)}</span>
    </div>
    <div class="result-icon">🚫</div>
    <div class="result-detail">잘못된 적치 위치!</div>
    <div class="fail-detail">
      정위치: ${esc(toDisplay)}<br>
      스캔됨: ${esc(state.step3FailScan)}
    </div>
    <div class="sub-text" style="text-align:center">올바른 로케이션 QR을 스캔하세요</div>
    ${scanInput()}
    <div class="spacer"></div>
    <button class="btn-reset" id="resetBtn">← 처음부터</button>
  `;
  bindScan(handleStep3Scan);
  document.getElementById('resetBtn').addEventListener('click', resetToStep1);
}

function renderPass() {
  document.body.classList.add('status-pass');
  app.innerHTML = `
    <div class="spacer"></div>
    <div class="result-icon">✅</div>
    <div class="result-detail">적치 완료!</div>
    <div class="result-detail" style="font-size:20px;margin-top:10px">
      ${esc(state.passResult.from)} → ${esc(state.passResult.to)}
    </div>
    <div class="spacer"></div>
    <button class="btn-next" id="nextBtn">다음 작업 →</button>
  `;
  document.getElementById('nextBtn').addEventListener('click', resetToStep1);
}

// ──────────────────────────────────────────
// 입력창 바인딩
// ──────────────────────────────────────────
function bindScan(handler) {
  _stepHandler = handler;
  const input = document.getElementById('scanInput');
  if (!input) return;

  input.focus();

  input.addEventListener('keydown', e => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'Enter' || e.key === 'Tab' || e.keyCode === 13 || e.keyCode === 9) {
      e.preventDefault();
      submitScan(input, handler);
    }
  });

  let _debounce = null;
  input.addEventListener('input', () => {
    clearTimeout(_debounce);
    _debounce = setTimeout(() => {
      if (input.value.trim()) submitScan(input, handler);
    }, 300);
  });

  input.addEventListener('blur', () => {
    setTimeout(() => {
      const cur = document.getElementById('scanInput');
      if (cur && !cur.disabled) cur.focus();
    }, 100);
  });
}

function submitScan(input, handler) {
  const val = input.value.trim();
  input.value = '';
  if (val) handler(val);
}

// ── 초기화 ──
function resetToStep1() {
  state = {
    screen: 'STEP1',
    currentMapping: null,
    allMappings: null,
    passResult: null,
    step3FailScan: null,
  };
  render();
}

// ── STEP 1 핸들러 ──
async function handleStep1Scan(rawValue) {
  const value = parseItemCode(rawValue);
  const input = document.getElementById('scanInput');
  if (input) {
    input.disabled = true;
    input.placeholder = '⏳ 조회 중...';
    input.value = '';
  }

  const safe = value.replace(/[%_\\]/g, '\\$&');
  const enc = encodeURIComponent(safe);

  const [byFrom, byItem] = await Promise.all([
    withRetry(() => sbFetch(
      `item_mappings?select=*&from_location=ilike.${enc}&status=eq.active&limit=1`
    )),
    withRetry(() => sbFetch(
      `item_mappings?select=*&item_code=ilike.${enc}&status=eq.active`
    )),
  ]);

  if (byFrom.error && byItem.error) {
    showStep1Error(input, '❌ 서버 연결 실패\n잠시 후 다시 스캔하세요');
    return;
  }

  // Case 2: FROM 로케이션 직접 스캔 → 바로 TO 스캔
  if (byFrom.data?.length > 0) {
    state.currentMapping = byFrom.data[0];
    state.screen = 'STEP3';
    render();
    return;
  }

  // Case 1: 품번 스캔 → FROM 스캔 없이 바로 TO 스캔
  if (byItem.data?.length > 0) {
    if (byItem.data.length === 1) {
      state.currentMapping = byItem.data[0];
    } else {
      state.allMappings = byItem.data;
    }
    state.screen = 'STEP3';
    render();
    return;
  }

  const debugMsg = rawValue !== value
    ? `매핑 없음\n스캔됨: ${value}\n(QR 원본: ${rawValue})`
    : `매핑 없음\n스캔됨: ${rawValue}`;
  showStep1Error(input, debugMsg);
}

function showStep1Error(input, msg) {
  if (input) { input.disabled = false; input.placeholder = 'QR 스캔 대기 중...'; input.value = ''; input.focus(); }
  const banner = document.getElementById('errorBanner');
  if (!banner) return;
  banner.textContent = msg;
  banner.classList.add('visible');
  setTimeout(() => banner.classList.remove('visible'), 7000);
}

// ── TO 로케이션 스캔 핸들러 ──
async function handleStep3Scan(value) {
  const input = document.getElementById('scanInput');
  if (input) input.disabled = true;

  let mapping, isPass;

  if (state.allMappings) {
    // 복수 매핑: 스캔된 TO가 어느 매핑에 속하는지 찾기
    const matched = state.allMappings.find(m =>
      m.to_locations.some(loc => loc.toLowerCase() === value.toLowerCase())
    );
    isPass = !!matched;
    mapping = matched ?? state.allMappings[0]; // FAIL 로그는 첫 번째 매핑으로
  } else {
    mapping = state.currentMapping;
    isPass = mapping.to_locations.some(
      loc => loc.toLowerCase() === value.toLowerCase()
    );
  }

  sbFetch('placement_logs', {
    method: 'POST',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      mapping_id:    mapping.id,
      item_code:     mapping.item_code,
      from_location: mapping.from_location,
      scanned_to:    value,
      to_display:    mapping.to_display,
      result:        isPass ? 'pass' : 'fail',
      pda_ua:        navigator.userAgent,
    }),
  }).then(({ error }) => {
    if (error) console.warn('로그 저장 실패:', error.message);
  });

  if (isPass) {
    playPassFeedback();
    state.passResult = { from: mapping.from_location, to: value };
    state.screen = 'PASS';
  } else {
    playFailFeedback();
    state.step3FailScan = value;
    state.screen = 'STEP3_FAIL';
  }
  render();
}

// ── 재시도 래퍼 (4초 타임아웃, 2회) ──
async function withRetry(fn, retries = 2) {
  const timeout = () => new Promise(r =>
    setTimeout(() => r({ data: null, error: new Error('timeout') }), 4000)
  );
  for (let i = 0; i < retries; i++) {
    const result = await Promise.race([
      fn().catch(e => ({ data: null, error: e })),
      timeout(),
    ]);
    if (!result.error) return result;
    if (i < retries - 1) await new Promise(r => setTimeout(r, 300));
  }
  return { data: null, error: new Error('네트워크 오류') };
}

// ── XSS 방지 ──
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const style = document.createElement('style');
style.textContent = '.error-banner { white-space: pre-line; }';
document.head.appendChild(style);

render();
