import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://box.example.ts.net';

// Runs sw.js against a fake service-worker global and returns what a push + tap would open.
async function tap(url) {
  const listeners = {};
  const shown = [];
  const opened = [];
  const self = {
    location: new URL(ORIGIN + '/sw.js'),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting() {},
    registration: { showNotification: async (title, opts) => { shown.push(opts); } },
    clients: { claim: async () => {}, matchAll: async () => [], openWindow: async (u) => { opened.push(u); } },
  };
  vm.runInNewContext(source, { self, URL });
  const waits = [];
  listeners.push({ data: { json: () => ({ title: 't', url }) }, waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  listeners.notificationclick({ notification: { close() {}, data: shown[0].data }, waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  return opened[0];
}

test('T: notification tap opens same-origin paths', async () => {
  assert.equal(await tap('/#/t/t1'), ORIGIN + '/#/t/t1');
});

test('T: notification tap never leaves the origin', async () => {
  const bs = String.fromCharCode(92); // backslash
  for (const evil of [`/${bs}evil.example/x`, '//evil.example/x', 'https://evil.example/x', `${bs}${bs}evil.example`, 'javascript:alert(1)']) {
    const u = await tap(evil);
    assert.equal(new URL(u).origin, ORIGIN, `${evil} -> ${u}`);
  }
});
