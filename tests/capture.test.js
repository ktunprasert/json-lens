import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapture, decodeBody, MAX_REQUESTS, MAX_BODY_BYTES } from '../capture.js';

function event() {
  const callbacks = [];
  return { addListener: (callback) => callbacks.push(callback), fire: (...args) => callbacks.forEach((callback) => callback(...args)) };
}
function network() {
  return { onRequestFinished: event(), onNavigated: event(), getHAR(callback) { this.snapshot = callback; } };
}
function entry(index = 0, text = '{"ok":true}', encoding = '') {
  return {
    request: { method: 'GET', url: `https://example.test/api/${index}` },
    response: { status: 200, content: { mimeType: 'application/json', size: text?.length || 0 } },
    startedDateTime: `2026-09-13T00:00:00.${String(index).padStart(3, '0')}Z`,
    time: 10,
    getContent: (callback) => callback(text, encoding),
  };
}
test('initial HAR reconciles with live requests without dropping identical snapshot entries', () => {
  const api = network(), store = createCapture(api);
  api.onRequestFinished.fire(entry(1));
  api.onRequestFinished.fire(entry(2));
  api.snapshot({ entries: [entry(1), entry(1)] });
  assert.deepEqual(store.entries.map((item) => item.url), [entry(1).request.url, entry(1).request.url, entry(2).request.url]);
  api.onRequestFinished.fire(entry(1));
  assert.equal(store.entries.length, 4);
});
test('capture runs without panel subscribers and is bounded', () => {
  const api = network(), store = createCapture(api); api.snapshot({ entries: [] });
  for (let i = 0; i < MAX_REQUESTS + 20; i++) api.onRequestFinished.fire(entry(i));
  assert.equal(store.entries.length, MAX_REQUESTS);
  assert.equal(store.entries[0].url, entry(20).request.url);
});
test('clear and navigation invalidate an in-flight HAR snapshot', () => {
  for (const action of ['clear', 'navigate']) {
    const api = network(), store = createCapture(api);
    api.onRequestFinished.fire(entry(1));
    if (action === 'clear') store.clear(); else api.onNavigated.fire('https://other.test');
    api.snapshot({ entries: [entry(1)] });
    assert.equal(store.entries.length, 0);
    api.onRequestFinished.fire(entry(2));
    assert.equal(store.entries.length, 1);
  }
});
test('pause and preserve log', () => {
  const api = network(), store = createCapture(api); api.snapshot({ entries: [entry(1)] });
  store.setRecording(false); api.onRequestFinished.fire(entry(2)); assert.equal(store.entries.length, 1);
  store.setPreserve(true); api.onNavigated.fire('https://other.test'); assert.equal(store.entries.length, 1);
  store.setRecording(true); api.onRequestFinished.fire(entry(3)); assert.equal(store.entries.length, 2);
  store.setPreserve(false); api.onNavigated.fire('https://third.test'); assert.equal(store.entries.length, 0);
});
test('preserve log retains pending requests when navigation races initial HAR', () => {
  const api = network(), store = createCapture(api);
  store.setPreserve(true);
  api.onRequestFinished.fire(entry(1));
  api.onNavigated.fire('https://other.test');
  api.snapshot({ entries: [entry(1)] });
  assert.equal(store.entries.length, 1);
  assert.equal(store.entries[0].url, entry(1).request.url);
});
test('subscriptions can be removed', () => {
  const api = network(), store = createCapture(api); api.snapshot({ entries: [] });
  let calls = 0; const unsubscribe = store.subscribe(() => calls++);
  api.onRequestFinished.fire(entry(1)); assert.equal(calls, 1);
  unsubscribe(); store.clear(); assert.equal(calls, 1);
});
test('read obtains response lazily and decodes UTF-8 base64', async () => {
  const api = network(), store = createCapture(api);
  const text = '{"message":"こんにちは 🙂"}';
  api.snapshot({ entries: [entry(1, Buffer.from(text).toString('base64'), 'base64')] });
  assert.equal(await store.read(store.entries[0].id), text);
  await assert.rejects(store.read(9999), /cleared or evicted/);
});
test('unavailable, malformed, and oversized bodies fail clearly', async () => {
  assert.throws(() => decodeBody(undefined), /unavailable/);
  assert.throws(() => decodeBody('!!!', 'base64'));
  assert.throws(() => decodeBody('x'.repeat(MAX_BODY_BYTES + 1)), /10 MiB/);
  assert.throws(() => decodeBody('🙂'.repeat(MAX_BODY_BYTES / 4 + 1)), /10 MiB/);
  assert.equal(decodeBody('\uFEFF{}'), '{}');
  const api = network(), store = createCapture(api);
  const large = entry(); large.response.content.size = MAX_BODY_BYTES + 1;
  api.snapshot({ entries: [large] });
  await assert.rejects(store.read(store.entries[0].id), /10 MiB/);
});
