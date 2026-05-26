import { playPassFeedback, playFailFeedback } from './audioFeedback.js';
import { CONFIG } from './config.js';

// ── Supabase 직접 fetch (CDN 의존성 제거, AbortController 타임아웃) ──
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
let state = {
  screen: 'STEP1',
  scannedItemCode: null,
  allFromMappings: [],
  currentMapping: null,
  passResult: null,
  step2FailScan: null,
  step3FailScan: null,
};

// ── 현재 스텝 핸들러 (화면별로 교체) ──
let _stepHandler = null;

// ──────────────────────────────────────────
// 전역 스캔 캡처 (포커스 없어도 동작)
// ──────────────────────────────────────────

// (1) 화면 터치 → 입력창 자동 포커스 (PDA 초기 진입 대응)
document.addEventListener('touchstart', () => {
  const input = document.getElementById('scanInput');
  if (input && !input.disabled) input.focus();
}, { passive: true });

// (2) 입력창 포커스 없을 때 문서 레벨에서 스캐너 입력 캡처
let _gBuf = '';
let _gTimer = null;
document.addEventListener('keydown', e => {
  if (document.activeElement?.id === 'scanInput') return; // 포커스 있으면 bindScan이 담당
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
// QR 품번 추출 함수 (GS1 형식)
// ──────────────────────────────────────────
// GS1 AI 91 (사내품번) 뒤의 값을 추출
// 예) ...91{111117158-0021MX} 920033 → "111117158-0021MX"
// 예) ...91{110102-071018CE} 920016  → "110102-071018CE"
function parseItemCode(raw) {
  // GS1 FNC1 구분자: ASCII 29(\x1d) 또는 공백 모두 허용
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
    case 'STEP1':      renderStep1();      break;
    case 'STEP2':      renderStep2();      break;
    case 'STEP2_FAIL': renderStep2Fail();  break;
    case 'STEP3':      renderStep3();      break;
    case 'STEP3_FAIL': renderStep3Fail();  break;
    case 'PASS':       renderPass();       break;
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
    <div class="dot${active >= 3 ? ' active' : ''}"></div>
  </div>`;
}

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

function renderStep2() {
  const items = state.allFromMappings.map(m => `<li>${esc(m.from_location)}</li>`).join('');
  app.innerHTML = `
    <div class="app-header">
      ${dots(2)}
      <span class="step-label">STEP 2</span>
      <span class="sub-text" style="margin-left:8px">품번: ${esc(state.scannedItemCode)}</span>
    </div>
    <div class="sub-text">📍 픽업 대상 로케이션:</div>
    <ul class="location-list">${items}</ul>
    <div class="sub-text">해당 로케이션 QR을 스캔하세요</div>
    ${scanInput()}
    <div class="spacer"></div>
    <button class="btn-reset" id="resetBtn">← 처음부터</button>
  `;
  bindScan(handleStep2Scan);
  document.getElementById('resetBtn').addEventListener('click', resetToStep1);
}

function renderStep2Fail() {
  document.body.classList.add('status-fail');
  app.innerHTML = `
    <div class="app-header">
      ${dots(2)}
      <span class="step-label">STEP 2</span>
      <span class="sub-text" style="margin-left:8px">품번: ${esc(state.scannedItemCode)}</span>
    </div>
    <div class="result-icon">🚫</div>
    <div class="result-detail">픽업 위치 불일치!</div>
    <div class="fail-detail">
      품번 ${esc(state.scannedItemCode)}의 로케이션이 아닙니다<br>
      스캔됨: ${esc(state.step2FailScan)}
    </div>
    <div class="sub-text" style="text-align:center">올바른 로케이션 QR을 스캔하세요</div>
    ${scanInput()}
    <div class="spacer"></div>
    <button class="btn-reset" id="resetBtn">← 처음부터</button>
  `;
  bindScan(handleStep2Scan);
  document.getElementById('resetBtn').addEventListener('click', resetToStep1);
}

function renderStep3() {
  const toLines = state.currentMapping.to_locations.map(l => `<div>${esc(l)}</div>`).join('');
  app.innerHTML = `
    <div class="app-header">
      ${dots(3)}
      <span class="step-label">STEP 3</span>
      <span class="sub-text" style="margin-left:8px">품번: ${esc(state.currentMapping.item_code)}</span>
    </div>
    <div class="from-to">
      <div class="location-box from-box">
        <div style="font-size:13px;opacity:0.75;margin-bottom:4px">FROM</div>
        ${esc(state.currentMapping.from_location)}
      </div>
      <div class="arrow">→</div>
      <div class="location-box to-box">
        <div style="font-size:13px;opacity:0.75;margin-bottom:4px">TO</div>
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
  app.innerHTML = `
    <div class="app-header">
      ${dots(3)}
      <span class="step-label">STEP 3</span>
      <span class="sub-text" style="margin-left:8px">품번: ${esc(state.currentMapping.item_code)}</span>
    </div>
    <div class="result-icon">🚫</div>
    <div class="result-detail">잘못된 적치 위치!</div>
    <div class="fail-detail">
      정위치: ${esc(state.currentMapping.to_display)}<br>
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
  // PASS 화면에서는 스캔 핸들러 없음 (_stepHandler = null 유지)
}

// ──────────────────────────────────────────
// 입력창 바인딩 (포커스 있을 때 기본 처리)
// ──────────────────────────────────────────
function bindScan(handler) {
  _stepHandler = handler;
  const input = document.getElementById('scanInput');
  if (!input) return;

  input.focus();

  // Enter / Tab keystroke 감지
  input.addEventListener('keydown', e => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'Enter' || e.key === 'Tab' || e.keyCode === 13 || e.keyCode === 9) {
      e.preventDefault();
      submitScan(input, handler);
    }
  });

  // 폴백: 스캐너가 Enter를 keydown으로 보내지 않을 때
  // input 이벤트 후 300ms 내 추가 입력 없으면 자동 제출
  let _debounce = null;
  input.addEventListener('input', () => {
    clearTimeout(_debounce);
    _debounce = setTimeout(() => {
      if (input.value.trim()) submitScan(input, handler);
    }, 300);
  });

  // 포커스 이탈 시 자동 복귀 (버튼 클릭 후 복귀 제외)
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
    scannedItemCode: null,
    allFromMappings: [],
    currentMapping: null,
    passResult: null,
    step2FailScan: null,
    step3FailScan: null,
  };
  render();
}

// ── STEP 1 핸들러 ──
async function handleStep1Scan(rawValue) {
  const value = parseItemCode(rawValue); // QR에서 품번 추출
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

  if (byFrom.data?.length > 0) {
    state.currentMapping = byFrom.data[0];
    state.screen = 'STEP3';
    render();
    return;
  }

  if (byItem.data?.length > 0) {
    state.scannedItemCode = value;
    state.allFromMappings = byItem.data;
    state.screen = 'STEP2';
    render();
    return;
  }

  // 매핑 없음 — 원본 스캔값을 표시해 QR 포맷 파악에 활용
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

// ── STEP 2 핸들러 ──
function handleStep2Scan(value) {
  const match = state.allFromMappings.find(
    m => m.from_location.toLowerCase() === value.toLowerCase()
  );
  if (match) {
    state.currentMapping = match;
    state.screen = 'STEP3';
    render();
  } else {
    playFailFeedback();
    state.step2FailScan = value;
    state.screen = 'STEP2_FAIL';
    render();
  }
}

// ── STEP 3 핸들러 ──
async function handleStep3Scan(value) {
  const input = document.getElementById('scanInput');
  if (input) input.disabled = true;

  const mapping = state.currentMapping;
  const isPass = mapping.to_locations.some(
    loc => loc.toLowerCase() === value.toLowerCase()
  );

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

// ── 재시도 래퍼 (4초 타임아웃, 2회 재시도) ──
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

// ── 오류 배너 CSS 여러 줄 표시 대응 ──
const style = document.createElement('style');
style.textContent = '.error-banner { white-space: pre-line; }';
document.head.appendChild(style);

// ── 초기 렌더 ──
render();
