import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../beta/sw.js', import.meta.url), 'utf8');

function worker(scope, keys = []) {
  const events = new Map();
  const deleted = [];
  const opened = [];
  const cache = { match: async () => new Response('cached'), put: async () => {} };
  const self = { registration: { scope }, location: { origin: new URL(scope).origin }, clients: { claim: async () => {} }, addEventListener: (event, handler) => events.set(event, handler) };
  runInNewContext(source, { URL, Request, self, caches: { keys: async () => keys, delete: async key => deleted.push(key), open: async name => { opened.push(name); return cache; } }, fetch: async () => new Response('network') });
  return {
    events, deleted, opened,
    async intercept(path, { mode = 'navigate', method = 'GET' } = {}) {
      let response;
      const pending = [];
      const request = { url: new URL(path, scope).href, mode, method };
      events.get('fetch')({ request, respondWith: value => { response = value; }, waitUntil: value => pending.push(value) });
      const intercepted = response !== undefined;
      if (response) await response;
      await Promise.all(pending);
      return intercepted;
    },
  };
}

test('root worker serves only its own document and never replaces beta or staff navigation', async () => {
  const root = worker('https://example.test/schedule/');
  assert.equal(await root.intercept('./?demo=student'), true);
  assert.equal(await root.intercept('./index.html'), true);
  assert.equal(await root.intercept('./beta/'), false);
  assert.equal(await root.intercept('./beta/?demo=admin'), false);
  assert.equal(await root.intercept('./manage/'), false);
  assert.equal(await root.intercept('./manage'), false);
  assert.equal(await root.intercept('./unknown/'), false);
  assert.equal(await root.intercept('./beta/app.mjs', { mode: 'cors' }), false);
  assert.equal(await root.intercept('./manage/app.mjs', { mode: 'cors' }), false);
  assert.equal(await root.intercept('./lib/time.mjs', { mode: 'cors' }), true);
});

test('beta worker serves its own shell but never caches protected POST or external resources', async () => {
  const beta = worker('https://example.test/schedule/beta/');
  assert.equal(await beta.intercept('./?demo=teacher'), true);
  assert.equal(await beta.intercept('./manage/'), false);
  assert.equal(await beta.intercept('../backend/core.mjs', { mode: 'cors' }), true);
  assert.equal(await beta.intercept('../backend/uniflow-api.mjs', { mode: 'cors' }), false);
  assert.equal(await beta.intercept('./state', { method: 'POST', mode: 'cors' }), false);
  assert.equal(await beta.intercept('https://other.test/app.mjs', { mode: 'cors' }), false);
});

test('activation deletes only older caches belonging to the same deployment scope', async () => {
  const rootOld = 'uniflow:%2Fschedule%2F:v1-static';
  const betaOld = 'uniflow:%2Fschedule%2Fbeta%2F:v1-static';
  const beta = worker('https://example.test/schedule/beta/', [rootOld, betaOld, 'unrelated-cache']);
  let activation;
  beta.events.get('activate')({ waitUntil: value => { activation = value; } });
  await activation;
  assert.deepEqual(beta.deleted, [betaOld]);
  await beta.intercept('./');
  assert.deepEqual(beta.opened, ['uniflow:%2Fschedule%2Fbeta%2F:v2-static']);
});
