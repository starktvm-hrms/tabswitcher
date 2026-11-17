// Speech-to-text (ElevenLabs) and minutes of meeting (DeepSeek), called from the
// server so API keys never reach a browser. Plain node:http(s) — no dependencies —
// with long timeouts, because transcribing an hour of audio can take minutes.

import http from 'node:http';
import https from 'node:https';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

export const ELEVENLABS_URL = process.env.ELEVENLABS_API_URL ?? 'https://api.elevenlabs.io';
export const DEEPSEEK_URL = process.env.DEEPSEEK_API_URL ?? 'https://api.deepseek.com';
export const STT_MODELS = ['scribe_v2', 'scribe_v1'];
export const DEFAULT_CHAT_MODEL = 'deepseek-chat';

export class ApiError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

function request(url, { method = 'GET', headers = {}, body, timeoutMs = 30 * 60_000 } = {}) {
  const u = new URL(url);
  const lib = u.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode ?? 0, json, text });
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('The AI service took too long to answer.')));
    req.on('error', reject);
    if (body && typeof body.pipe === 'function') body.pipe(req);
    else req.end(body);
  });
}

/** Turns an API error body into a short readable message. */
export function apiMessage(res) {
  const j = res.json;
  const d = j?.detail;
  const msg = (typeof d === 'string' ? d : d?.message) ?? j?.error?.message ?? j?.message ?? (typeof j?.error === 'string' ? j.error : undefined);
  return (msg ?? res.text ?? '').toString().slice(0, 300) || `HTTP ${res.status}`;
}

/** Streams a multipart/form-data body: text fields, then one file. */
async function multipart(fields, file) {
  const boundary = `----seminar${randomBytes(12).toString('hex')}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name.replace(/"/g, '')}"\r\nContent-Type: ${file.type}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const size = (await stat(file.path)).size;
  const length = parts.reduce((n, p) => n + p.length, 0) + head.length + size + tail.length;
  const { PassThrough } = await import('node:stream');
  const out = new PassThrough();
  (async () => {
    for (const p of parts) out.write(p);
    out.write(head);
    for await (const chunk of createReadStream(file.path)) if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    out.end(tail);
  })().catch((e) => out.destroy(e));
  return { body: out, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(length) } };
}

// ---- ElevenLabs speech-to-text ------------------------------------------------

/**
 * Transcribes an audio file with speaker labels. Tries the newest Scribe model
 * first and falls back to the previous one if the account/API rejects it.
 */
export async function transcribe({ apiKey, filePath, fileName = 'audio.webm', mime = 'audio/webm', language, baseUrl = ELEVENLABS_URL }) {
  if (!apiKey) throw new ApiError('Add your ElevenLabs API key in AI settings first.', 400);
  let last;
  for (const model of STT_MODELS) {
    const { body, headers } = await multipart({
      model_id: model,
      diarize: 'true',
      tag_audio_events: 'true',
      timestamps_granularity: 'word',
      language_code: language || undefined,
    }, { path: filePath, name: fileName, type: mime });
    const res = await request(`${baseUrl}/v1/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': apiKey, Accept: 'application/json', ...headers }, body });
    if (res.status >= 200 && res.status < 300 && res.json) return { model, ...toTranscript(res.json) };
    last = res;
    const msg = apiMessage(res);
    if (/missing the permission/i.test(msg)) {
      throw new ApiError('Your ElevenLabs API key isn’t allowed to use Speech to Text. In ElevenLabs → Settings → API keys, edit the key and set “Speech to Text” to Access (or create a key without restrictions), then click Transcribe again.', res.status);
    }
    if (res.status === 401 || res.status === 403) throw new ApiError(`ElevenLabs refused the API key: ${msg}`, res.status);
    // Only a rejected model name is worth retrying with the older model.
    if (!(res.status === 400 || res.status === 422 || res.status === 404) || !/model/i.test(msg)) break;
  }
  throw new ApiError(`ElevenLabs transcription failed: ${apiMessage(last)}`, last.status);
}

const clock = (sec) => {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(r).padStart(2, '0')}`;
};

/**
 * Groups ElevenLabs words into speaker turns:
 *   [0:05] Speaker 1: Good morning everyone…
 */
export function toTranscript(data) {
  const words = Array.isArray(data.words) ? data.words : [];
  const speakerNames = new Map();
  const name = (id) => {
    if (!id) return 'Speaker';
    if (!speakerNames.has(id)) speakerNames.set(id, `Speaker ${speakerNames.size + 1}`);
    return speakerNames.get(id);
  };
  const segments = [];
  for (const w of words) {
    if (w.type === 'audio_event') {
      segments.push({ speaker: '', start: w.start ?? 0, text: w.text });
      continue;
    }
    const sp = name(w.speaker_id);
    const cur = segments[segments.length - 1];
    if (cur && cur.speaker === sp && w.type !== 'audio_event') cur.text += w.text;
    else if (w.type === 'spacing' && cur) cur.text += w.text;
    else segments.push({ speaker: sp, start: w.start ?? 0, text: w.text.replace(/^\s+/, '') });
  }
  const clean = segments.map((s) => ({ ...s, text: s.text.replace(/\s+/g, ' ').trim() })).filter((s) => s.text);
  const text = clean.length
    ? clean.map((s) => (s.speaker ? `[${clock(s.start)}] ${s.speaker}: ${s.text}` : `[${clock(s.start)}] ${s.text}`)).join('\n')
    : String(data.text ?? '').trim();
  return { language: data.language_code ?? null, text, speakers: speakerNames.size };
}

// ---- DeepSeek minutes of meeting ------------------------------------------------

async function chat({ apiKey, baseUrl, model, messages, maxTokens = 4000 }) {
  const res = await request(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: maxTokens, stream: false }),
    timeoutMs: 10 * 60_000,
  });
  if (res.status >= 200 && res.status < 300 && res.json?.choices?.[0]?.message) return res.json.choices[0].message.content ?? '';
  throw new ApiError(apiMessage(res), res.status);
}

/** Picks a usable chat model from DeepSeek's /models list (for when model names change). */
async function pickModel({ apiKey, baseUrl }) {
  const res = await request(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, timeoutMs: 30_000 });
  const ids = (res.json?.data ?? []).map((m) => m.id).filter(Boolean);
  return ids.find((id) => /chat|flash/i.test(id)) ?? ids.find((id) => !/reason|coder/i.test(id)) ?? ids[0];
}

/** Chat with automatic fallback if the configured model name is rejected. */
async function chatWithFallback(opts) {
  try {
    return { text: await chat(opts), model: opts.model };
  } catch (e) {
    if (e.status === 401 || e.status === 403) throw new ApiError(`DeepSeek refused the API key: ${e.message}`, e.status);
    if (!(e.status === 400 || e.status === 404 || e.status === 422) || !/model/i.test(e.message)) throw new ApiError(`DeepSeek failed: ${e.message}`, e.status);
    const alt = await pickModel(opts).catch(() => undefined);
    if (!alt || alt === opts.model) throw new ApiError(`DeepSeek failed: ${e.message}`, e.status);
    return { text: await chat({ ...opts, model: alt }), model: alt };
  }
}

const SYSTEM = `You are an experienced meeting secretary. You write clear, accurate Minutes of Meeting (MOM) from a transcript.
Rules:
- Use only what is in the transcript. Never invent names, numbers, dates or decisions. Write "Not specified" when something is unknown.
- Speakers may be labelled "Speaker 1", "Speaker 2"… unless names were added; keep the labels as they are.
- Be concise and specific. Prefer bullet points.
- Write in the same language as the transcript unless the instructions say otherwise.
- Output GitHub-flavoured Markdown only, no preamble.`;

const TEMPLATE = (meta) => `Write the minutes using exactly this structure:

# Minutes of Meeting — ${meta.title}
**Date:** ${meta.date}  ·  **Duration:** ${meta.duration}  ·  **Participants:** <speakers / names mentioned>

## Summary
<3–5 sentences>

## Topics discussed
<one bullet per topic, with the key points under it>

## Decisions
<bullets; "None recorded" if there are none>

## Action items
| # | Action | Owner | Due |
|---|--------|-------|-----|
<one row per action; "Not specified" for unknown owner/due>

## Open questions and risks
<bullets, or "None">

## Next steps
<bullets>`;

/** Rough split on line boundaries into chunks of at most `size` characters. */
export function chunkText(text, size) {
  const chunks = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > size) { chunks.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + (line.length > size ? line.slice(0, size) : line);
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/**
 * Writes minutes of meeting from a transcript. Long transcripts are first condensed
 * part by part ("map"), then the minutes are written from those notes ("reduce").
 */
export async function minutes({ apiKey, transcript, meta, instructions, model = DEFAULT_CHAT_MODEL, baseUrl = DEEPSEEK_URL, chunkSize = 60_000 }) {
  if (!apiKey) throw new ApiError('Add your DeepSeek API key in AI settings first.', 400);
  if (!transcript?.trim()) throw new ApiError('The transcript is empty.', 400);
  let source = transcript.trim();
  let usedModel = model;
  if (source.length > chunkSize) {
    const parts = chunkText(source, chunkSize);
    const notes = [];
    for (const [i, part] of parts.entries()) {
      const r = await chatWithFallback({
        apiKey, baseUrl, model: usedModel, maxTokens: 3000,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `This is part ${i + 1} of ${parts.length} of a meeting transcript. Write detailed notes of this part only: topics, key points, decisions, action items (with owner and due date when stated), open questions. Keep speaker labels and timestamps where useful.\n\n---\n${part}` },
        ],
      });
      usedModel = r.model;
      notes.push(`### Part ${i + 1}\n${r.text}`);
    }
    source = `(Notes condensed from a long transcript, in order)\n\n${notes.join('\n\n')}`;
  }
  const r = await chatWithFallback({
    apiKey, baseUrl, model: usedModel, maxTokens: 4000,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `${TEMPLATE(meta)}\n\n${instructions ? `Extra instructions from the organiser: ${instructions}\n\n` : ''}Transcript:\n---\n${source}` },
    ],
  });
  return { markdown: r.text.trim().replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/i, '$1'), model: r.model };
}
