import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyEdit, makeQuestion, migrate, validateNewPoll } from './poll-core.mjs';
import { createPollServer } from './poll-server.mjs';

describe('quiz model', () => {
  it('validates a quiz of mixed questions and reports which one is wrong', () => {
    const ok = validateNewPoll({ title: 'Day 1', questions: [
      { type: 'cloud', question: 'One word?' },
      { type: 'choice', question: 'Pick', options: ['A', 'B'], correct: 0 },
      { type: 'rating', question: 'Rate it', lowLabel: 'Meh' },
      { type: 'open', question: 'Any questions?' },
    ] });
    expect(ok.title).toBe('Day 1');
    expect(ok.questions.map((q) => q.type)).toEqual(['cloud', 'choice', 'rating', 'open']);
    expect(ok.questions[2]).toMatchObject({ lowLabel: 'Meh', highLabel: 'Excellent' });
    expect(validateNewPoll({ questions: [{ type: 'cloud', question: 'x' }, { type: 'choice', question: 'y', options: ['only'] }] }))
      .toEqual({ error: 'Question 2: Add at least 2 options.' });
    expect(validateNewPoll({ questions: [] })).toHaveProperty('error');
    // Old clients: a single question becomes a one-question quiz titled by the question.
    expect(validateNewPoll({ question: 'Solo?' })).toMatchObject({ title: 'Solo?', questions: [{ type: 'cloud', question: 'Solo?' }] });
  });

  it('converts a poll saved by the previous version', () => {
    const old = { code: 'ABCDE', type: 'choice', question: 'Q?', options: ['X', 'Y'], correct: 1, revealed: true, open: false, perPerson: 1, answers: [{ pid: 'p', choice: 1 }], hidden: [], hostHash: 'h' };
    const m = migrate(old);
    expect(m).toMatchObject({ code: 'ABCDE', title: 'Q?', current: 0, hostHash: 'h' });
    expect(m.questions[0]).toMatchObject({ id: 'q1', type: 'choice', options: ['X', 'Y'], correct: 1, revealed: true, open: false });
    expect(m.questions[0].answers).toHaveLength(1);
    expect(m).not.toHaveProperty('answers');
  });

  it('keeps answers when editing unless the question changed shape', () => {
    const poll = { title: 'T', current: 1, seq: 2, questions: [
      { ...makeQuestion({ type: 'cloud', question: 'A?', perPerson: 3 }, 'q1'), answers: [{ pid: 'x', text: 'hi' }] },
      { ...makeQuestion({ type: 'choice', question: 'B?', options: ['1', '2'], correct: null, perPerson: 1 }, 'q2'), answers: [{ pid: 'x', choice: 0 }] },
    ] };
    expect(applyEdit(poll, { questions: [
      { id: 'q2', type: 'choice', question: 'B (reworded)?', options: ['1', '2'] },
      { id: 'q1', type: 'cloud', question: 'A?' },
      { type: 'rating', question: 'New?' },
    ] })).toEqual({ ok: true });
    expect(poll.questions.map((q) => [q.id, q.question, q.answers.length])).toEqual([['q2', 'B (reworded)?', 1], ['q1', 'A?', 1], ['q3', 'New?', 0]]);
    expect(poll.current).toBe(0); // still on q2, now first
    applyEdit(poll, { questions: [{ id: 'q2', type: 'choice', question: 'B?', options: ['1', '2', '3'] }] });
    expect(poll.questions[0].answers).toHaveLength(0); // options changed → fresh
    expect(poll.questions[0].id).not.toBe('q2');
  });
});

describe('quiz API', () => {
  let srv, base, dir;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'quiz-'));
    // A poll file from the previous version must still load.
    await writeFile(path.join(dir, 'GHJKM.json'), JSON.stringify({ code: 'GHJKM', type: 'cloud', question: 'Old poll?', perPerson: 3, open: true, answers: [{ pid: 'person-old1', text: 'Hi' }], hidden: [], hostHash: 'x', createdAt: Date.now() }));
    srv = await createPollServer({ dataDir: dir, log: () => {} });
    await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${srv.server.address().port}`;
  });
  afterAll(async () => { srv.server.closeAllConnections?.(); await new Promise((r) => srv.server.close(r)); await rm(dir, { recursive: true, force: true }); });
  const req = (p, opts = {}) => fetch(base + p, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) } })
    .then(async (r) => ({ status: r.status, body: await r.json() }));

  it('loads polls saved by the previous version', async () => {
    const info = (await req('/api/polls/GHJKM')).body;
    expect(info).toMatchObject({ title: 'Old poll?', current: 0, count: 1, qid: 'q1', type: 'cloud' });
    expect((await req('/api/polls/GHJKM/results')).body.words).toEqual([{ key: 'hi', text: 'Hi', count: 1 }]);
  });

  it('runs a 4-question quiz behind one code', async () => {
    const { body: created } = await req('/api/polls', { method: 'POST', body: JSON.stringify({ title: 'Seminar quiz', questions: [
      { type: 'cloud', question: 'One word for today?' },
      { type: 'choice', question: 'Best session?', options: ['Keynote', 'Panel', 'Workshop'], correct: 1 },
      { type: 'rating', question: 'Rate the venue' },
      { type: 'open', question: 'What should we improve?', perPerson: 2 },
    ] }) });
    const { code, hostKey } = created;
    const host = { 'X-Host-Key': hostKey };
    const info = () => req(`/api/polls/${code}`).then((r) => r.body);
    const answer = (body) => req(`/api/polls/${code}/answers`, { method: 'POST', body: JSON.stringify(body) });
    const go = (current) => req(`/api/polls/${code}`, { method: 'PATCH', headers: host, body: JSON.stringify({ current }) });

    let i = await info();
    expect(i).toMatchObject({ title: 'Seminar quiz', current: 0, count: 4, qid: 'q1', type: 'cloud' });
    expect((await answer({ pid: 'person-0001', qid: 'q1', text: 'Fun' })).status).toBe(201);

    // Presenter moves to Q2: an answer still aimed at Q1 is refused.
    expect((await go(1)).body).toMatchObject({ current: 1, type: 'choice', counts: [0, 0, 0] });
    expect((await answer({ pid: 'person-0002', qid: 'q1', text: 'Late' })).body).toMatchObject({ moved: true });
    i = await info();
    expect(i).toMatchObject({ qid: 'q2', type: 'choice', options: ['Keynote', 'Panel', 'Workshop'], hasCorrect: true });
    await answer({ pid: 'person-0001', qid: 'q2', choice: 1 });
    await answer({ pid: 'person-0002', qid: 'q2', choice: 0 });

    // Q3 rating
    await go(2);
    for (const [p, v] of [['person-0001', 5], ['person-0002', 4], ['person-0003', 4]]) await answer({ pid: p, qid: 'q3', value: v });
    expect((await answer({ pid: 'person-0001', qid: 'q3', value: 3 })).body.changed).toBe(true);
    expect((await answer({ pid: 'person-0004', qid: 'q3', value: 9 })).status).toBe(400);
    let r = (await req(`/api/polls/${code}/results`)).body;
    expect(r).toMatchObject({ type: 'rating', counts: [0, 0, 1, 2, 0], average: 3.7, total: 3, lowLabel: 'Poor', highLabel: 'Excellent' });

    // Q4 open text, newest first; presenter hides one.
    await go(3);
    await answer({ pid: 'person-0001', qid: 'q4', text: 'More coffee breaks' });
    await answer({ pid: 'person-0002', qid: 'q4', text: 'Bigger screen please' });
    r = (await req(`/api/polls/${code}/results`)).body;
    expect(r.responses.map((x) => x.text)).toEqual(['Bigger screen please', 'More coffee breaks']);
    r = (await req(`/api/polls/${code}/hide`, { method: 'POST', headers: host, body: JSON.stringify({ key: r.responses[0].id }) })).body;
    expect(r.responses.map((x) => x.text)).toEqual(['More coffee breaks']);
    expect(r.hidden).toBe(1);

    // Back to Q2: its votes are still there; reveal works per question.
    r = (await go(1)).body;
    expect(r.counts).toEqual([1, 1, 0]);
    r = (await req(`/api/polls/${code}`, { method: 'PATCH', headers: host, body: JSON.stringify({ revealed: true }) })).body;
    expect(r).toMatchObject({ revealed: true, correct: 1 });
    expect((await go(9)).status).toBe(400);

    // Admin view for the editor (correct answers included, no answer data).
    const admin = (await req(`/api/polls/${code}/admin`, { headers: host })).body;
    expect(admin.questions.map((q) => [q.id, q.type, q.answers])).toEqual([['q1', 'cloud', 1], ['q2', 'choice', 2], ['q3', 'rating', 3], ['q4', 'open', 2]]);
    expect(admin.questions[1].correct).toBe(1);
    expect((await req(`/api/polls/${code}/admin`)).status).toBe(403);

    // Edit: drop Q1, add a new question at the end; Q2 keeps its votes and stays current.
    const edited = (await req(`/api/polls/${code}/questions`, { method: 'PUT', headers: host, body: JSON.stringify({
      title: 'Seminar quiz (v2)',
      questions: [...admin.questions.slice(1), { type: 'cloud', question: 'Last words?' }],
    }) })).body;
    expect(edited).toMatchObject({ title: 'Seminar quiz (v2)', count: 4, current: 0, qid: 'q2', counts: [1, 1, 0] });
  });
});
