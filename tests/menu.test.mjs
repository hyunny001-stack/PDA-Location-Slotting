import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { countActiveJobs, menuLinks } from '../js/menu.js';

async function source(path) {
  return readFile(new URL(path, import.meta.url), 'utf8').catch(() => '');
}

test('작업 메뉴는 공로케이션 조사 → 로케이션 이동 두 단계로 연결한다 (적치는 WMS)', () => {
  const links = menuLinks({ SURVEY_URL: 'https://survey.example/pda' });
  assert.deepEqual(links.map((link) => [link.id, link.href]), [
    ['survey', 'https://survey.example/pda'],
    ['move', 'index.html?mode=location-first'],
  ]);
});

test('남은 이동 작업은 active 작업 수로 센다', () => {
  assert.equal(countActiveJobs([{ from_location: 'BB-01-104' }, { from_location: '17' }]), 2);
  assert.equal(countActiveJobs(null), 0);
});

test('메뉴 화면과 두 스캔 모드에서 메뉴로 돌아가는 링크를 제공한다', async () => {
  const [menuHtml, loader, config] = await Promise.all([source('../menu.html'), source('../js/pda.js'), source('../js/config.js')]);
  assert.match(menuHtml, /js\/menu\.js\?v=/);
  assert.match(loader, /href=\\?"menu\.html\\?"/);
  assert.match(config, /SURVEY_URL:/);
});
