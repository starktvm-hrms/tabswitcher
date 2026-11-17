import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chunkText, minutes, toTranscript, transcribe } from './ai.mjs';
import { createPollServer } from './poll-server.mjs';

// ---- Fake ElevenLabs + DeepSeek --------------------------------------------------
const calls = { stt: [], chat: [], models: 0 };
let rejectModel = null; // e.g. 'scribe_v2' or 'deepseek-chat' to simulate a retired model
const WORDS = [
  { text: 'Good', start: 0.1, end: 0.3, type: 'word', speaker_id: 'speaker_0' },
  { text: ' ', type: 'spacing', speaker_id: 'speaker_0' },
  { text: 'morning.', start: 0.4, end: 0.8, type: 'word', speaker_id: 'speaker_0' },
  { text: '(laughter)', start: 1.0, end: 1.5, type: 'audio_event' },
  { text: 'Let', start: 62, end: 62.2, type: 'word', speaker_id: 'speaker_1' },
  { text: ' ', type: 'spacing', speaker_id: 'speaker_1' },
  { text: 'us', start: 62.3, end: 62.5, type: 'word', speaker_id: 'speaker_1' },
  { text: ' ', type: 'spacing', speaker_id: 'speaker_1' },
  { text: 'start.', start: 62.6, end: 63, type: 'word', speaker_id: 'speaker_1' },
];

function fakeApis() {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/v1/speech-to-text') {
        const text = body.toString('latin1');
        const field = (n) => new RegExp(`name="${n}"\\r\\n\\r\\n([^\\r]*)`).exec(text)?.[1];
        const call = { key: req.headers['xi-api-key'], model: field('model_id'), diarize: field('diarize'), lang: field('language_code'), hasFile: text.includes('name="file"; filename=') && text.includes('FAKEAUDIO'), length: Number(req.headers['content-length']), actual: body.length };
        calls.stt.push(call);
        if (call.key === 'el-restricted') return send(401, { detail: { status: 'missing_permissions', message: 'The API key you used is missing the permission speech_to_text to execute this operation.' } });
        if (call.key !== 'el-key-1234') return send(401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } });
        if (call.model === rejectModel) return send(422, { detail: { message: `model_id ${call.model} is not available` } });
        return send(200, { language_code: 'en', language_probability: 0.99, text: 'Good morning. Let us start.', words: WORDS });
      }
      if (req.url === '/models') { calls.models++; return send(200, { object: 'list', data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }] }); }
      if (req.url === '/chat/completions') {
        const j = JSON.parse(body.toString());
        calls.chat.push({ auth: req.headers.authorization, model: j.model, messages: j.messages });
        if (req.headers.authorization !== 'Bearer ds-key-5678') return send(401, { error: { message: 'Authentication Fails' } });
        if (j.model === rejectModel) return send(400, { error: { message: 'Model Not Exist' } });
        const last = j.messages.at(-1).content;
        const reply = last.includes('This is part') ? `notes for part ${last.match(/part (\d+)/)[1]}` : '```markdown\n# Minutes of Meeting — Test\n## Decisions\n- Ship it\n```';
        return send(200, { choices: [{ message: { role: 'assistant', content: reply } }] });
      }
      send(404, { error: 'nope' });
    });
  });
}

let fake, base, dir;
beforeAll(async () => {
  fake = fakeApis();
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${fake.address().port}`;
  dir = await mkdtemp(path.join(tmpdir(), 'ai-'));
});
afterAll(async () => { fake.close(); await rm(dir, { recursive: true, force: true }); });

describe('ElevenLabs speech-to-text', () => {
  it('groups words into timestamped speaker turns', () => {
    const t = toTranscript({ language_code: 'en', words: WORDS });
    expect(t.text).toBe('[0:00] Speaker 1: Good morning.\n[0:01] (laughter)\n[1:02] Speaker 2: Let us start.');
    expect(t.speakers).toBe(2);
    expect(toTranscript({ text: 'plain text only' }).text).toBe('plain text only');
  });

  it('uploads the file with diarization and the newest model, falling back if it is rejected', async () => {
    const file = path.join(dir, 'a.webm');
    await writeFile(file, Buffer.concat([Buffer.from('FAKEAUDIO'), Buffer.alloc(20000, 7)]));
    calls.stt = []; rejectModel = null;
    const t = await transcribe({ apiKey: 'el-key-1234', filePath: file, mime: 'audio/webm', language: 'en', baseUrl: base });
    expect(calls.stt).toHaveLength(1);
    expect(calls.stt[0]).toMatchObject({ model: 'scribe_v2', diarize: 'true', lang: 'en', hasFile: true });
    expect(calls.stt[0].length).toBe(calls.stt[0].actual); // Content-Length is exact
    expect(t).toMatchObject({ model: 'scribe_v2', speakers: 2, language: 'en' });

    calls.stt = []; rejectModel = 'scribe_v2';
    const t2 = await transcribe({ apiKey: 'el-key-1234', filePath: file, baseUrl: base });
    expect(calls.stt.map((c) => c.model)).toEqual(['scribe_v2', 'scribe_v1']);
    expect(t2.model).toBe('scribe_v1');
    rejectModel = null;

    await expect(transcribe({ apiKey: 'wrong', filePath: file, baseUrl: base })).rejects.toThrow(/refused the API key: Invalid API key/);
    await expect(transcribe({ apiKey: 'el-restricted', filePath: file, baseUrl: base })).rejects.toThrow(/set “Speech to Text” to Access/);
    await expect(transcribe({ apiKey: '', filePath: file, baseUrl: base })).rejects.toThrow(/Add your ElevenLabs API key/);
  });
});

describe('DeepSeek minutes of meeting', () => {
  const meta = { title: 'Weekly sync', date: '17 November 2026', duration: '30 min' };

  it('writes minutes from the transcript and strips a code fence', async () => {
    calls.chat = [];
    const r = await minutes({ apiKey: 'ds-key-5678', transcript: '[0:00] Speaker 1: hello', meta, instructions: 'Write in English', baseUrl: base });
    expect(r).toEqual({ markdown: '# Minutes of Meeting — Test\n## Decisions\n- Ship it', model: 'deepseek-chat' });
    expect(calls.chat[0].auth).toBe('Bearer ds-key-5678');
    const prompt = calls.chat[0].messages[1].content;
    expect(prompt).toContain('# Minutes of Meeting — Weekly sync');
    expect(prompt).toContain('| # | Action | Owner | Due |');
    expect(prompt).toContain('Extra instructions from the organiser: Write in English');
    expect(prompt).toContain('[0:00] Speaker 1: hello');
  });

  it('switches to an available model when the configured one is gone', async () => {
    calls.chat = []; calls.models = 0; rejectModel = 'deepseek-chat';
    const r = await minutes({ apiKey: 'ds-key-5678', transcript: 'x', meta, baseUrl: base });
    expect(calls.models).toBe(1);
    expect(r.model).toBe('deepseek-v4-flash');
    rejectModel = null;
  });

  it('condenses long transcripts part by part before writing the minutes', async () => {
    calls.chat = [];
    const long = Array.from({ length: 30 }, (_, i) => `[${i}:00] Speaker 1: ${'word '.repeat(40)}`).join('\n');
    await minutes({ apiKey: 'ds-key-5678', transcript: long, meta, baseUrl: base, chunkSize: 1000 });
    const parts = chunkText(long, 1000).length;
    expect(parts).toBeGreaterThan(3);
    expect(calls.chat).toHaveLength(parts + 1);
    expect(calls.chat.at(-1).messages[1].content).toContain('notes for part 1');
  });

  it('reports a bad key clearly', async () => {
    await expect(minutes({ apiKey: 'nope', transcript: 'x', meta, baseUrl: base })).rejects.toThrow(/DeepSeek refused the API key/);
  });
});

describe('meetings API (record → transcribe → minutes)', () => {
  let srv, api, wsDir;
  beforeAll(async () => {
    wsDir = await mkdtemp(path.join(tmpdir(), 'meet-'));
    srv = await createPollServer({ dataDir: wsDir, log: () => {}, ai: { elevenlabsUrl: base, deepseekUrl: base, env: {} } });
    await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
    api = `http://127.0.0.1:${srv.server.address().port}`;
  });
  afterAll(async () => { srv.server.closeAllConnections?.(); await new Promise((r) => srv.server.close(r)); await rm(wsDir, { recursive: true, force: true }); });

  it('runs the whole flow and never returns the API keys', async () => {
    const { id, key } = await fetch(`${api}/api/workspaces`, { method: 'POST' }).then((r) => r.json());
    const H = { 'X-Workspace-Key': key, 'Content-Type': 'application/json' };
    const j = (p, o = {}) => fetch(api + p, { ...o, headers: { ...H, ...(o.headers ?? {}) } }).then(async (r) => ({ status: r.status, body: await r.json() }));

    // Settings: keys are stored but only hints come back.
    expect((await j(`/api/workspaces/${id}/settings`)).body).toMatchObject({ elevenlabs: { configured: false }, deepseek: { configured: false } });
    expect((await fetch(`${api}/api/workspaces/${id}/settings`)).status).toBe(403);
    const set = (await j(`/api/workspaces/${id}/settings`, { method: 'PUT', body: JSON.stringify({ elevenlabsKey: ' el-key-1234 ', deepseekKey: 'ds-key-5678' }) })).body;
    expect(set).toEqual({ elevenlabs: { configured: true, hint: '…1234' }, deepseek: { configured: true, hint: '…5678', model: 'deepseek-chat' } });
    const everything = JSON.stringify((await j(`/api/workspaces/${id}`)).body) + JSON.stringify(set);
    expect(everything).not.toContain('el-key-1234');
    expect(everything).not.toContain('ds-key-5678');

    // Upload the audio recording, register the meeting.
    const up = await fetch(`${api}/api/workspaces/${id}/files?name=meeting.webm`, { method: 'POST', headers: { 'X-Workspace-Key': key, 'Content-Type': 'audio/webm;codecs=opus' }, body: Buffer.concat([Buffer.from('FAKEAUDIO'), Buffer.alloc(5000)]) }).then((r) => r.json());
    expect(up.type).toBe('audio/webm');
    expect((await j(`/api/workspaces/${id}/meetings`, { method: 'POST', body: JSON.stringify({ title: 'X', audioFileId: 'nope.weba' }) })).status).toBe(400);
    const meeting = (await j(`/api/workspaces/${id}/meetings`, { method: 'POST', body: JSON.stringify({ title: 'Weekly sync', audioFileId: up.fileId, durationSec: 1800, startedAt: Date.UTC(2026, 10, 17, 5, 0) }) })).body;
    expect(meeting).toMatchObject({ title: 'Weekly sync', durationSec: 1800, transcribe: { state: 'none' }, minutes: { state: 'none' } });

    // Minutes before a transcript: refused.
    expect((await j(`/api/workspaces/${id}/meetings/${meeting.id}/minutes`, { method: 'POST', body: '{}' })).body.error).toMatch(/Transcribe/);

    // Transcribe (background job) → poll until done.
    const wait = async (field) => {
      for (let i = 0; i < 50; i++) {
        const m = (await j(`/api/workspaces/${id}/meetings/${meeting.id}`)).body;
        if (m[field].state !== 'running') return m;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('timeout');
    };
    expect((await j(`/api/workspaces/${id}/meetings/${meeting.id}/transcribe`, { method: 'POST', body: JSON.stringify({ language: 'en' }) })).status).toBe(202);
    let m = await wait('transcribe');
    expect(m.transcribe.state).toBe('done');
    expect(m.transcript.text).toContain('Speaker 2: Let us start.');

    // Edit speaker names, then write the minutes.
    m = (await j(`/api/workspaces/${id}/meetings/${meeting.id}`, { method: 'PATCH', body: JSON.stringify({ transcript: m.transcript.text.replace(/Speaker 1/g, 'Priya') }) })).body;
    expect(m.transcript.text).toContain('Priya: Good morning.');
    calls.chat = [];
    expect((await j(`/api/workspaces/${id}/meetings/${meeting.id}/minutes`, { method: 'POST', body: JSON.stringify({ instructions: 'English please' }) })).status).toBe(202);
    m = await wait('minutes');
    expect(m.minutes.state).toBe('done');
    expect(m.minutesDoc.markdown).toContain('# Minutes of Meeting');
    expect(calls.chat.at(-1).messages[1].content).toContain('Priya: Good morning.');
    expect(calls.chat.at(-1).messages[1].content).toContain('**Duration:** 30 min');

    // The list shows status without the full text.
    const list = (await j(`/api/workspaces/${id}/meetings`)).body.meetings;
    expect(list[0]).toMatchObject({ id: meeting.id, hasTranscript: true, hasMinutes: true });
    expect(list[0]).not.toHaveProperty('transcript');

    // Saving the playlist must not clean up recordings; deleting the meeting removes its file.
    await j(`/api/workspaces/${id}`, { method: 'PUT', body: JSON.stringify({ items: [] }) });
    expect(await readdir(path.join(wsDir, 'files', id))).toContain(up.fileId);
    expect((await j(`/api/workspaces/${id}/meetings/${meeting.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await readdir(path.join(wsDir, 'files', id))).not.toContain(up.fileId);
  });

  it('shows a clear error when no key is set', async () => {
    const { id, key } = await fetch(`${api}/api/workspaces`, { method: 'POST' }).then((r) => r.json());
    const up = await fetch(`${api}/api/workspaces/${id}/files?name=a.webm`, { method: 'POST', headers: { 'X-Workspace-Key': key, 'Content-Type': 'audio/webm' }, body: 'FAKEAUDIO' }).then((r) => r.json());
    const mt = await fetch(`${api}/api/workspaces/${id}/meetings`, { method: 'POST', headers: { 'X-Workspace-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ audioFileId: up.fileId }) }).then((r) => r.json());
    const r = await fetch(`${api}/api/workspaces/${id}/meetings/${mt.id}/transcribe`, { method: 'POST', headers: { 'X-Workspace-Key': key, 'Content-Type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/ElevenLabs API key/);
  });
});
