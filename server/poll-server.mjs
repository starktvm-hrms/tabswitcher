#!/usr/bin/env node
// Live word-cloud poll server for the Seminar Presenter. Node.js only — no dependencies.
//
//   PORT=8791 DATA_DIR=./data node server/poll-server.mjs
//
// Public:   POST /api/polls                      create  → { code, hostKey }
//           GET  /api/polls/:code                 audience info
//           POST /api/polls/:code/answers         { pid, text } (word cloud) or { pid, choice } (multiple choice)
//           GET  /api/polls/:code/results         word-cloud data
//           GET  /api/polls/:code/stream          Server-Sent Events with live results
// Host only (header X-Host-Key):
//           PATCH  /api/polls/:code               { open?, question?, perPerson?, revealed? }
//           POST   /api/polls/:code/hide          { key }   hide a word from the cloud
//           POST   /api/polls/:code/unhide        show all hidden words again
//           POST   /api/polls/:code/clear         delete all answers
//           DELETE /api/polls/:code               delete the poll

import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createWorkspaces } from './workspace.mjs';
import {
  LIMITS, checkAnswer, checkVote, cleanText, pollType, isCode, makeCode, publicInfo, rateLimiter, results, validateNewPoll, wordKey,
} from './poll-core.mjs';

const MAX_POLLS = 2000;
const RETENTION_MS = 90 * 24 * 3600 * 1000;

export async function createPollServer({ dataDir, log = console.log } = {}) {
  /** @type {Map<string, any>} */
  const polls = new Map();
  /** @type {Map<string, Set<http.ServerResponse>>} */
  const streams = new Map();
  const saveTimers = new Map();
  const pushTimers = new Map();

  // ---- persistence -------------------------------------------------------
  if (dataDir) {
    await mkdir(dataDir, { recursive: true });
    for (const f of await readdir(dataDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const p = JSON.parse(await readFile(path.join(dataDir, f), 'utf8'));
        if (Date.now() - (p.updatedAt ?? p.createdAt) > RETENTION_MS) { await unlink(path.join(dataDir, f)); continue; }
        if (isCode(p.code)) polls.set(p.code, p);
      } catch (e) {
        log(`skipping unreadable poll file ${f}: ${e.message}`);
      }
    }
    log(`loaded ${polls.size} poll(s) from ${dataDir}`);
  }

  const save = (poll) => {
    poll.updatedAt = Date.now();
    if (!dataDir) return;
    clearTimeout(saveTimers.get(poll.code));
    saveTimers.set(poll.code, setTimeout(async () => {
      saveTimers.delete(poll.code);
      const file = path.join(dataDir, `${poll.code}.json`);
      try {
        await writeFile(`${file}.tmp`, JSON.stringify(poll));
        await rename(`${file}.tmp`, file);
      } catch (e) {
        log(`could not save poll ${poll.code}: ${e.message}`);
      }
    }, 300));
  };

  const flush = async () => {
    for (const [code, t] of saveTimers) {
      clearTimeout(t);
      const poll = polls.get(code);
      if (poll && dataDir) {
        const file = path.join(dataDir, `${code}.json`);
        await writeFile(`${file}.tmp`, JSON.stringify(poll));
        await rename(`${file}.tmp`, file);
      }
    }
    saveTimers.clear();
  };

  // ---- live updates --------------------------------------------------------
  const sendTo = (res, poll) => res.write(`data: ${JSON.stringify(poll ? results(poll) : { deleted: true })}\n\n`);
  /** Pushes results to every open stream for the poll, at most every 250 ms. */
  const push = (code) => {
    if (pushTimers.has(code)) return;
    pushTimers.set(code, setTimeout(() => {
      pushTimers.delete(code);
      const poll = polls.get(code);
      for (const res of streams.get(code) ?? []) sendTo(res, poll);
    }, 250));
  };
  const heartbeat = setInterval(() => {
    for (const set of streams.values()) for (const res of set) res.write(': ping\n\n');
  }, 25000);

  // ---- helpers ---------------------------------------------------------------
  const hash = (key) => createHash('sha256').update(key).digest();
  const isHost = (req, poll) => {
    const key = req.headers['x-host-key'];
    if (typeof key !== 'string' || !key) return false;
    const a = hash(key);
    const b = Buffer.from(poll.hostHash, 'base64');
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req, limit = LIMITS.bodyBytes) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    // Oversized bodies are drained (not cut off) so the client still receives the 413.
    req.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('end', () => {
      if (size > limit) return reject(Object.assign(new Error('Request too large'), { status: 413 }));
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
  // Behind nginx every request comes from 127.0.0.1; nginx passes the real address.
  const clientIp = (req) => {
    const direct = req.socket.remoteAddress ?? '';
    const fwd = req.headers['x-real-ip'];
    return (direct === '127.0.0.1' || direct === '::1' || direct === '::ffff:127.0.0.1') && typeof fwd === 'string' ? fwd : direct;
  };

  // A whole audience usually shares one venue Wi-Fi (one public IP), so per-IP limits
  // are sized for ~1000 people answering in the same minute; the per-participant
  // answer limit and the per-poll cap do the real work against spam.
  const allowCreate = rateLimiter({ max: 60, windowMs: 3600_000 });
  const allowAnswer = rateLimiter({ max: 6000, windowMs: 60_000 });
  const allowAny = rateLimiter({ max: 20000, windowMs: 60_000 });
  const allowWsCreate = rateLimiter({ max: 20, windowMs: 3600_000 });
  const workspaces = await createWorkspaces({ dataDir, json, readJson: readBody, log });

  // ---- routes ------------------------------------------------------------------
  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://x');
    const ip = clientIp(req);
    if (!allowAny(ip)) return json(res, 429, { error: 'Too many requests. Please wait a moment.' });

    if (url.pathname === '/api/health') return json(res, 200, { ok: true, polls: polls.size, workspaces: workspaces.spaces.size });
    if (await workspaces.handle(req, res, url, { allowCreate: allowWsCreate, ip })) return;

    if (url.pathname === '/api/polls' && req.method === 'POST') {
      if (!allowCreate(ip)) return json(res, 429, { error: 'Too many polls created. Try again later.' });
      if (polls.size >= MAX_POLLS) return json(res, 503, { error: 'Poll storage is full.' });
      const v = validateNewPoll(await readBody(req));
      if (v.error) return json(res, 400, v);
      let code;
      do code = makeCode(5); while (polls.has(code));
      const hostKey = randomBytes(24).toString('base64url');
      const poll = {
        code, type: v.type, question: v.question, perPerson: v.perPerson, open: true,
        ...(v.type === 'choice' ? { options: v.options, correct: v.correct, revealed: false } : {}),
        hostHash: hash(hostKey).toString('base64'), createdAt: Date.now(), answers: [], hidden: [],
      };
      polls.set(code, poll);
      save(poll);
      log(`poll ${code} created`);
      return json(res, 201, { code, hostKey, ...publicInfo(poll) });
    }

    const m = /^\/api\/polls\/([A-Za-z0-9]{4,8})(\/(answers|results|stream|hide|unhide|clear))?$/.exec(url.pathname);
    if (!m) return json(res, 404, { error: 'Not found' });
    const code = m[1].toUpperCase();
    const poll = isCode(code) ? polls.get(code) : undefined;
    if (!poll) return json(res, 404, { error: 'No poll with that code. Check the code on the screen.' });
    const action = m[3];

    if (!action && req.method === 'GET') return json(res, 200, publicInfo(poll));
    if (action === 'results' && req.method === 'GET') return json(res, 200, results(poll));

    if (action === 'stream' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n');
      sendTo(res, poll);
      let set = streams.get(code);
      if (!set) streams.set(code, (set = new Set()));
      set.add(res);
      req.on('close', () => { set.delete(res); if (!set.size) streams.delete(code); });
      return;
    }

    if (action === 'answers' && req.method === 'POST') {
      if (!allowAnswer(ip)) return json(res, 429, { error: 'Too many answers from this network. Please wait a moment.' });
      const body = await readBody(req);
      if (pollType(poll) === 'choice') {
        const v = checkVote(poll, body.pid, body.choice);
        if (v.error) return json(res, v.error === 'Voting is closed.' ? 409 : 400, v);
        const vote = { pid: body.pid, choice: v.choice, at: Date.now() };
        if (v.previous >= 0) poll.answers[v.previous] = vote; else poll.answers.push(vote);
        save(poll);
        push(code);
        return json(res, 201, { ok: true, choice: v.choice, changed: v.previous >= 0 });
      }
      const r = checkAnswer(poll, body.pid, body.text);
      if (r.error) return json(res, r.error === 'Voting is closed.' ? 409 : 400, r);
      poll.answers.push({ pid: body.pid, text: r.text, at: Date.now() });
      save(poll);
      push(code);
      return json(res, 201, { ok: true, left: r.left });
    }

    // Everything below needs the host key.
    if (!isHost(req, poll)) return json(res, 403, { error: 'Only the presenter can do that.' });

    if (!action && req.method === 'PATCH') {
      const body = await readBody(req);
      if (typeof body.open === 'boolean') poll.open = body.open;
      if (typeof body.revealed === 'boolean' && pollType(poll) === 'choice') poll.revealed = body.revealed;
      if (body.question !== undefined) {
        const q = cleanText(body.question, LIMITS.questionMax);
        if (!q) return json(res, 400, { error: 'Please enter a question.' });
        poll.question = q;
      }
      if (body.perPerson !== undefined && pollType(poll) === 'cloud') {
        const n = Number(body.perPerson);
        if (Number.isInteger(n) && n >= 1 && n <= LIMITS.perPersonMax) poll.perPerson = n;
      }
      save(poll); push(code);
      return json(res, 200, results(poll));
    }
    if (action === 'hide' && req.method === 'POST') {
      const k = wordKey(cleanText((await readBody(req)).key, LIMITS.answerMax * 2));
      if (k && !poll.hidden.includes(k)) poll.hidden.push(k);
      save(poll); push(code);
      return json(res, 200, results(poll));
    }
    if (action === 'unhide' && req.method === 'POST') {
      poll.hidden = [];
      save(poll); push(code);
      return json(res, 200, results(poll));
    }
    if (action === 'clear' && req.method === 'POST') {
      poll.answers = []; poll.hidden = [];
      save(poll); push(code);
      return json(res, 200, results(poll));
    }
    if (!action && req.method === 'DELETE') {
      polls.delete(code);
      clearTimeout(saveTimers.get(code)); saveTimers.delete(code);
      if (dataDir) await unlink(path.join(dataDir, `${code}.json`)).catch(() => {});
      for (const r of streams.get(code) ?? []) { sendTo(r, undefined); r.end(); }
      streams.delete(code);
      log(`poll ${code} deleted`);
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: 'Method not allowed' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) json(res, e.status ?? 500, { error: e.status ? e.message : 'Server error' });
      if (!e.status) log(`error: ${e.stack ?? e}`);
    });
  });
  server.on('close', () => clearInterval(heartbeat));
  // Long-lived SSE connections must not be cut by Node's default timeouts.
  server.requestTimeout = 0;
  server.headersTimeout = 15_000;
  return { server, polls, workspaces, flush };
}

// Run directly: `node server/poll-server.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8791);
  const host = process.env.HOST ?? '127.0.0.1';
  const { server, flush } = await createPollServer({ dataDir: process.env.DATA_DIR ?? path.resolve('poll-data') });
  server.listen(port, host, () => console.log(`poll server on http://${host}:${port}`));
  const stop = async () => { await flush().catch(() => {}); server.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
