import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { INBOUND_FROM, menuLinks, summarizeJobs } from '../js/menu.js';

async function source(path) {
  return readFile(new URL(path, import.meta.url), 'utf8').catch(() => '');
}

test('작업 메뉴는 공로케이션 조사 → 로케이션 이동 → 입고 적치 순서로 연결한다', () => {
  const links = menuLinks({ SURVEY_URL: 'https://survey.example/pda' });
  assert.deepEqual(links.map((link) => [link.id, link.href]), [
    ['survey', 'https://survey.example/pda'],
    ['move', 'index.html?mode=location-first'],
    ['putaway', 'index.html'],
  ]);
});

test('남은 작업은 FROM이 "입고"면 적치, 나머지는 이동으로 센다', () => {
  assert.equal(INBOUND_FROM, '입고');
  assert.deepEqual(summarizeJobs([
    { from_location: 'BB-01-104' },
    { from_location: '17' },
    { from_location: '입고' },
    { from_location: ' 입고 ' },
  ]), { moves: 2, putaway: 2 });
  assert.deepEqual(summarizeJobs(null), { moves: 0, putaway: 0 });
});

test('메뉴 화면과 두 스캔 모드에서 메뉴로 돌아가는 링크를 제공한다', async () => {
  const [menuHtml, loader, config] = await Promise.all([source('../menu.html'), source('../js/pda.js'), source('../js/config.js')]);
  assert.match(menuHtml, /js\/menu\.js\?v=/);
  assert.match(loader, /href=\\?"menu\.html\\?"/);
  assert.match(config, /SURVEY_URL:/);
});
