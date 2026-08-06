import assert from 'node:assert/strict';
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
