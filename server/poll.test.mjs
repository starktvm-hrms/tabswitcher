import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { aggregate, checkAnswer, cleanText, isCode, makeCode, rateLimiter, wordKey } from './poll-core.mjs';
import { createPollServer } from './poll-server.mjs';

describe('poll core', () => {
  it('makes valid, unambiguous join codes', () => {
    for (let i = 0; i < 200; i++) {
      const c = makeCode();
      expect(isCode(c)).toBe(true);
      expect(c).not.toMatch(/[01OIL]/);
    }
    expect(isCode('ab12')).toBe(false);
  });

  it('cleans text: trims, collapses spaces, strips control chars, limits length', () => {
    expect(cleanText('  hello \n\t world  ', 40)).toBe('hello world');
    expect(cleanText('a\u0000b​c', 40)).toBe('a b c');
    expect(cleanText('x'.repeat(100), 40)).toHaveLength(40);
    expect(cleanText('😀'.repeat(50), 5)).toBe('😀😀😀😀😀');
    expect(cleanText(42, 40)).toBe('');
  });

  it('groups answers case- and punctuation-insensitively, showing the most common spelling', () => {
    expect(wordKey('  Teamwork! ')).toBe('teamwork');
    const words = aggregate([
      { text: 'Teamwork' }, { text: 'teamwork' }, { text: 'Teamwork!' }, { text: 'Trust' }, { text: 'AI' },
    ].map((a, i) => ({ ...a, pid: String(i) })), ['ai']);
    expect(words).toEqual([
      { key: 'teamwork', text: 'Teamwork', count: 3 },
      { key: 'trust', text: 'Trust', count: 1 },
    ]);
  });

  it('enforces open/closed, per-person limit and duplicate answers', () => {
    const poll = { open: true, perPerson: 2, answers: [{ pid: 'person-0001', text: 'Growth' }] };
    expect(checkAnswer(poll, 'person-0001', 'growth!')).toHaveProperty('error', 'You already sent that one.');
    expect(checkAnswer(poll, 'person-0001', 'Focus')).toEqual({ text: 'Focus', left: 0 });
    poll.answers.push({ pid: 'person-0001', text: 'Focus' });
    expect(checkAnswer(poll, 'person-0001', 'More')).toHaveProperty('error');
    expect(checkAnswer(poll, 'person-0002', '   ')).toHaveProperty('error');
    expect(checkAnswer(poll, 'x', 'Hi')).toHaveProperty('error', 'Invalid participant.');
    expect(checkAnswer({ ...poll, open: false }, 'person-0003', 'Hi')).toHaveProperty('error', 'Voting is closed.');
  });

  it('rate-limits per key within a window', () => {
    let t = 0;
    const allow = rateLimiter({ max: 2, windowMs: 1000, now: () => t });
    expect([allow('a'), allow('a'), allow('a'), allow('b')]).toEqual([true, true, false, true]);
    t = 1000;
    expect(allow('a')).toBe(true);
  });
});

describe('poll server (HTTP)', () => {
  let srv, base, dir;
  const req = (p, opts = {}) => fetch(base + p, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) } })
    .then(async (r) => ({ status: r.status, body: await r.json() }));

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'polls-'));
    srv = await createPollServer({ dataDir: dir, log: () => {} });
    await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${srv.server.address().port}`;
  });
  afterAll(async () => {
    srv.server.closeAllConnections?.();
    await new Promise((r) => srv.server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  it('runs a full poll: create, answer, live stream, moderate, close, persist, delete', async () => {
    const created = await req('/api/polls', { method: 'POST', body: JSON.stringify({ question: 'One word for today?', perPerson: 2 }) });
    expect(created.status).toBe(201);
    const { code, hostKey } = created.body;
    expect(isCode(code)).toBe(true);
    const host = { 'X-Host-Key': hostKey };

    // Lower-case codes from a typed URL still work.
    expect((await req(`/api/polls/${code.toLowerCase()}`)).body).toMatchObject({ question: 'One word for today?', open: true, perPerson: 2 });

    // Live stream: first event is the current state.
    const ctrl = new AbortController();
    const stream = await fetch(`${base}/api/polls/${code}/stream`, { signal: ctrl.signal });
    expect(stream.headers.get('content-type')).toBe('text/event-stream');
    const reader = stream.body.getReader();
    const events = [];
    const pump = (async () => {
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ done: true }));
        if (done) break;
        buf += new TextDecoder().decode(value);
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    })();

    const answer = (pid, text) => req(`/api/polls/${code}/answers`, { method: 'POST', body: JSON.stringify({ pid, text }) });
    expect((await answer('participant-1', 'Energy')).body).toEqual({ ok: true, left: 1 });
    expect((await answer('participant-2', 'energy')).status).toBe(201);
    expect((await answer('participant-2', 'Focus')).status).toBe(201);
    expect((await answer('participant-2', 'Third')).status).toBe(400); // limit 2

    await new Promise((r) => setTimeout(r, 400));
    const last = events.at(-1);
    expect(last.total).toBe(3);
    expect(last.participants).toBe(2);
    expect(last.words[0]).toMatchObject({ text: 'Energy', count: 2 });

    // Host-only actions are refused without the key.
    expect((await req(`/api/polls/${code}/clear`, { method: 'POST' })).status).toBe(403);
    expect((await req(`/api/polls/${code}/clear`, { method: 'POST', headers: { 'X-Host-Key': 'wrong' } })).status).toBe(403);

    // Moderation.
    const hidden = await req(`/api/polls/${code}/hide`, { method: 'POST', headers: host, body: JSON.stringify({ key: 'focus' }) });
    expect(hidden.body.words.map((w) => w.key)).toEqual(['energy']);
    expect(hidden.body.hidden).toBe(1);

    // Close voting.
    expect((await req(`/api/polls/${code}`, { method: 'PATCH', headers: host, body: JSON.stringify({ open: false }) })).body.open).toBe(false);
    expect((await answer('participant-3', 'Late')).status).toBe(409);

    // Persists across a restart.
    await srv.flush();
    expect(await readdir(dir)).toContain(`${code}.json`);
    const again = await createPollServer({ dataDir: dir, log: () => {} });
    expect(again.polls.get(code).questions[0].answers).toHaveLength(3);

    // Delete ends the stream and removes the file.
    expect((await req(`/api/polls/${code}`, { method: 'DELETE', headers: host })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(events.at(-1)).toEqual({ deleted: true });
    expect(await readdir(dir)).not.toContain(`${code}.json`);
    expect((await req(`/api/polls/${code}`)).status).toBe(404);
    ctrl.abort();
    await pump;
  });

  it('rejects bad input', async () => {
    expect((await req('/api/polls', { method: 'POST', body: JSON.stringify({ question: '   ' }) })).status).toBe(400);
    expect((await req('/api/polls', { method: 'POST', body: '{nope' })).status).toBe(400);
    expect((await req('/api/polls', { method: 'POST', body: JSON.stringify({ question: 'x'.repeat(70000) }) })).status).toBe(413);
    expect((await req('/api/polls/ZZZZZ')).status).toBe(404);
    expect((await req('/api/nothing')).status).toBe(404);
  });
});

describe('multiple-choice polls', () => {
  it('validates options and the correct answer', async () => {
    const { validateQuestion: validateNewPoll } = await import('./poll-core.mjs');
    expect(validateNewPoll({ type: 'choice', question: 'Q?', options: ['A'] })).toHaveProperty('error');
    expect(validateNewPoll({ type: 'choice', question: 'Q?', options: ['Yes', 'yes!'] })).toHaveProperty('error', 'Two options are the same.');
    expect(validateNewPoll({ type: 'choice', question: 'Q?', options: Array.from({ length: 9 }, (_, i) => `O${i}`) })).toHaveProperty('error');
    // Empty options are dropped and the correct index follows its label.
    expect(validateNewPoll({ type: 'choice', question: 'Q?', options: ['A', '', 'C', 'D'], correct: 2 }))
      .toEqual({ type: 'choice', question: 'Q?', options: ['A', 'C', 'D'], correct: 1, perPerson: 1 });
    expect(validateNewPoll({ type: 'choice', question: 'Q?', options: ['A', 'B'], correct: 7 }).correct).toBeNull();
  });

  let srv, base;
  beforeAll(async () => {
    srv = await createPollServer({ log: () => {} });
    await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${srv.server.address().port}`;
  });
  afterAll(async () => { srv.server.closeAllConnections?.(); await new Promise((r) => srv.server.close(r)); });
  const req = (p, opts = {}) => fetch(base + p, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) } })
    .then(async (r) => ({ status: r.status, body: await r.json() }));

  it('counts one changeable vote per person and hides the answer until revealed', async () => {
    const { body: created } = await req('/api/polls', { method: 'POST', body: JSON.stringify({ type: 'choice', question: 'Capital of India?', options: ['Mumbai', 'New Delhi', 'Kolkata'], correct: 1 }) });
    const { code, hostKey } = created;
    const info = (await req(`/api/polls/${code}`)).body;
    expect(info).toMatchObject({ type: 'choice', options: ['Mumbai', 'New Delhi', 'Kolkata'], hasCorrect: true, revealed: false });
    expect(info).not.toHaveProperty('correct');

    const vote = (pid, choice) => req(`/api/polls/${code}/answers`, { method: 'POST', body: JSON.stringify({ pid, choice }) });
    expect((await vote('person-aaaa', 1)).body).toEqual({ ok: true, choice: 1, changed: false });
    await vote('person-bbbb', 0);
    await vote('person-cccc', 1);
    expect((await vote('person-bbbb', 1)).body.changed).toBe(true); // changed mind
    expect((await vote('person-dddd', 5)).status).toBe(400);
    expect((await vote('person-dddd', 'x')).status).toBe(400);

    let r = (await req(`/api/polls/${code}/results`)).body;
    expect(r).toMatchObject({ type: 'choice', counts: [0, 3, 0], total: 3, participants: 3, hasCorrect: true, revealed: false });
    expect(r).not.toHaveProperty('correct');

    // Only the presenter can reveal.
    expect((await req(`/api/polls/${code}`, { method: 'PATCH', body: JSON.stringify({ revealed: true }) })).status).toBe(403);
    r = (await req(`/api/polls/${code}`, { method: 'PATCH', headers: { 'X-Host-Key': hostKey }, body: JSON.stringify({ revealed: true }) })).body;
    expect(r).toMatchObject({ revealed: true, correct: 1 });
    expect((await req(`/api/polls/${code}`)).body.correct).toBe(1);

    // Closed: votes refused. Clear resets counts.
    await req(`/api/polls/${code}`, { method: 'PATCH', headers: { 'X-Host-Key': hostKey }, body: JSON.stringify({ open: false }) });
    expect((await vote('person-eeee', 0)).status).toBe(409);
    r = (await req(`/api/polls/${code}/clear`, { method: 'POST', headers: { 'X-Host-Key': hostKey } })).body;
    expect(r.counts).toEqual([0, 0, 0]);
  });

  it('keeps old polls (no type) working as word clouds', async () => {
    const { body } = await req('/api/polls', { method: 'POST', body: JSON.stringify({ question: 'Words?' }) });
    expect(body.type).toBe('cloud');
    expect((await req(`/api/polls/${body.code}/answers`, { method: 'POST', body: JSON.stringify({ pid: 'person-zzzz', text: 'Hi' }) })).status).toBe(201);
  });
});
