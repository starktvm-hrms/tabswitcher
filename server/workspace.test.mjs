import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileType, parseRange, sanitizeItems } from './workspace.mjs';
import { createPollServer } from './poll-server.mjs';

describe('workspace helpers', () => {
  it('parses Range headers', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=500-5000', 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange('bytes=2000-', 1000)).toBe('unsatisfiable');
    expect(parseRange(undefined, 1000)).toBeNull();
    expect(parseRange('items=1-2', 1000)).toBeNull();
  });
  it('accepts only PDF, image, video and audio types', () => {
    expect(fileType('application/pdf', 'x')).toBe('application/pdf');
    expect(fileType('', 'Deck.PDF')).toBe('application/pdf');
    expect(fileType('application/octet-stream', 'clip.mov')).toBe('video/quicktime');
    expect(fileType('text/html', 'evil.html')).toBeNull();
    expect(fileType('', 'deck.pptx')).toBeNull();
    expect(fileType('audio/mpeg', 'song.mp3')).toBe('audio/mpeg');
    expect(fileType('audio/x-wav', 'a.wav')).toBe('audio/wav');
    expect(fileType('audio/x-m4a', 'a.m4a')).toBe('audio/mp4');
    expect(fileType('', 'Speech.M4A')).toBe('audio/mp4');
    expect(fileType('', 'jingle.ogg')).toBe('audio/ogg');
    expect(fileType('', 'clip.ogv')).toBe('video/ogg');
    expect(fileType('image/jpg', 'x.jpg')).toBe('image/jpeg');
  });
  it('keeps only known item fields', () => {
    const out = sanitizeItems([{ id: 'a', name: 'N', kind: 'pdf', src: '/files/x/y.pdf', source: 'PDF', fileId: 'y.pdf', evil: 'x', stopOnLeave: true, poll: { code: 'ABCDE', hostKey: 'k', extra: 1 } }, null, { name: 'no id' }]);
    expect(out).toEqual([{ id: 'a', name: 'N', kind: 'pdf', src: '/files/x/y.pdf', source: 'PDF', fileId: 'y.pdf', stopOnLeave: true, poll: { code: 'ABCDE', hostKey: 'k' } }]);
    expect(sanitizeItems('nope')).toBeNull();
  });
});

describe('workspace API', () => {
  let srv, base, dir;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ws-'));
    srv = await createPollServer({ dataDir: dir, log: () => {} });
    await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${srv.server.address().port}`;
  });
  afterAll(async () => {
    srv.server.closeAllConnections?.();
    await new Promise((r) => srv.server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  it('stores items and files so another computer with the link sees them', async () => {
    const { id, key } = await fetch(`${base}/api/workspaces`, { method: 'POST' }).then((r) => r.json());
    const auth = { 'X-Workspace-Key': key };

    // Without the key: refused. Unknown workspace: 404.
    expect((await fetch(`${base}/api/workspaces/${id}`)).status).toBe(403);
    expect((await fetch(`${base}/api/workspaces/${id}`, { headers: { 'X-Workspace-Key': 'wrong' } })).status).toBe(403);
    expect((await fetch(`${base}/api/workspaces/doesnotexist1`, { headers: auth })).status).toBe(404);

    // Upload a PDF.
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5000, 65)]);
    const up = await fetch(`${base}/api/workspaces/${id}/files?name=Deck.pdf`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/pdf' }, body: pdf });
    expect(up.status).toBe(201);
    const file = await up.json();
    expect(file.url).toMatch(new RegExp(`^/files/${id}/[\\w-]+\\.pdf$`));

    // Wrong type refused.
    expect((await fetch(`${base}/api/workspaces/${id}/files?name=x.html`, { method: 'POST', headers: { ...auth, 'Content-Type': 'text/html' }, body: '<script>' })).status).toBe(415);

    // Save the list.
    const items = [
      { id: 'i1', name: 'Deck', kind: 'pdf', src: file.url, source: 'PDF', fileId: file.fileId },
      { id: 'i2', name: 'Poll', kind: 'poll', src: '', source: 'Word cloud poll', poll: { code: 'ABCDE', hostKey: 'secret' } },
    ];
    const put = await fetch(`${base}/api/workspaces/${id}`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) }).then((r) => r.json());
    expect(put.version).toBe(2);

    // "Another computer": same id + key → same items, version check is cheap.
    expect(await fetch(`${base}/api/workspaces/${id}/version`, { headers: auth }).then((r) => r.json())).toEqual({ version: 2 });
    const got = await fetch(`${base}/api/workspaces/${id}`, { headers: auth }).then((r) => r.json());
    expect(got.items).toEqual(items);
    expect(got.usage.files).toBe(1);

    // File download, full and ranged (video seeking).
    const full = await fetch(base + file.url);
    expect(full.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await full.arrayBuffer()).equals(pdf)).toBe(true);
    const part = await fetch(base + file.url, { headers: { Range: 'bytes=0-8' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 0-8/${pdf.length}`);
    expect(await part.text()).toBe('%PDF-1.4\n');
    expect((await fetch(`${base}/files/${id}/nope.pdf`)).status).toBe(404);
    expect((await fetch(`${base}/files/${id}/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);

    // Survives a server restart.
    const again = await createPollServer({ dataDir: dir, log: () => {} });
    expect(again.workspaces.spaces.get(id).items).toHaveLength(2);
  });

  it('serves SVGs with a sandboxing CSP', async () => {
    const { id, key } = await fetch(`${base}/api/workspaces`, { method: 'POST' }).then((r) => r.json());
    const up = await fetch(`${base}/api/workspaces/${id}/files?name=a.svg`, { method: 'POST', headers: { 'X-Workspace-Key': key, 'Content-Type': 'image/svg+xml' }, body: '<svg xmlns="http://www.w3.org/2000/svg"/>' }).then((r) => r.json());
    const r = await fetch(base + up.url);
    expect(r.headers.get('content-security-policy')).toContain('sandbox');
  });
});
