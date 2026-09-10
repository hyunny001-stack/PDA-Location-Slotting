import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  isExpectedItem,
  isExpectedLocation,
  parseItemCode,
  pendingTargets,
} from '../js/taskFlow.js';

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

test('PDA는 최초설계대로 품번 스캔 후 FROM 스캔 없이 TO 이동지침을 표시한다', async () => {
  const source = await readFile(new URL('../js/pda.js', import.meta.url), 'utf8');

  assert.match(source, /screen:\s*'STEP1'/);
  assert.match(source, /품번 QR을/);
  assert.match(source, /item_code=ilike\.\$\{enc\}&status=eq\.active/);
  assert.match(source, /state\.allMappings\s*=\s*byItem\.data/);
  assert.match(source, /state\.screen\s*=\s*'STEP3'/);
  assert.doesNotMatch(source, /from_location=ilike/);
  assert.doesNotMatch(source, /claim_next_item_mapping/);
  assert.doesNotMatch(source, /claim_item_mapping_by_item/);
  assert.doesNotMatch(source, /FROM 로케이션 QR을 스캔하세요/);
  assert.doesNotMatch(source, /guidedModeBtn|resolvePdaMode|FROM_SELECT/);
});

test('동일 품번의 여러 FROM과 TO를 한 화면에 합쳐 수량과 함께 안내한다', async () => {
  const source = await readFile(new URL('../js/pda.js', import.meta.url), 'utf8');

  assert.match(source, /fromDisplay\s*=\s*\[\.\.\.new Set\(state\.allMappings\.map/);
  assert.match(source, /allToLocs\s*=\s*state\.allMappings\.flatMap/);
  assert.match(source, /qtyMap\s*=\s*buildQtyMap\(state\.allMappings\)/);
  assert.match(source, /총 로케이션수/);
  assert.match(source, /총 수량/);
  assert.match(source, /이동 로케이션 QR을 스캔하세요/);
});

test('완료 후 다음 작업은 자동배정하지 않고 다음 품번 스캔으로 돌아간다', async () => {
  const source = await readFile(new URL('../js/pda.js', import.meta.url), 'utf8');

  assert.match(source, /id="nextBtn">다음 작업/);
  assert.match(source, /nextBtn'\)\.addEventListener\('click', resetToStep1\)/);
  assert.doesNotMatch(source, /setTimeout\([^\n]*loadNextTask/);
});

test('자동배정과 모드선택 보조로직은 PDA 실행코드에서 제거한다', async () => {
  const [pda, taskFlow] = await Promise.all([
    readFile(new URL('../js/pda.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/taskFlow.js', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(pda, /claim_next_item_mapping|claim_item_mapping_by_item/);
  assert.doesNotMatch(pda, /guidedModeBtn|resolvePdaMode|FROM_SELECT/);
  assert.doesNotMatch(taskFlow, /itemFirstCandidates|itemFirstDecision|resolvePdaMode/);
});

test('품번우선 전용 PDA 캐시 버전을 배포한다', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

  assert.match(html, /js\/pda\.js\?v=20260910b/);
  assert.doesNotMatch(html, /mode=item-first|mode=guided/);
});
