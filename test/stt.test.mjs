import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcribe } from '../scripts/stt.mjs';

// Hermetic: execFile and fetcher are injected — no real binary, no network.
const audio = join(tmpdir(), 'stt-test-fixture.webm');
writeFileSync(audio, Buffer.from('fake-audio'));
process.on('exit', () => { try { unlinkSync(audio); } catch { /* best-effort */ } });

test('no backend at all (no key, no sttBin) throws code=no-backend', async () => {
  await assert.rejects(() => transcribe(audio, { settings: {} }), (e) => e.code === 'no-backend');
});

test('local: sttBin without a key auto-routes local, returns trimmed stdout', async () => {
  let gotBin, gotArgs;
  const execFile = (bin, args) => { gotBin = bin; gotArgs = args; return '  hello world \n'; };
  const text = await transcribe(audio, { settings: { sttBin: '/usr/local/bin/whisper-wrap' }, execFile });
  assert.equal(gotBin, '/usr/local/bin/whisper-wrap');
  assert.deepEqual(gotArgs, [audio]);
  assert.equal(text, 'hello world');
});

test('explicit openai mode without a key throws code=no-backend (never silently local)', async () => {
  await assert.rejects(() => transcribe(audio, { settings: { sttMode: 'openai', sttBin: '/x' } }), (e) => e.code === 'no-backend');
});

test('default: a key present routes to OpenAI (gpt-4o-mini-transcribe) even with no sttMode', async () => {
  let url, opts;
  const fetcher = async (u, o) => { url = u; opts = o; return { ok: true, json: async () => ({ text: '  transcribed  ' }) }; };
  const text = await transcribe(audio, {
    settings: { OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: 'https://api.openai.com/v1/' },
    contentType: 'audio/webm', fetcher,
  });
  assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions'); // trailing slash trimmed
  assert.equal(opts.method, 'POST');
  assert.equal(opts.headers.authorization, 'Bearer sk-test');
  assert.ok(opts.body instanceof FormData && opts.body.get('model') === 'gpt-4o-mini-transcribe');
  assert.equal(text, 'transcribed');
});

test('explicit sttModel overrides the default', async () => {
  const fetcher = async () => ({ ok: true, json: async () => ({ text: 'x' }) });
  let model;
  await transcribe(audio, {
    settings: { OPENAI_API_KEY: 'k', sttModel: 'whisper-1' },
    fetcher: async (u, o) => { model = o.body.get('model'); return fetcher(); },
  });
  assert.equal(model, 'whisper-1');
});

test('openai: a non-ok response surfaces the status (not a no-backend)', async () => {
  const fetcher = async () => ({ ok: false, status: 401, text: async () => 'bad key' });
  await assert.rejects(
    () => transcribe(audio, { settings: { sttMode: 'openai', OPENAI_API_KEY: 'x' }, fetcher }),
    (e) => e.code !== 'no-backend' && /401/.test(e.message),
  );
});
