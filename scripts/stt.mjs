// Speech-to-text backend router (#137). Two backends, chosen by settings.sttMode:
//  - local (default): a user-configured `sttBin` command, invoked as
//      `sttBin <audioFile>` with the transcript printed to stdout. The user wraps
//      whisper.cpp (plus any ffmpeg conversion) in that script, so the server
//      stays backend-agnostic — same pattern as piBin/notifierBin. No data leaves
//      the box and there's no API cost.
//  - openai: POST the recorded audio to the OpenAI transcription API (Whisper),
//      used only when sttMode==='openai' AND an OPENAI_API_KEY is configured.
// No usable backend ⇒ throws an Error with code 'no-backend' so the route can
// reply 400 and the UI can show a "configure STT" hint.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const noBackend = (msg) => Object.assign(new Error(msg), { code: 'no-backend' });

export async function transcribe(audioPath, { settings = {}, contentType = 'audio/webm', execFile = execFileSync, fetcher = fetch } = {}) {
  // Default to OpenAI (the box has no local STT model — pi's telegram voice
  // handler uses the OpenAI API too); only auto-route local when a sttBin is set
  // and no key is present. An explicit sttMode always wins.
  const mode = settings.sttMode || (settings.sttBin && !settings.OPENAI_API_KEY ? 'local' : 'openai');
  if (mode === 'openai') {
    if (!settings.OPENAI_API_KEY) throw noBackend('OpenAI STT needs an OPENAI_API_KEY (or set sttBin for a local backend)');
    return transcribeOpenAI(audioPath, contentType, settings, fetcher);
  }
  if (!settings.sttBin) throw noBackend('no STT backend configured — set sttBin (local) or add an OPENAI_API_KEY');
  // sttBin owns any format conversion; we just hand it the temp file path.
  const out = execFile(settings.sttBin, [audioPath], { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  return String(out).trim();
}

const EXT = (ct) => (/wav/.test(ct) ? 'wav' : /(mp4|m4a|aac)/.test(ct) ? 'm4a' : /ogg/.test(ct) ? 'ogg' : /mpeg|mp3/.test(ct) ? 'mp3' : 'webm');

async function transcribeOpenAI(audioPath, contentType, settings, fetcher) {
  const base = String(settings.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = settings.sttModel || 'gpt-4o-mini-transcribe'; // matches pi's telegram STT
  const fd = new FormData();
  fd.append('file', new Blob([readFileSync(audioPath)], { type: contentType }), `audio.${EXT(contentType)}`);
  fd.append('model', model);
  const r = await fetcher(`${base}/audio/transcriptions`, {
    method: 'POST', headers: { authorization: `Bearer ${settings.OPENAI_API_KEY}` }, body: fd,
  });
  if (!r.ok) throw new Error(`OpenAI transcription failed: ${r.status} ${String(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return String(j.text || '').trim();
}
