import { playPassFeedback, playFailFeedback } from './audioFeedback.js';
import { CONFIG } from './config.js';
import {
  isExpectedItem,
  isExpectedLocation,
  itemFirstCandidates,
  itemFirstDecision,
  normalizeLocation,
  parseItemCode,
  pendingTargets,
  resolvePdaMode,
} from './taskFlow.js?v=20260910a';

const DEVICE_KEY = 'dio-slotting-device-id-v1';
const CLAIM_REFRESH_MS = 60_000;
const NEXT_TASK_DELAY_MS = 1_200;
const NO_WORK_REFRESH_MS = 5_000;
const MISMATCH_WARNING_MS = 1_500;

async function sbFetch(path, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/${path}`, {
      ...options,
      headers: {
        apikey: CONFIG.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    if (response.status === 204) return { data: [], error: null };
    const text = await response.text();
    const data = text ? JSON.parse(text) : [];
    if (!response.ok) {
      return {
        data: null,
        error: new Error(data?.message || data?.hint || response.statusText),
      };
    }
    return { data, error: null };
  } catch (error) {
    return { data: null, error };
  } finally {
    clearTimeout(timeoutId);
  }
}

function getDeviceId() {
  const stored = localStorage.getItem(DEVICE_KEY);
  if (stored) return stored;
  const generated = globalThis.crypto?.randomUUID?.() ??
    `pda-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(DEVICE_KEY, generated);
  return generated;
}

const deviceId = getDeviceId();
const app = document.getElementById('app');
const startupMode = resolvePdaMode(globalThis.location?.search);
let claimTimer = null;
let noWorkTimer = null;
let failureReturnTimer = null;
let stepHandler = null;
let scanLocked = false;
let state = initialState(startupMode);

function initialState(mode = 'GUIDED') {
  return {
    mode,
    screen: mode === 'ITEM_FIRST' ? 'ITEM_FIRST' : 'LOADING',
    mapping: null,
    itemCandidates: [],
    scannedItemCode: '',
    completedLocations: new Set(),
    failTitle: '',
    failDetail: '',
    failReturn: mode === 'ITEM_FIRST' ? 'ITEM_FIRST' : 'FROM',
    passResult: null,
  };
}

document.addEventListener('touchstart', () => {
  const input = document.getElementById('scanInput');
  if (input && !input.disabled) input.focus();
}, { passive: true });

let globalBuffer = '';
let globalTimer = null;
document.addEventListener('keydown', event => {
  if (scanLocked || document.activeElement?.id === 'scanInput' || !stepHandler) return;
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  if (event.key === 'Enter' || event.key === 'Tab' || event.keyCode === 13 || event.keyCode === 9) {
    event.preventDefault();
    const value = globalBuffer.trim();
    globalBuffer = '';
    clearTimeout(globalTimer);
    if (value) stepHandler(value);
    return;
  }
  if (event.key.length === 1) {
    globalBuffer += event.key;
    clearTimeout(globalTimer);
    globalTimer = setTimeout(() => { globalBuffer = ''; }, 500);
    const input = document.getElementById('scanInput');
    if (input) input.value = globalBuffer;
  }
});

function scanInput(placeholder = 'QR 스캔 대기 중...') {
  return `<input type="text" class="scan-input" id="scanInput"
    placeholder="${placeholder}" inputmode="none"
    autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">`;
}

function disableInteractiveControls() {
  scanLocked = true;
  stepHandler = null;
  globalBuffer = '';
  clearTimeout(globalTimer);
  document.querySelectorAll('button, input').forEach(element => {
    element.disabled = true;
  });
}

function dots(active) {
  return `<div class="step-dots">
    ${[1, 2, 3].map(step => `<div class="dot${active >= step ? ' active' : ''}"></div>`).join('')}
  </div>`;
}

function render() {
  if (state.screen !== 'FAIL') clearFailureReturnTimer();
  stepHandler = null;
  document.body.className = '';
  switch (state.screen) {
    case 'ITEM_FIRST': renderItemFirst(); break;
    case 'FROM_SELECT': renderFromSelect(); break;
    case 'LOADING': renderLoading(); break;
    case 'NO_WORK': renderNoWork(); break;
    case 'SETUP_ERROR': renderSetupError(); break;
    case 'FROM': renderFrom(); break;
    case 'ITEM': renderItem(); break;
    case 'TO': renderTo(); break;
    case 'FAIL': renderFail(); break;
    case 'PASS': renderPass(); break;
  }
}

function renderItemFirst() {
  stopNoWorkPolling();
  app.innerHTML = `
    <div class="app-header"><span class="step-label">일반 이동 · 품번 우선</span></div>
    <div class="guide-text">피킹한 품번 QR을 스캔하세요</div>
    <div class="sub-text">이동할 FROM·TO·수량을 확인한 뒤 바로 처리할 수 있습니다.</div>
    ${scanInput('품번 QR 스캔 대기 중...')}
    <div class="spacer"></div>
    <button class="btn-reset" id="guidedModeBtn">일괄 자동배정 모드로 전환</button>`;
  document.getElementById('guidedModeBtn').addEventListener('click', () => {
    disableInteractiveControls();
    loadNextTask();
  });
  bindScan(handleItemFirstScan);
}

function renderFromSelect() {
  const rows = state.itemCandidates.map(mapping => {
    const totalQuantity = (mapping.to_quantities ?? [])
      .reduce((sum, quantity) => sum + (quantity ?? 0), 0);
    return `<li><strong>${esc(mapping.from_location)}</strong>
      <span>${totalQuantity > 0 ? `${totalQuantity.toLocaleString()}개` : '수량 확인 필요'}</span></li>`;
  }).join('');
  app.innerHTML = `
    <div class="app-header"><span class="step-label">일반 이동 · FROM 선택</span></div>
    <div class="confirmed-from">품번 ${esc(state.scannedItemCode)}</div>
    <div class="guide-text">출발지가 여러 곳입니다</div>
    <ul class="candidate-list">${rows}</ul>
    <div class="sub-text">피킹한 재고의 FROM 로케이션 QR을 스캔하세요.</div>
    ${scanInput('FROM QR 스캔 대기 중...')}
    <div class="spacer"></div>
    <button class="btn-reset" id="itemFirstBackBtn">품번 다시 스캔</button>`;
  document.getElementById('itemFirstBackBtn').addEventListener('click', resetItemFirst);
  bindScan(handleFromSelectionScan);
}

function renderLoading() {
  app.innerHTML = `
    <div class="spacer"></div>
    <div class="loading-spinner" aria-hidden="true"></div>
    <div class="result-detail">다음 이동 작업을 배정하고 있습니다</div>
    <div class="spacer"></div>`;
}

function renderNoWork() {
  app.innerHTML = `
    <div class="spacer"></div>
    <div class="result-icon">✅</div>
    <div class="result-detail">대기 중인 이동 작업이 없습니다</div>
    <button class="btn-next" id="refreshBtn">새로 확인</button>
    <div class="spacer"></div>`;
  document.getElementById('refreshBtn').addEventListener('click', loadNextTask);
  stopNoWorkPolling();
  noWorkTimer = setTimeout(loadNextTask, NO_WORK_REFRESH_MS);
}

function renderSetupError() {
  document.body.classList.add('status-fail');
  app.innerHTML = `
    <div class="spacer"></div>
    <div class="result-icon">⚠️</div>
    <div class="result-detail">자동 배정 준비가 필요합니다</div>
    <div class="fail-detail">관리자에게 작업 배정 DB 설정을 확인해 달라고 요청하세요.</div>
    <button class="btn-next" id="retryBtn">다시 시도</button>
    <div class="spacer"></div>`;
  document.getElementById('retryBtn').addEventListener('click', loadNextTask);
}

function renderFrom() {
  const mapping = state.mapping;
  app.innerHTML = `
    <div class="app-header">${dots(1)}<span class="step-label">STEP 1 · FROM</span></div>
    <div class="guide-text">아래 로케이션으로 이동하세요</div>
    <div class="task-location-card">
      <div class="task-card-label">FROM 로케이션</div>
      <div class="task-card-value">${esc(mapping.from_location)}</div>
    </div>
    <div class="sub-text">도착한 뒤 FROM 로케이션 QR을 스캔하세요</div>
    ${scanInput()}
    <div class="spacer"></div>`;
  bindScan(handleFromScan);
}

function renderItem() {
  const mapping = state.mapping;
  const totalQuantity = (mapping.to_quantities ?? []).reduce((sum, quantity) => sum + (quantity ?? 0), 0);
  app.innerHTML = `
    <div class="app-header">${dots(2)}<span class="step-label">STEP 2 · 품번</span></div>
    <div class="confirmed-from">FROM ${esc(mapping.from_location)} 확인 완료</div>
    <div class="guide-text">이동할 품번 QR을 스캔하세요</div>
    <div class="task-item-card">
      <div class="task-card-label">품번</div>
      <div class="task-item-value">${esc(mapping.item_code)}</div>
      ${totalQuantity > 0 ? `<div class="task-quantity">이동 수량 <strong>${totalQuantity.toLocaleString()}개</strong></div>` : ''}
    </div>
    ${scanInput()}
    <div class="spacer"></div>`;
  bindScan(handleItemScan);
}

function renderTo() {
  const mapping = state.mapping;
  const targets = pendingTargets(mapping, state.completedLocations);
  const remainingQuantity = targets.reduce((sum, target) => sum + target.quantity, 0);
  app.innerHTML = `
    <div class="app-header">${dots(3)}<span class="step-label">STEP 3 · TO</span></div>
    <div class="confirmed-from">${esc(mapping.item_code)} · FROM ${esc(mapping.from_location)}</div>
    <div class="guide-text">아래 로케이션으로 이동하세요</div>
    <div class="to-list-wrap">
      <table class="to-qty-table"><tbody>
        ${targets.map(target => `<tr>
          <td class="to-loc-cell">${esc(target.location)}</td>
          <td class="to-qty-cell">${target.quantity > 0 ? `${target.quantity.toLocaleString()}개` : '-'}</td>
        </tr>`).join('')}
      </tbody></table>
    </div>
    <div class="to-summary">
      <span>남은 로케이션 <strong>${targets.length}개</strong></span>
      ${remainingQuantity > 0 ? `<span>남은 수량 <strong>${remainingQuantity.toLocaleString()}개</strong></span>` : ''}
    </div>
    <div class="sub-text">도착한 뒤 TO 로케이션 QR을 스캔하세요</div>
    ${scanInput()}
    <div class="spacer"></div>`;
  bindScan(handleToScan);
}

function renderFail() {
  document.body.classList.add('status-fail');
  app.innerHTML = `
    <div class="spacer"></div>
    <div class="result-icon">🚫</div>
    <div class="result-detail">${esc(state.failTitle)}</div>
    <div class="fail-detail">${esc(state.failDetail)}</div>
    <div class="sub-text" style="text-align:center">올바른 QR을 다시 스캔하세요</div>
    ${scanInput()}
    <div class="spacer"></div>`;
  const failureHandlers = {
    ITEM_FIRST: handleItemFirstScan,
    FROM_SELECT: handleFromSelectionScan,
    FROM: handleFromScan,
    ITEM: handleItemScan,
    TO: handleToScan,
  };
  bindScan(failureHandlers[state.failReturn] ?? handleToScan);
}

function renderPass() {
  document.body.classList.add('status-pass');
  app.innerHTML = `
    <div class="spacer"></div>
    <div class="result-icon">✅</div>
    <div class="result-detail">이동 완료!</div>
    <div class="result-detail pass-route">
      ${esc(state.passResult.from)} → ${esc(state.passResult.to)}
    </div>
    <div class="sub-text" style="text-align:center">${state.mode === 'GUIDED'
      ? '다음 이동 작업을 자동으로 불러옵니다'
      : '다음 품번을 스캔할 수 있도록 돌아갑니다'}</div>
    <div class="spacer"></div>`;
}

function bindScan(handler) {
  scanLocked = false;
  stepHandler = handler;
  const input = document.getElementById('scanInput');
  if (!input) return;
  input.focus();
  input.addEventListener('keydown', event => {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key === 'Enter' || event.key === 'Tab' || event.keyCode === 13 || event.keyCode === 9) {
      event.preventDefault();
      submitScan(input, handler);
    }
  });
  let debounce = null;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (input.value.trim()) submitScan(input, handler);
    }, 300);
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      const current = document.getElementById('scanInput');
      if (current && !current.disabled) current.focus();
    }, 100);
  });
}

function submitScan(input, handler) {
  const value = input.value.trim();
  input.value = '';
  if (value) handler(value);
}

function clearFailureReturnTimer() {
  clearTimeout(failureReturnTimer);
  failureReturnTimer = null;
}

function showFailure(title, detail, returnScreen, autoReturnMs = null) {
  clearFailureReturnTimer();
  playFailFeedback();
  state.failTitle = title;
  state.failDetail = detail;
  state.failReturn = returnScreen;
  state.screen = 'FAIL';
  render();
  if (autoReturnMs === null) return;

  failureReturnTimer = setTimeout(() => {
    failureReturnTimer = null;
    if (state.screen !== 'FAIL' || state.failReturn !== returnScreen) return;
    state.screen = returnScreen;
    render();
  }, autoReturnMs);
}

async function handleItemFirstScan(rawValue) {
  disableInteractiveControls();
  const input = document.getElementById('scanInput');
  if (input) input.disabled = true;
  const itemCode = parseItemCode(rawValue);
  if (!itemCode) {
    showFailure('품번을 확인할 수 없습니다', `스캔값: ${rawValue}`, 'ITEM_FIRST');
    return;
  }

  const safe = itemCode.replace(/[%_\\]/g, '\\$&');
  const encoded = encodeURIComponent(safe);
  const { data, error } = await withRetry(() => sbFetch(
    `item_mappings?select=*&item_code=ilike.${encoded}&status=eq.active&order=from_location.asc`,
  ));
  if (error) {
    showFailure('이동지시 조회 실패', '네트워크를 확인하고 품번을 다시 스캔하세요', 'ITEM_FIRST');
    return;
  }

  const candidates = itemFirstCandidates(data, rawValue);
  const decision = itemFirstDecision(candidates);
  if (decision === 'NO_MATCH') {
    showFailure('이동지시 없음', `품번: ${itemCode}`, 'ITEM_FIRST');
    return;
  }

  state.scannedItemCode = itemCode;
  state.itemCandidates = candidates;
  if (decision === 'REQUIRE_FROM') {
    playPassFeedback();
    state.screen = 'FROM_SELECT';
    render();
    return;
  }

  await claimItemFirstMapping(
    itemCode,
    candidates[0].from_location,
    'ITEM_FIRST',
  );
}

async function handleFromSelectionScan(rawValue) {
  disableInteractiveControls();
  const candidate = state.itemCandidates.find(mapping =>
    isExpectedLocation(rawValue, mapping.from_location),
  );
  if (!candidate) {
    showFailure(
      'FROM 로케이션 불일치',
      `스캔값: ${rawValue}`,
      'FROM_SELECT',
      MISMATCH_WARNING_MS,
    );
    return;
  }
  await claimItemFirstMapping(
    state.scannedItemCode,
    candidate.from_location,
    'FROM_SELECT',
  );
}

async function claimItemFirstMapping(itemCode, fromLocation, returnScreen) {
  const input = document.getElementById('scanInput');
  if (input) input.disabled = true;
  const { data, error } = await withRetry(() => sbFetch('rpc/claim_item_mapping_by_item', {
    method: 'POST',
    body: JSON.stringify({
      p_device_id: deviceId,
      p_item_code: itemCode,
      p_from_location: fromLocation,
    }),
  }));
  if (error) {
    showFailure('작업 선점 실패', '관리자에게 품번 우선 이동 DB 설정을 확인해 달라고 요청하세요', returnScreen);
    return;
  }

  const mapping = Array.isArray(data) ? data[0] : data;
  if (!mapping) {
    showFailure('다른 PDA에서 작업 중', '잠시 후 품번을 다시 스캔하세요', returnScreen);
    return;
  }

  state.mapping = mapping;
  try {
    await loadCompletedLocations(mapping.id);
  } catch (loadError) {
    console.error('완료 이력 조회 실패:', loadError);
    showFailure('완료 이력 조회 실패', '네트워크를 확인하고 다시 스캔하세요', returnScreen);
    return;
  }
  state.itemCandidates = [];
  playPassFeedback();
  state.screen = 'TO';
  startClaimHeartbeat();
  render();
}

function handleFromScan(rawValue) {
  if (!isExpectedLocation(rawValue, state.mapping.from_location)) {
    showFailure(
      'FROM 로케이션 불일치',
      `스캔값: ${rawValue}`,
      'FROM',
      MISMATCH_WARNING_MS,
    );
    return;
  }
  playPassFeedback();
  state.screen = 'ITEM';
  render();
}

function handleItemScan(rawValue) {
  if (!isExpectedItem(rawValue, state.mapping.item_code)) {
    showFailure(
      '품번 불일치',
      `스캔값: ${rawValue}`,
      'ITEM',
      MISMATCH_WARNING_MS,
    );
    return;
  }
  playPassFeedback();
  state.screen = 'TO';
  render();
}

async function handleToScan(rawValue) {
  disableInteractiveControls();
  const input = document.getElementById('scanInput');
  if (input) input.disabled = true;
  const targets = pendingTargets(state.mapping, state.completedLocations);
  const target = targets.find(candidate => isExpectedLocation(rawValue, candidate.location));
  if (!target) {
    showFailure(
      'TO 로케이션 불일치',
      `스캔값: ${rawValue}`,
      'TO',
      MISMATCH_WARNING_MS,
    );
    return;
  }

  const logResult = await withRetry(() => sbFetch('placement_logs', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      mapping_id: state.mapping.id,
      item_code: state.mapping.item_code,
      from_location: state.mapping.from_location,
      scanned_to: target.location,
      to_display: state.mapping.to_display,
      result: 'pass',
      pda_ua: navigator.userAgent,
    }),
  }));
  if (logResult.error) {
    showFailure('저장 실패', '네트워크를 확인하고 TO QR을 다시 스캔하세요', 'TO');
    return;
  }

  playPassFeedback();
  state.completedLocations.add(normalizeLocation(target.location));
  if (pendingTargets(state.mapping, state.completedLocations).length > 0) {
    state.screen = 'TO';
    render();
    return;
  }

  const completion = await withRetry(() => sbFetch('rpc/complete_item_mapping', {
    method: 'POST',
    body: JSON.stringify({
      p_mapping_id: state.mapping.id,
      p_device_id: deviceId,
    }),
  }));
  if (completion.error || completion.data !== true) {
    showFailure('완료 저장 실패', '관리자에게 문의하거나 TO QR을 다시 스캔하세요', 'TO');
    return;
  }

  stopClaimHeartbeat();
  state.passResult = {
    from: state.mapping.from_location,
    to: state.mapping.to_display,
  };
  state.screen = 'PASS';
  render();
  setTimeout(state.mode === 'GUIDED' ? loadNextTask : resetItemFirst, NEXT_TASK_DELAY_MS);
}

async function loadCompletedLocations(mappingId) {
  const { data, error } = await sbFetch(
    `placement_logs?select=scanned_to&mapping_id=eq.${encodeURIComponent(mappingId)}&result=eq.pass`,
  );
  if (error) throw error;
  state.completedLocations = new Set(
    (data ?? []).map(log => normalizeLocation(log.scanned_to)),
  );
}

async function claimNextTask() {
  return withRetry(() => sbFetch('rpc/claim_next_item_mapping', {
    method: 'POST',
    body: JSON.stringify({ p_device_id: deviceId }),
  }));
}

function resetItemFirst() {
  stopClaimHeartbeat();
  stopNoWorkPolling();
  state = initialState('ITEM_FIRST');
  render();
}

async function loadNextTask() {
  stopClaimHeartbeat();
  stopNoWorkPolling();
  state = initialState('GUIDED');
  render();
  const { data, error } = await claimNextTask();
  if (error) {
    console.error('작업 자동 배정 실패:', error);
    state.screen = 'SETUP_ERROR';
    render();
    return;
  }
  const mapping = Array.isArray(data) ? data[0] : data;
  if (!mapping) {
    state.screen = 'NO_WORK';
    render();
    return;
  }
  state.mapping = mapping;
  try {
    await loadCompletedLocations(mapping.id);
  } catch (error) {
    console.error('완료 이력 조회 실패:', error);
    state.screen = 'SETUP_ERROR';
    render();
    return;
  }
  state.screen = 'FROM';
  startClaimHeartbeat();
  render();
}

function startClaimHeartbeat() {
  stopClaimHeartbeat();
  claimTimer = setInterval(async () => {
    if (!state.mapping) return;
    const { data, error } = await sbFetch('rpc/renew_item_mapping_claim', {
      method: 'POST',
      body: JSON.stringify({
        p_mapping_id: state.mapping.id,
        p_device_id: deviceId,
      }),
    });
    if (error || data !== true) {
      console.warn('작업 선점 갱신 실패:', error?.message ?? 'claim lost');
    }
  }, CLAIM_REFRESH_MS);
}

function stopClaimHeartbeat() {
  if (claimTimer) clearInterval(claimTimer);
  claimTimer = null;
}

function stopNoWorkPolling() {
  if (noWorkTimer) clearTimeout(noWorkTimer);
  noWorkTimer = null;
}

async function withRetry(fn, retries = 2) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const result = await fn().catch(error => ({ data: null, error }));
    if (!result.error) return result;
    if (attempt < retries - 1) await new Promise(resolve => setTimeout(resolve, 300));
  }
  return { data: null, error: new Error('네트워크 오류') };
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

startupMode === 'ITEM_FIRST' ? resetItemFirst() : loadNextTask();
