import test from 'node:test';
import assert from 'node:assert/strict';
import { get, set, del, clear } from '../beta/lib/storage.mjs';

test('storage remains usable when persistent browser APIs are absent', async () => {
  await clear();
  assert.equal(await get('missing', 'fallback'), 'fallback');
  await set('public-snapshot', { revision: 3, lessons: [{ id: 'one' }] });
  assert.deepEqual(await get('public-snapshot'), { revision: 3, lessons: [{ id: 'one' }] });
  await del('public-snapshot');
  assert.equal(await get('public-snapshot'), null);
});

test('fallback stores only own prefixed keys and clear preserves unrelated app data', async () => {
  const saved = new Map([['para.group', 'Б']]);
  globalThis.localStorage = {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key),
    key: index => [...saved.keys()][index],
    get length() { return saved.size; },
  };
  assert.equal(await set('preferences', { subgroup: 'А' }), true);
  assert.ok(saved.has('uf.public.v1.preferences'));
  assert.deepEqual(await get('preferences'), { subgroup: 'А' });
  await clear();
  assert.equal(saved.get('para.group'), 'Б');
  assert.equal(saved.size, 1);
  delete globalThis.localStorage;
});

test('quota errors fall back to memory and corrupt stored JSON does not crash', async () => {
  globalThis.localStorage = { getItem: () => '{bad json', setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
  assert.equal(await set('tasks', ['personal']), false);
  assert.deepEqual(await get('tasks'), ['personal']);
  assert.equal((await get('corrupt', [])).length, 0);
  delete globalThis.localStorage;
  await clear();
});
