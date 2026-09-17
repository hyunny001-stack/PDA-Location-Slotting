import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  isExpectedItem,
  isExpectedLocation,
  parseItemCode,
  pendingTargets,
} from '../js/taskFlow.js';

async function source(path) {
  return readFile(new URL(path, import.meta.url), 'utf8').catch(() => '');
}

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

test('기본 URL은 최초설계 품번우선 이동만 실행한다', async () => {
  const [loader, itemFirst] = await Promise.all([
    source('../js/pda.js'),
    source('../js/pda-item-first.js'),
  ]);

  assert.match(loader, /selectPdaModule\(window\.location\.search\)/);
  assert.match(loader, /import\(`\.\/\$\{moduleName\}\?v=20260917a`\)/);
  assert.match(itemFirst, /screen:\s*'STEP1'/);
  assert.match(itemFirst, /품번 QR을/);
  assert.match(itemFirst, /item_code=ilike\.\$\{enc\}&status=eq\.active/);
  assert.match(itemFirst, /state\.allMappings\s*=\s*byItem\.data/);
  assert.match(itemFirst, /state\.screen\s*=\s*'STEP3'/);
  assert.doesNotMatch(itemFirst, /claim_next_item_mapping/);
  assert.doesNotMatch(itemFirst, /FROM 로케이션 QR을 스캔하세요/);
});

test('location-first URL은 FROM→품번→TO 이동 전용 흐름을 실행한다', async () => {
  const [router, locationFirst] = await Promise.all([
    source('../js/modeRouter.js'),
    source('../js/pda-location-first.js'),
  ]);

  assert.match(router, /params\.get\('mode'\) === 'location-first'/);
  assert.match(router, /return 'pda-location-first\.js'/);
  assert.match(router, /return 'pda-item-first\.js'/);
  assert.match(locationFirst, /STEP 1 · FROM/);
  assert.match(locationFirst, /FROM 로케이션 QR을 스캔하세요/);
  assert.match(locationFirst, /STEP 2 · 품번/);
  assert.match(locationFirst, /STEP 3 · TO/);
  assert.match(locationFirst, /claim_next_item_mapping/);
  assert.match(locationFirst, /complete_item_mapping/);
  assert.match(locationFirst, /async function verifyClaimOwnership/);
  assert.match(locationFirst, /if \(!await verifyClaimOwnership\(\)\) return;/);
  assert.match(locationFirst, /function blockClaimedTask/);
  assert.match(locationFirst, /claim ownership lost/);
  assert.match(locationFirst, /generation !== claimGeneration/);
  assert.match(locationFirst, /async function finalizeCurrentMapping/);
  assert.match(locationFirst, /case 'FINALIZING'/);
  assert.match(locationFirst, /case 'FINALIZE_ERROR'/);
  assert.match(locationFirst, /item_mappings\?select=status&id=eq\.\$\{encodeURIComponent/);
  assert.match(locationFirst, /pendingTargets\(mapping, state\.completedLocations\)\.length === 0/);
  assert.doesNotMatch(locationFirst, /재고조사 시작|나의 조사 완료|정규 조사|재조사/);
});

test('동일 품번의 여러 FROM과 TO를 품번우선 화면에 합쳐 안내한다', async () => {
  const itemFirst = await source('../js/pda-item-first.js');

  assert.match(itemFirst, /fromDisplay\s*=\s*\[\.\.\.new Set\(state\.allMappings\.map/);
  assert.match(itemFirst, /allToLocs\s*=\s*state\.allMappings\.flatMap/);
  assert.match(itemFirst, /qtyMap\s*=\s*buildQtyMap\(state\.allMappings\)/);
  assert.match(itemFirst, /총 로케이션수/);
  assert.match(itemFirst, /총 수량/);
  assert.match(itemFirst, /이동 로케이션 QR을 스캔하세요/);
});

test('품번우선 완료 후 다음 작업은 자동배정하지 않고 품번 스캔으로 돌아간다', async () => {
  const itemFirst = await source('../js/pda-item-first.js');

  assert.match(itemFirst, /id="nextBtn">다음 작업/);
  assert.match(itemFirst, /nextBtn'\)\.addEventListener\('click', resetToStep1\)/);
  assert.doesNotMatch(itemFirst, /setTimeout\([^\n]*loadNextTask/);
});

test('두 모드는 별도 파일로 격리하고 알려지지 않은 mode는 품번우선으로 닫힌다', async () => {
  const router = await source('../js/modeRouter.js');

  assert.match(router, /new URLSearchParams\(search\)/);
  assert.match(router, /mode'\) === 'location-first'/);
  assert.doesNotMatch(router, /guided|cycle-count|PdaFoundationClient/);
});

test('분리된 PDA 모듈 캐시 버전을 배포한다', async () => {
  const html = await source('../index.html');

  assert.match(html, /js\/pda\.js\?v=20260917a/);
  assert.doesNotMatch(html, /mode=item-first|mode=guided/);
});
