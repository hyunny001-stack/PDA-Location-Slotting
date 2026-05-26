import { supabase } from './supabaseClient.js';
import { playPassFeedback, playFailFeedback } from './audioFeedback.js';

// ── 상태 ──
let state = {
  screen: 'STEP1',        // STEP1 | STEP2 | STEP2_FAIL | STEP3 | STEP3_FAIL | PASS
  scannedItemCode: null,  // 품번 QR로 진입했을 때의 품번값
  allFromMappings: [],    // 품번에 속한 active 매핑 전체
  currentMapping: null,   // 특정된 매핑 행
  passResult: null,       // { from, to } — PASS 화면 표시용
  step2FailScan: null,    // STEP2 FAIL 시 스캔됐던 값
  step3FailScan: null,    // STEP3 FAIL 시 스캔됐던 값
};

const app = document.getElementById('app');

// ── 렌더러 ──
function render() {
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
    <input type="text" class="scan-input" id="scanInput"
      placeholder="스캔 또는 직접 입력"
      autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
    <div id="errorBanner" class="error-banner"></div>
    <div class="spacer"></div>
  `;
  bindInput('scanInput', handleStep1Scan);
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
    <input type="text" class="scan-input" id="scanInput"
      placeholder="스캔 또는 직접 입력"
      autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
    <div class="spacer"></div>
    <button class="btn-reset" id="resetBtn">← 처음부터</button>
  `;
  bindInput('scanInput', handleStep2Scan);
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
    <input type="text" class="scan-input" id="scanInput"
      placeholder="스캔 또는 직접 입력"
      autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
    <div class="spacer"></div>
    <button class="btn-reset" id="resetBtn">← 처음부터</button>
  `;
  bindInput('scanInput', handleStep2Scan);
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
    <input type="text" class="scan-input" id="scanInput"
      placeholder="스캔 또는 직접 입력"
      autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
    <div class="spacer"></div>
    <button class="btn-reset" id="resetBtn">← 처음부터</button>
  `;
  bindInput('scanInput', handleStep3Scan);
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
    <input type="text" class="scan-input" id="scanInput"
      placeholder="스캔 또는 직접 입력"
      autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
    <div class="spacer"></div>
    <button class="btn-reset" id="resetBtn">← 처음부터</button>
  `;
  bindInput('scanInput', handleStep3Scan);
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

// ── 입력 바인딩 ──
function bindInput(id, handler) {
  const input = document.getElementById(id);
  if (!input) return;

  // 자동 포커스
  input.focus();

  // PDA 스캐너는 Enter(13) 또는 Tab(9) 으로 전송 종료
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === 'Tab' || e.keyCode === 13 || e.keyCode === 9) {
      e.preventDefault();
      const val = input.value.trim();
      if (val) {
        input.value = '';
        handler(val);
      }
    }
  });

  // 포커스가 빠져나가면 즉시 복귀 (PDA 전용 — 의도치 않은 블러 방지)
  input.addEventListener('blur', () => {
    setTimeout(() => {
      const current = document.getElementById(id);
      if (current) current.focus();
    }, 80);
  });
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
async function handleStep1Scan(value) {
  const input = document.getElementById('scanInput');
  if (input) input.disabled = true;

  // ILIKE = 대소문자 무시 정확 일치 (% 와일드카드 이스케이프 후 사용)
  const safe = value.replace(/[%_\\]/g, '\\$&');

  // from_location 조회와 item_code 조회를 병렬로 실행
  const [byFrom, byItem] = await Promise.all([
    withRetry(() =>
      supabase
        .from('item_mappings')
        .select('*')
        .ilike('from_location', safe)
        .eq('status', 'active')
        .limit(1)
    ),
    withRetry(() =>
      supabase
        .from('item_mappings')
        .select('*')
        .ilike('item_code', safe)
        .eq('status', 'active')
    ),
  ]);

  // 네트워크 오류 처리
  if (byFrom.error && byItem.error) {
    showStep1Error(input, '네트워크 오류. 잠시 후 다시 스캔하세요.');
    return;
  }

  // from_location 우선 판단
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

  // 매핑 없음
  showStep1Error(input, '매핑 정보 없음. 관리자에게 문의하세요.');
}

function showStep1Error(input, msg) {
  if (input) { input.disabled = false; input.focus(); }
  const banner = document.getElementById('errorBanner');
  if (!banner) return;
  banner.textContent = msg;
  banner.classList.add('visible');
  setTimeout(() => banner.classList.remove('visible'), 3500);
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

  // 로그 저장 (비동기, UI 블락 없음)
  supabase.from('placement_logs').insert({
    mapping_id:    mapping.id,
    item_code:     mapping.item_code,
    from_location: mapping.from_location,
    scanned_to:    value,
    to_display:    mapping.to_display,
    result:        isPass ? 'pass' : 'fail',
    pda_ua:        navigator.userAgent,
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

// ── 재시도 래퍼 ──
async function withRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const result = await fn().catch(e => ({ data: null, error: e }));
    if (!result.error) return result;
    if (i < retries - 1) await new Promise(r => setTimeout(r, 800 * (i + 1)));
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

// ── 초기 렌더 ──
render();
