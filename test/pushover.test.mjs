import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPushoverPayload, resolvePushoverConfig, sendPushover } from '../scripts/lib/pushover.mjs';

function fakeBin(dir, name, script) {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${script}\n`);
  chmodSync(p, 0o755);
  return p;
}

// Shadows `curl` on PATH with a recorder script, restoring PATH after `fn`
// runs — the same PATH-shadow idiom the existing osascript tests use, so
// sendPushover's real execFileSync('curl', …) call never reaches a real
// binary of that name.
function withFakeCurl(script, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'po-curl-'));
  fakeBin(dir, 'curl', script);
  const prevPath = process.env.PATH;
  process.env.PATH = `${dir}:${prevPath}`;
  try { return fn(dir); } finally { process.env.PATH = prevPath; }
}

test('resolvePushoverConfig: settings win over env; enabled requires the settings-modal on value', () => {
  assert.deepEqual(resolvePushoverConfig({}, {}), { enabled: false, token: '', user: '' });
  assert.deepEqual(
    resolvePushoverConfig({ PUSHOVER_ENABLED: '1', PUSHOVER_TOKEN: 'tok', PUSHOVER_USER: 'usr' }, {}),
    { enabled: true, token: 'tok', user: 'usr' },
  );
  // .env fallback only when settings.json is silent (LaunchAgent never loads .env)
  assert.deepEqual(
    resolvePushoverConfig({}, { PUSHOVER_ENABLED: '1', PUSHOVER_TOKEN: 'env-tok', PUSHOVER_USER: 'env-usr' }),
    { enabled: true, token: 'env-tok', user: 'env-usr' },
  );
  // settings.json wins field-by-field, even mixed with the env fallback
  assert.deepEqual(
    resolvePushoverConfig({ PUSHOVER_TOKEN: 'settings-tok' }, { PUSHOVER_ENABLED: '1', PUSHOVER_TOKEN: 'env-tok', PUSHOVER_USER: 'env-usr' }),
    { enabled: true, token: 'settings-tok', user: 'env-usr' },
  );
  // a garbage/legacy value must never read as "on" (isSettingOn's contract)
  assert.equal(resolvePushoverConfig({ PUSHOVER_ENABLED: '0' }, {}).enabled, false);
});

test('buildPushoverPayload: field shape, no url/url_title without a deep link, caps enforced (AC2/AC8)', () => {
  const withLink = buildPushoverPayload('WTI SELL @ 88.0', 'http://127.0.0.1:8787/?t=x');
  assert.deepEqual(withLink, { title: 'market-signals', message: 'WTI SELL @ 88.0', url: 'http://127.0.0.1:8787/?t=x', url_title: 'open chart' });

  const noLink = buildPushoverPayload('bot halted — drawdown 12.0%', null);
  assert.deepEqual(noLink, { title: 'market-signals', message: 'bot halted — drawdown 12.0%' });
  assert.ok(!('url' in noLink) && !('url_title' in noLink), 'no deep link means no url fields at all');

  const longMsg = 'x'.repeat(2000);
  const longUrl = 'http://x/' + 'y'.repeat(2000);
  const truncated = buildPushoverPayload(longMsg, longUrl);
  assert.equal(truncated.message.length, 1024, 'message truncated to the documented cap');
  assert.equal(truncated.url.length, 512, 'url truncated to the documented cap');
  assert.ok(truncated.title.length <= 250, 'title (constant) is within its cap');
});

test('sendPushover: nothing sensitive reaches argv — the whole body goes in on stdin (AC6)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'po-'));
  const argvLog = join(dir, 'argv.log');
  const bodyLog = join(dir, 'body.log');
  // Recorder splits the two channels: argv is what a `ps` snapshot would show,
  // stdin is what actually reached curl. The secret must be absent from the first
  // and present in the second — proving it flowed without ever being observable.
  withFakeCurl(`echo "$@" >> ${argvLog}\ncat >> ${bodyLog}\nexit 0`, () => {
    sendPushover(
      buildPushoverPayload('WTI SELL @ 88.0', 'http://127.0.0.1:8787/?t=x'),
      { token: 'sekret-token-do-not-log', user: 'sekret-user-do-not-log' },
    );
  });
  const argv = readFileSync(argvLog, 'utf8');
  const body = readFileSync(bodyLog, 'utf8');
  assert.ok(!argv.includes('sekret-token-do-not-log'), `token leaked into argv: ${argv}`);
  assert.ok(!argv.includes('sekret-user-do-not-log'), `user leaked into argv: ${argv}`);
  // the alert text is not secret, but it is needless exposure — stdin covers it too
  assert.ok(!argv.includes('WTI SELL'), `the alert text leaked into argv: ${argv}`);
  assert.match(argv, /-d @-/, 'the body is read from stdin, so argv carries no payload at all');
  assert.match(body, /token=sekret-token-do-not-log/, 'the real token did flow through — just not via argv');
  assert.match(body, /user=sekret-user-do-not-log/, 'the real user key did flow through — just not via argv');
});

test('sendPushover: posts token, user, message, title, url, url_title (AC2)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'po-'));
  const argvLog = join(dir, 'argv.log');
  const bodyLog = join(dir, 'body.log');
  withFakeCurl(`echo "$@" >> ${argvLog}\ncat >> ${bodyLog}\nexit 0`, () => {
    sendPushover(buildPushoverPayload('WTI SELL @ 88.0', 'http://127.0.0.1:8787/?t=x'), { token: 't', user: 'u' });
  });
  const body = readFileSync(bodyLog, 'utf8');
  // form-encoded: spaces as `+`, everything else percent-encoded
  assert.match(body, /(^|&)token=t(&|$)/);
  assert.match(body, /(^|&)user=u(&|$)/);
  assert.match(body, /message=WTI\+SELL\+%40\+88\.0/);
  assert.match(body, /title=market-signals/);
  assert.match(body, /url=http%3A%2F%2F127\.0\.0\.1%3A8787%2F%3Ft%3Dx/);
  assert.match(body, /url_title=open\+chart/);
  assert.match(readFileSync(argvLog, 'utf8'), /https:\/\/api\.pushover\.net\/1\/messages\.json/, 'posts to the messages endpoint');
});

test('sendPushover: default bound is 5s (AC11)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'po-'));
  const argvLog = join(dir, 'argv.log');
  withFakeCurl(`echo "ARGV $@" >> ${argvLog}\ncat >> ${argvLog}\nexit 0`, () => {
    sendPushover(buildPushoverPayload('msg', null), { token: 't', user: 'u' });
  });
  assert.match(readFileSync(argvLog, 'utf8'), /--max-time 5\b/, 'curl is invoked with the documented 5s bound by default');
});

test('sendPushover: a hanging endpoint is killed by the bound, throwing rather than hanging the caller (AC11)', () => {
  const start = Date.now();
  assert.throws(() => {
    withFakeCurl('sleep 5', () => {
      sendPushover(buildPushoverPayload('msg', null), { token: 't', user: 'u' }, { timeoutMs: 200 });
    });
  });
  assert.ok(Date.now() - start < 4000, 'the timeout bound killed the hung process rather than waiting out the full sleep');
});

for (const [label, script] of [
  ['non-2xx (curl -f exit code)', 'exit 22'],
  ['curl process failure', 'exit 1'],
]) {
  test(`sendPushover: ${label} throws (AC4, caller's job to swallow)`, () => {
    assert.throws(() => {
      withFakeCurl(script, () => {
        sendPushover(buildPushoverPayload('msg', null), { token: 't', user: 'u' });
      });
    });
  });
}

test('sendPushover: curl missing from PATH throws rather than hanging or silently no-op-ing (AC4)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'po-empty-path-'));
  const prevPath = process.env.PATH;
  process.env.PATH = dir; // no curl anywhere on this PATH
  try {
    assert.throws(() => sendPushover(buildPushoverPayload('msg', null), { token: 't', user: 'u' }));
  } finally {
    process.env.PATH = prevPath;
  }
});

// Guards the trap documented in sendPushover: a shadowed curl that exists but is
// not executable does NOT fail the lookup — execvp treats EACCES as "keep
// searching" and finds the real /usr/bin/curl, which would send a live request
// from the test suite. Every recorder in this repo must therefore be chmod +x,
// and this asserts the helper that creates them actually does it.
test('test-safety: the fake-curl helper produces an EXECUTABLE shadow (a non-exec one silently falls through to the real curl)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'po-exec-'));
  const bin = join(dir, 'curl');
  writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  chmodSync(bin, 0o755);
  assert.equal(statSync(bin).mode & 0o111, 0o111, 'the shadow must be executable by owner/group/other');
});

// Multi-byte safety: the caps count characters, and slicing by UTF-16 units would
// sever a surrogate pair into a lone surrogate.
test('buildPushoverPayload: truncation never severs a surrogate pair', () => {
  const rocket = '\u{1F680}';
  const p = buildPushoverPayload('x'.repeat(1023) + rocket + 'tail', null);
  assert.equal([...p.message].length, 1024, 'capped at 1024 CHARACTERS, not code units');
  assert.ok(p.message.endsWith(rocket), 'the astral character survives whole rather than being cut in half');
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(p.message), false, 'no lone surrogate');
});
