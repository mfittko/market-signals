import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripHtml, normalizePost, ingest } from '../scripts/fetch-trump-posts.mjs';

test('stripHtml removes tags and decodes common entities', () => {
  assert.equal(stripHtml('<p>Tariffs on <b>China</b> &amp; Mexico!</p>'), 'Tariffs on China & Mexico!');
  assert.equal(stripHtml('a&nbsp;&nbsp;b'), 'a b');
});

test('normalizePost maps CNN fields to the normalized shape', () => {
  const p = normalizePost({
    id: 123, created_at: '2026-07-10T14:35:00.000Z',
    content: '<p>Iran &gt; oil</p>', url: 'https://t/1',
    replies_count: 5, reblogs_count: 2, favourites_count: 9,
  });
  assert.equal(p.id, '123');
  assert.equal(p.createdAtISO, '2026-07-10T14:35:00.000Z');
  assert.equal(p.text, 'Iran > oil');
  assert.equal(p.url, 'https://t/1');
  assert.deepEqual(p.engagement, { replies: 5, reblogs: 2, favourites: 9 });
});

test('ingest window-filters, dedupes by id, and sorts newest-first', () => {
  const raw = [
    { id: 1, created_at: '2026-07-01T00:00:00Z', content: 'old' },
    { id: 2, created_at: '2026-07-05T00:00:00Z', content: 'in window' },
    { id: 2, created_at: '2026-07-05T00:00:00Z', content: 'dup id' },
    { id: 3, created_at: '2026-07-09T00:00:00Z', content: 'newer' },
    { id: 4, created_at: '2026-07-20T00:00:00Z', content: 'too new' },
    { id: 5, created_at: '2026-07-06T00:00:00Z', content: '' },
  ];
  const out = ingest(raw, {
    sinceMs: Date.parse('2026-07-04T00:00:00Z'),
    untilMs: Date.parse('2026-07-11T00:00:00Z'),
  });
  assert.deepEqual(out.map((p) => p.id), ['3', '2'], 'newest-first, in-window, deduped, empty dropped');
});
