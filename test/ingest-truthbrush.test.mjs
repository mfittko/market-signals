import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadStore,
  upsert,
  serializeStore,
  saveStore,
  tailSince,
  parseTruthbrushOutput,
  runTruthbrush,
  hasCredentials,
} from '../scripts/ingest-truthbrush.mjs';

// A truthbrush status is a Mastodon status object: id, created_at, content
// (HTML), url, *_count. normalizePost already maps these.
const fixture = [
  {
    id: '111', created_at: '2026-07-05T12:00:00.000Z',
    content: '<p>Tariffs on <b>China</b> &amp; Mexico!</p>', url: 'https://truthsocial.com/@x/111',
    replies_count: 3, reblogs_count: 4, favourites_count: 5,
  },
  {
    id: '112', created_at: '2026-07-06T09:30:00.000Z',
    content: '<p>Iran &gt; oil</p>', url: 'https://truthsocial.com/@x/112',
    replies_count: 1, reblogs_count: 2, favourites_count: 9,
  },
];

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ingest-'));
  try {
    return fn(join(dir, 'nested', 'store.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('normalization maps truthbrush/Mastodon fields to the #7 schema', () => {
  const store = new Map();
  upsert(store, fixture);
  const p = store.get('111');
  assert.deepEqual(p, {
    id: '111',
    createdAtISO: '2026-07-05T12:00:00.000Z',
    text: 'Tariffs on China & Mexico!', // HTML stripped, entities decoded
    url: 'https://truthsocial.com/@x/111',
    engagement: { replies: 3, reblogs: 4, favourites: 5 },
  });
});

test('idempotency: re-ingesting a window is a no-op (identical store, no dupes)', () => {
  withTmp((file) => {
    const a = loadStore(file);
    upsert(a, fixture);
    saveStore(file, a);
    const first = readFileSync(file, 'utf8');

    // re-ingest the SAME batch into a freshly loaded store
    const b = loadStore(file);
    const stats = upsert(b, fixture);
    saveStore(file, b);
    const second = readFileSync(file, 'utf8');

    assert.equal(second, first, 'store bytes unchanged after re-ingest');
    assert.equal(b.size, 2, 'no duplicate ids');
    assert.equal(stats.inserted, 0);
    assert.equal(stats.updated, 2);
  });
});

test('upsert updates in place: a late edit overwrites the same id', () => {
  const store = new Map();
  upsert(store, fixture);
  upsert(store, [{ ...fixture[0], content: '<p>edited</p>', favourites_count: 99 }]);
  assert.equal(store.size, 2, 'still 2 posts, not 3');
  assert.equal(store.get('111').text, 'edited');
  assert.equal(store.get('111').engagement.favourites, 99);
});

test('serializeStore is deterministic newest-first regardless of insert order', () => {
  const a = new Map();
  upsert(a, [fixture[0], fixture[1]]);
  const b = new Map();
  upsert(b, [fixture[1], fixture[0]]); // reversed insertion order
  assert.equal(serializeStore(a), serializeStore(b));
  const arr = JSON.parse(serializeStore(a));
  assert.deepEqual(arr.map((p) => p.id), ['112', '111'], 'newest first');
});

test('tailSince returns the newest stored time minus overlap (null when empty)', () => {
  assert.equal(tailSince(new Map()), null);
  const store = new Map();
  upsert(store, fixture);
  assert.equal(tailSince(store, 0), '2026-07-06T09:30:00.000Z');
});

test('parseTruthbrushOutput accepts NDJSON and a JSON array, skips junk', () => {
  const ndjson = `${JSON.stringify(fixture[0])}\n\n${JSON.stringify(fixture[1])}\nnot-json`;
  assert.deepEqual(parseTruthbrushOutput(ndjson).map((p) => p.id), ['111', '112']);
  assert.deepEqual(parseTruthbrushOutput(JSON.stringify(fixture)).map((p) => p.id), ['111', '112']);
  assert.deepEqual(parseTruthbrushOutput(''), []);
});

test('runTruthbrush fails loud when credentials are missing', () => {
  assert.throws(
    () => runTruthbrush({ noAuth: false, env: {} }),
    /missing Truth Social credentials/,
  );
});

test('runTruthbrush fails loud when the truthbrush binary is absent', () => {
  assert.throws(
    () => runTruthbrush({ noAuth: true, bin: '/nonexistent/truthbrush-xyz' }),
    /truthbrush not found on PATH/,
  );
});

test('hasCredentials recognizes token or username+password', () => {
  assert.equal(hasCredentials({}), false);
  assert.equal(hasCredentials({ TRUTHSOCIAL_TOKEN: 't' }), true);
  assert.equal(hasCredentials({ TRUTHSOCIAL_USERNAME: 'u' }), false);
  assert.equal(hasCredentials({ TRUTHSOCIAL_USERNAME: 'u', TRUTHSOCIAL_PASSWORD: 'p' }), true);
});
