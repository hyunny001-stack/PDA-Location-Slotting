// Adapted from b3-evidence/probes.mjs; expected safe behavior, real local source.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const tick = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const ok = data => ({ data, error: null });
const bad = () => ({ data: null, error: new Error('mock network failure') });
const mapping = (id = 'mapping-a', locs = ['CB-10-503', 'CB-10-504']) => ({ id, item_code: 'TEST-ITEM', from_location: `FROM-${id}`, to_locations: locs, to_quantities: locs.map(() => 1), to_display: locs.join(', '), status: 'active' });
function harness() {
  const elements = new Map(), docListeners = {}, feedback = [];
  const document = { body: { className: '', classList: { add() {} } }, head: { appendChild() {} }, activeElement: null,
    addEventListener(k, f) { (docListeners[k] ??= []).push(f); }, createElement: () => makeElement('style'), getElementById: id => elements.get(id) ?? null };
  function makeElement(id) {
    const el = { id, value: '', disabled: false, placeholder: '', listeners: {}, classList: { add() {}, remove() {} },
      focus() { if (!this.disabled) document.activeElement = this; }, addEventListener(k, f) { (this.listeners[k] ??= []).push(f); }, textContent: '' };
    let html = '';
    Object.defineProperty(el, 'innerHTML', { get: () => html, set: s => { html = s; if (id === 'app') { elements.clear(); elements.set('app', el); for (const match of s.matchAll(/id="([^"]+)"/g)) elements.set(match[1], makeElement(match[1])); } } });
    return el;
  }
  elements.set('app', makeElement('app'));
  let nextTimer = 0; const timers = new Map();
  const context = vm.createContext({ console, document, navigator: { userAgent: 'F4-local-mock' }, AbortController,
    setTimeout(f, ms) { const id = ++nextTimer; timers.set(id, { f, ms }); if (ms === 300) queueMicrotask(f); return id; }, clearTimeout: id => timers.delete(id),
    playPassFeedback: () => feedback.push('pass'), playFailFeedback: () => feedback.push('fail'),
    CONFIG: { SUPABASE_URL: 'http://blocked.invalid', SUPABASE_ANON_KEY: 'mock' },
    fetch() { throw new Error('EXTERNAL NETWORK FORBIDDEN'); } });
  // Only replace module imports with injected dependencies; business functions are unchanged.
  const source = readFileSync(new URL('../js/pda-item-first.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
  vm.runInContext(source + `\nglobalThis.probe = {
    get state() { return state; }, scan: handleStep3Scan, load: handleStep1Scan,
    seed(m) { state.currentMapping=m; state.screen='STEP3'; render(); },
    setTransport(fn) { sbFetch=fn; }
  };`, context);
  const api = context.probe;
  return { api, feedback, elements, document, timers,
    reset() { for (const fn of elements.get('resetBtn').listeners.click) fn(); },
    globalScan(value) { document.activeElement = null; for (const key of [...value, 'Enter']) for (const fn of docListeners.keydown) fn({ key, preventDefault() {} }); } };
}
function backend(m = mapping()) {
  const rows = new Map(), calls = []; let loseAck = 0;
  const transport = async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null; calls.push({ path, body });
    if (path.startsWith('item_mappings?')) return ok([m]);
    if (path.startsWith('placement_logs') && options.method === 'POST') {
      rows.set(body.idempotency_key, body);
      if (loseAck-- > 0) return bad();
      return ok([body]);
    }
    if (path.startsWith('placement_logs?select')) return ok([...rows.values()].map(r => ({ scanned_to: r.scanned_to })));
    throw new Error('Unmocked path ' + path);
  };
  return { rows, calls, transport, set loseAck(n) { loseAck = n; }, writes: () => calls.filter(c => c.body?.scanned_to) };
}

test('F4 single-flight: direct and unfocused scanner input cannot duplicate a pending write', async () => {
  const h = harness(), db = backend(), gate = deferred(); h.api.seed(mapping());
  h.api.setTransport(async (p, o) => { if (o?.method === 'POST') await gate.promise; return db.transport(p, o); });
  const pending = h.api.scan('CB-10-503'); await tick();
  assert.equal(h.api.state.completedLocations.size, 0); assert.equal(h.feedback.length, 0);
  assert.equal(h.elements.get('scanInput').disabled, true);
  const duplicate = h.api.scan('CB-10-503');
  h.globalScan('CB-10-504'); await tick(); gate.resolve();
  await Promise.all([pending, duplicate]); await tick();
  assert.equal(db.writes().length, 1);
  assert.deepEqual([...h.api.state.completedLocations], ['cb-10-503']);
  assert.deepEqual(h.feedback, ['pass']);
});

for (const failure of [false, true]) {
  test(`F4 reset alone ignores late ${failure ? 'failure' : 'success'} without null-state error`, async () => {
    const h = harness(), gate = deferred(); h.api.seed(mapping());
    h.api.setTransport(() => gate.promise);
    const pending = h.api.scan('CB-10-503'); await tick(); h.reset();
    gate.resolve(failure ? bad() : ok([{}])); await pending;
    assert.equal(h.api.state.screen, 'STEP1'); assert.equal(h.api.state.currentMapping, null);
    assert.equal(h.api.state.completedLocations.size, 0); assert.equal(h.api.state.passResult, null);
    assert.deepEqual(h.feedback, []);
  });
  test(`F4 new B operation survives A late ${failure ? 'failure' : 'success'} and keeps its own input lock`, async () => {
    const h = harness(), gateA = deferred(), gateB = deferred();
    const b = mapping('mapping-b', ['OTHER-TO']), db = backend(b); let aWrites = 0, bWrites = 0;
    h.api.seed(mapping());
    h.api.setTransport((p, o) => {
      if (o?.method === 'POST') {
        const body = JSON.parse(o.body);
        if (body.mapping_id === 'mapping-a') { aWrites++; return gateA.promise; }
        bWrites++; return gateB.promise;
      }
      return db.transport(p, o);
    });
    const pendingA = h.api.scan('CB-10-503'); await tick(); h.reset();
    await h.api.load('TEST-ITEM');
    const pendingB = h.api.scan('OTHER-TO'); await tick();
    gateA.resolve(failure ? bad() : ok([{}])); await pendingA;
    assert.equal(h.api.state.currentMapping.id, 'mapping-b');
    assert.equal(h.api.state.screen, 'STEP3'); assert.equal(h.api.state.completedLocations.size, 0);
    assert.equal(h.api.state.passResult, null); assert.equal(h.api.state.failReason, null);
    assert.deepEqual(h.feedback, []);
    const duplicateB = h.api.scan('OTHER-TO'); await tick();
    assert.equal(bWrites, 1);
    gateB.resolve(ok([{}])); await Promise.all([pendingB, duplicateB]);
    assert.equal(h.api.state.screen, 'PASS');
    assert.deepEqual([...h.api.state.completedLocations], ['other-to']);
    assert.deepEqual(h.feedback, ['pass']);
    assert.ok(aWrites >= 1);
  });
}

test('F4 retains same-key retry after commit with lost ACK', async () => {
  const h = harness(), db = backend(); h.api.seed(mapping()); h.api.setTransport(db.transport); db.loseAck = 1;
  await h.api.scan('CB-10-503');
  assert.equal(db.writes().length, 2); assert.equal(db.rows.size, 1);
  assert.deepEqual(db.writes()[0].body, db.writes()[1].body);
  assert.equal(db.writes()[0].body.idempotency_key, 'mapping-a:PASS:cb-10-503');
  assert.equal(h.api.state.completedLocations.size, 1); assert.deepEqual(h.feedback, ['pass']);
});
