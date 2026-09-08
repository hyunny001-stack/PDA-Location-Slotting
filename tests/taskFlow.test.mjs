import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as taskFlow from '../js/taskFlow.js';

const {
  isExpectedItem,
  isExpectedLocation,
  parseItemCode,
  pendingTargets,
} = taskFlow;

test('로케이션은 대소문자와 앞뒤 공백을 무시해 검증한다', () => {
  assert.equal(isExpectedLocation(' cb-10-503 ', 'CB-10-503'), true);
  assert.equal(isExpectedLocation('CB-10-502', 'CB-10-503'), false);
});

test('기존 15자리 품번과 부가정보가 있는 QR을 검증한다', () => {
  assert.equal(parseItemCode('110005-010146CN+LOT'), '110005-010146CN');
  assert.equal(isExpectedItem('110005-010146CN+LOT', '110005-010146CN'), true);
  assert.equal(isExpectedItem('110005-010143CN', '110005-010146CN'), false);
});

test('완료된 TO를 제외하고 남은 로케이션과 수량만 반환한다', () => {
  const mapping = {
    to_locations: ['CB-10-502', 'CB-10-504'],
    to_quantities: [15, 3],
  };
  assert.deepEqual(pendingTargets(mapping, new Set(['cb-10-502'])), [
    { location: 'CB-10-504', quantity: 3 },
  ]);
});

test('품번 우선 후보는 스캔한 품번의 active 작업만 FROM 순서로 반환한다', () => {
  assert.equal(typeof taskFlow.itemFirstCandidates, 'function');
  const mappings = [
    { id: '2', item_code: '110005-010146CN', from_location: 'CB-02', status: 'active' },
    { id: 'x', item_code: '110005-010143CN', from_location: 'CB-00', status: 'active' },
    { id: '3', item_code: '110005-010146CN', from_location: 'CB-03', status: 'completed' },
    { id: '1', item_code: '110005-010146CN', from_location: 'CB-01', status: 'active' },
  ];

  assert.deepEqual(
    taskFlow.itemFirstCandidates(mappings, '110005-010146CN+LOT').map(({ id }) => id),
    ['1', '2'],
  );
});

test('품번 후보 한 건은 바로 선점하고 여러 FROM은 출발지 확인을 요구한다', () => {
  assert.equal(typeof taskFlow.itemFirstDecision, 'function');
  assert.equal(taskFlow.itemFirstDecision([]), 'NO_MATCH');
  assert.equal(taskFlow.itemFirstDecision([{ id: '1' }]), 'CLAIM_DIRECT');
  assert.equal(
    taskFlow.itemFirstDecision([{ id: '1' }, { id: '2' }]),
    'REQUIRE_FROM',
  );
});

test('품번 우선 선점 SQL은 active lease와 행 잠금을 함께 강제한다', async () => {
  const sql = await readFile(
    new URL('../sql/20260908_add_item_first_claim.sql', import.meta.url),
    'utf8',
  ).catch(() => '');

  assert.match(sql, /claim_item_mapping_by_item/i);
  assert.match(sql, /mapping\.status\s*=\s*'active'/i);
  assert.match(sql, /claimed_at\s*<\s*now\(\)\s*-\s*interval\s*'15 minutes'/i);
  assert.match(sql, /FOR UPDATE SKIP LOCKED/i);
  assert.match(sql, /lower\(trim\(mapping\.item_code\)\)/i);
  assert.match(sql, /lower\(trim\(mapping\.from_location\)\)/i);
});

test('PDA 기본 화면은 품번 우선이며 안내형 이동은 별도 선택으로 남는다', async () => {
  const source = await readFile(new URL('../js/pda.js', import.meta.url), 'utf8');

  assert.match(source, /function initialState\(mode = 'ITEM_FIRST'\)/);
  assert.match(source, /screen:\s*mode === 'ITEM_FIRST' \? 'ITEM_FIRST'/);
  assert.match(source, /function renderItemFirst\(/);
  assert.match(source, /id="guidedModeBtn"/);
  assert.match(source, /case 'FROM_SELECT':\s*renderFromSelect\(\)/);
  assert.match(source, /rpc\/claim_item_mapping_by_item/);
});

test('다중 FROM 목록 스타일과 새 PDA 캐시 버전을 배포한다', async () => {
  const [css, html] = await Promise.all([
    readFile(new URL('../css/style.css', import.meta.url), 'utf8'),
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
  ]);

  assert.match(css, /\.candidate-list\s*\{/);
  assert.match(html, /css\/style\.css\?v=20260908a/);
  assert.match(html, /js\/pda\.js\?v=20260908a/);
});

test('비동기 선점 중 모드 전환을 막고 조회한 단일 FROM을 고정한다', async () => {
  const source = await readFile(new URL('../js/pda.js', import.meta.url), 'utf8');

  assert.match(source, /function disableInteractiveControls\(\)/);
  assert.match(source, /guidedModeBtn[\s\S]{0,180}disableInteractiveControls\(\)/);
  assert.match(source, /async function handleItemFirstScan[\s\S]{0,180}disableInteractiveControls\(\)/);
  assert.match(
    source,
    /claimItemFirstMapping\([\s\S]{0,100}itemCode,[\s\S]{0,100}candidates\[0\]\.from_location,[\s\S]{0,100}'ITEM_FIRST'/,
  );
});

test('완료이력 실패 재시도는 후보를 보존하고 모든 완료는 품번 우선으로 복귀한다', async () => {
  const source = await readFile(new URL('../js/pda.js', import.meta.url), 'utf8');
  const historyLoad = source.indexOf('await loadCompletedLocations(mapping.id)');
  const candidateClear = source.indexOf('state.itemCandidates = [];', historyLoad);

  assert.ok(historyLoad >= 0);
  assert.ok(candidateClear > historyLoad);
  assert.match(source, /setTimeout\(resetItemFirst, NEXT_TASK_DELAY_MS\)/);
});

test('신규 설치용 전체 스키마도 품번 우선 선점 RPC를 포함한다', async () => {
  const schema = await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8');
  assert.match(schema, /CREATE OR REPLACE FUNCTION claim_item_mapping_by_item/i);
});

test('비동기 처리 중 문서 스캐너 재진입과 TO 중복 저장을 차단한다', async () => {
  const source = await readFile(new URL('../js/pda.js', import.meta.url), 'utf8');

  assert.match(source, /let scanLocked = false;/);
  assert.match(source, /document\.addEventListener\('keydown',[\s\S]{0,180}if \(scanLocked \|\|/);
  assert.match(
    source,
    /function disableInteractiveControls\(\)[\s\S]{0,220}scanLocked = true;[\s\S]{0,220}stepHandler = null;/,
  );
  assert.match(source, /function bindScan\(handler\)[\s\S]{0,100}scanLocked = false;/);
  assert.match(source, /async function handleToScan[\s\S]{0,120}disableInteractiveControls\(\)/);
});
