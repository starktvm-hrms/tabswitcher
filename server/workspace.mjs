// Workspaces: a presenter's playlist and uploaded files, stored on the server so the
// same presentations open on any computer. Access is by workspace id + secret key
// (only a hash of the key is stored). Uploaded files get unguessable URLs.
//
//   POST   /api/workspaces                              create → { id, key }
//   GET    /api/workspaces/:id                 (key)   { id, version, items, usage }
//   GET    /api/workspaces/:id/version         (key)   { version }      cheap change check
//   PUT    /api/workspaces/:id                 (key)   { items }  → { version }
//   POST   /api/workspaces/:id/files?name=&type=  (key, raw body) → { fileId, url, size }
//   DELETE /api/workspaces/:id/files/:fileId   (key)
//   GET    /files/:id/:fileId                           the file (Range supported, for video seeking)
// The key travels in the X-Workspace-Key header.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export const WS_LIMITS = {
  itemsBytes: 512 * 1024,
  items: 300,
  fileBytes: 500 * 1024 * 1024,
  quotaBytes: 5 * 1024 * 1024 * 1024,
  workspaces: 5000,
};

const TYPES = {
  'application/pdf': 'pdf',
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/ogg': 'ogv', 'video/x-m4v': 'm4v',
};
const MIME_BY_EXT = Object.fromEntries(Object.entries(TYPES).map(([m, e]) => [e, m]));

export const isWsId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{10,32}$/.test(s);
const isFileId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{16,40}\.[a-z0-9]{2,5}$/.test(s);
const hash = (k) => createHash('sha256').update(k).digest();

/** Guesses a file's MIME type from what the browser said or its name; null if unsupported. */
export function fileType(mime, name) {
  if (mime && TYPES[mime]) return mime;
  const ext = String(name ?? '').toLowerCase().split('.').pop();
  const alias = { jpeg: 'jpg', m4v: 'm4v', ogg: 'ogv' }[ext] ?? ext;
  return MIME_BY_EXT[alias] ?? null;
}

/** Keeps only the fields the app uses, so the stored JSON can't grow arbitrary data. */
export function sanitizeItems(items) {
  if (!Array.isArray(items)) return null;
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  return items.slice(0, WS_LIMITS.items).map((it) => {
    if (!it || typeof it !== 'object' || !str(it.id, 64)) return null;
    const out = {
      id: str(it.id, 64), name: str(it.name, 300) ?? '', kind: str(it.kind, 16) ?? 'embed',
      src: str(it.src, 4000) ?? '', source: str(it.source, 100) ?? '',
    };
    if (it.original) out.original = str(it.original, 4000);
    if (it.fileId) out.fileId = str(it.fileId, 64);
    if (it.size) out.size = Number(it.size) || 0;
    if (it.poll && typeof it.poll === 'object') out.poll = { code: str(it.poll.code, 8) ?? '', hostKey: str(it.poll.hostKey, 64) ?? '' };
    return out;
  }).filter(Boolean);
}

/** Parses a Range header for a file of `size` bytes. */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (start > end || start >= size) return 'unsatisfiable';
  return { start, end };
}

export async function createWorkspaces({ dataDir, json, readJson, log }) {
  const wsDir = dataDir ? path.join(dataDir, 'workspaces') : null;
  const filesDir = dataDir ? path.join(dataDir, 'files') : null;
  /** @type {Map<string, any>} */
  const spaces = new Map();
  if (wsDir) {
    await mkdir(wsDir, { recursive: true });
    await mkdir(filesDir, { recursive: true });
    for (const f of await readdir(wsDir)) {
      if (!f.endsWith('.json')) continue;
      try { const w = JSON.parse(await readFile(path.join(wsDir, f), 'utf8')); if (isWsId(w.id)) spaces.set(w.id, w); }
      catch (e) { log(`skipping unreadable workspace ${f}: ${e.message}`); }
    }
    log(`loaded ${spaces.size} workspace(s)`);
  }

  const save = async (w) => {
    w.updatedAt = Date.now();
    if (!wsDir) return;
    const file = path.join(wsDir, `${w.id}.json`);
    await writeFile(`${file}.tmp`, JSON.stringify(w));
    await rename(`${file}.tmp`, file);
  };
  const authed = (req, w) => {
    const k = req.headers['x-workspace-key'];
    if (typeof k !== 'string' || !k) return false;
    const a = hash(k), b = Buffer.from(w.keyHash, 'base64');
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const usage = (w) => (w.files ?? []).reduce((n, f) => n + f.size, 0);
  const view = (w) => ({ id: w.id, version: w.version, items: w.items, usage: { bytes: usage(w), quota: WS_LIMITS.quotaBytes, files: (w.files ?? []).length } });

  async function serveFile(req, res, wsId, fileId) {
    if (!isWsId(wsId) || !isFileId(fileId) || !filesDir) return json(res, 404, { error: 'Not found' });
    const file = path.join(filesDir, wsId, fileId);
    let st;
    try { st = await stat(file); } catch { return json(res, 404, { error: 'Not found' }); }
    const type = MIME_BY_EXT[fileId.split('.').pop()] ?? 'application/octet-stream';
    const headers = {
      'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      // SVGs could carry scripts: never let them run as a page on our origin.
      ...(type === 'image/svg+xml' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}),
    };
    const range = parseRange(req.headers.range, st.size);
    if (range === 'unsatisfiable') { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    if (range) {
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${st.size}`, 'Content-Length': range.end - range.start + 1 });
      if (req.method === 'HEAD') return res.end();
      return pipeline(createReadStream(file, range), res).catch(() => {});
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    return pipeline(createReadStream(file), res).catch(() => {});
  }

  async function upload(req, res, w, url) {
    const type = fileType(String(req.headers['content-type'] ?? '').split(';')[0], url.searchParams.get('name'));
    if (!type) return json(res, 415, { error: 'Only PDF, image and video files can be uploaded.' });
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > WS_LIMITS.fileBytes) return json(res, 413, { error: `Files can be up to ${WS_LIMITS.fileBytes / 1024 / 1024} MB.` });
    if (usage(w) + declared > WS_LIMITS.quotaBytes) return json(res, 413, { error: 'This workspace is full. Remove some files first.' });
    const fileId = `${randomBytes(18).toString('base64url')}.${TYPES[type]}`;
    const dir = path.join(filesDir, w.id);
    await mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${fileId}.part`);
    let size = 0;
    const counter = new (await import('node:stream')).Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > WS_LIMITS.fileBytes) return cb(Object.assign(new Error('too large'), { status: 413 }));
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, counter, createWriteStream(tmp));
    } catch (e) {
      await unlink(tmp).catch(() => {});
      if (e.status === 413) return json(res, 413, { error: `Files can be up to ${WS_LIMITS.fileBytes / 1024 / 1024} MB.` });
      throw e;
    }
    if (!size) { await unlink(tmp).catch(() => {}); return json(res, 400, { error: 'The file is empty.' }); }
    await rename(tmp, path.join(dir, fileId));
    w.files = [...(w.files ?? []), { id: fileId, size, type, name: String(url.searchParams.get('name') ?? '').slice(0, 200), at: Date.now() }];
    await save(w);
    return json(res, 201, { fileId, url: `/files/${w.id}/${fileId}`, size, type });
  }

  /** Returns true if it handled the request. */
  async function handle(req, res, url, { allowCreate, ip }) {
    const f = /^\/files\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (f && (req.method === 'GET' || req.method === 'HEAD')) { await serveFile(req, res, f[1], f[2]); return true; }
    if (!url.pathname.startsWith('/api/workspaces')) return false;

    if (url.pathname === '/api/workspaces' && req.method === 'POST') {
      if (!allowCreate(ip)) { json(res, 429, { error: 'Too many workspaces created. Try again later.' }); return true; }
      if (spaces.size >= WS_LIMITS.workspaces) { json(res, 503, { error: 'Workspace storage is full.' }); return true; }
      let id;
      do id = randomBytes(9).toString('base64url'); while (spaces.has(id));
      const key = randomBytes(24).toString('base64url');
      const w = { id, keyHash: hash(key).toString('base64'), version: 1, items: [], files: [], createdAt: Date.now() };
      spaces.set(id, w);
      await save(w);
      log(`workspace ${id} created`);
      json(res, 201, { id, key, version: 1 });
      return true;
    }

    const m = /^\/api\/workspaces\/([^/]+)(?:\/(version|files)(?:\/([^/]+))?)?$/.exec(url.pathname);
    const w = m && isWsId(m[1]) ? spaces.get(m[1]) : undefined;
    if (!w) { json(res, 404, { error: 'Workspace not found. Check the link.' }); return true; }
    if (!authed(req, w)) { json(res, 403, { error: 'Wrong or missing workspace key. Open the workspace with its full link.' }); return true; }
    const [, , sub, fileId] = m;

    if (!sub && req.method === 'GET') { json(res, 200, view(w)); return true; }
    if (sub === 'version' && req.method === 'GET') { json(res, 200, { version: w.version }); return true; }
    if (!sub && req.method === 'PUT') {
      const body = await readJson(req, WS_LIMITS.itemsBytes);
      const items = sanitizeItems(body.items);
      if (!items) { json(res, 400, { error: 'Invalid items.' }); return true; }
      w.items = items;
      w.version++;
      // Files no item has referenced for a day are deleted to free space. The grace
      // period covers uploads in flight and another computer saving an older list.
      const used = new Set(items.map((i) => i.fileId).filter(Boolean));
      for (const x of w.files ?? []) if (used.has(x.id)) x.at = Date.now();
      const orphans = (w.files ?? []).filter((x) => !used.has(x.id) && Date.now() - x.at > 24 * 3600_000);
      for (const o of orphans) await unlink(path.join(filesDir, w.id, o.id)).catch(() => {});
      w.files = (w.files ?? []).filter((x) => !orphans.includes(x));
      await save(w);
      json(res, 200, { version: w.version, usage: view(w).usage });
      return true;
    }
    if (sub === 'files' && !fileId && req.method === 'POST') { await upload(req, res, w, url); return true; }
    if (sub === 'files' && fileId && req.method === 'DELETE') {
      if (isFileId(fileId)) await unlink(path.join(filesDir, w.id, fileId)).catch(() => {});
      w.files = (w.files ?? []).filter((x) => x.id !== fileId);
      await save(w);
      json(res, 200, { ok: true });
      return true;
    }
    json(res, 405, { error: 'Method not allowed' });
    return true;
  }

  async function removeAll(id) {
    spaces.delete(id);
    if (wsDir) await rm(path.join(wsDir, `${id}.json`), { force: true });
    if (filesDir) await rm(path.join(filesDir, id), { recursive: true, force: true });
  }

  return { handle, spaces, removeAll };
}
