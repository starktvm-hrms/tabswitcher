/** Client for server-side workspaces (server/workspace.mjs). */

import type { Presentation } from './present';

export type Creds = { id: string; key: string };
export type WorkspaceView = { id: string; version: number; items: Presentation[]; usage: { bytes: number; quota: number; files: number } };

const CREDS_KEY = 'seminar-workspace';

export function loadCreds(): Creds | null {
  try {
    const c = JSON.parse(localStorage.getItem(CREDS_KEY) ?? 'null');
    return c && typeof c.id === 'string' && typeof c.key === 'string' ? c : null;
  } catch {
    return null;
  }
}
export function saveCreds(c: Creds) {
  try { localStorage.setItem(CREDS_KEY, JSON.stringify(c)); } catch { /* private mode */ }
}

/** The link that opens this workspace on another computer. The key is in the #fragment, which browsers never send to servers. */
export const shareLink = (c: Creds) => `${window.location.origin}/w/${c.id}#${c.key}`;

/** Reads a workspace link (or the current address) into credentials. */
export function parseShareLink(text: string): Creds | null {
  const m = /\/w\/([A-Za-z0-9_-]{10,32})#([A-Za-z0-9_-]{20,64})\s*$/.exec(text.trim());
  return m ? { id: m[1], key: m[2] } : null;
}

export class HttpError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function call<T>(c: Creds | null, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/workspaces${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(c ? { 'X-Workspace-Key': c.key } : {}), ...(init.headers ?? {}) },
    });
  } catch {
    throw new HttpError('Can’t reach the server.', 0);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(body.error ?? `Request failed (${res.status})`, res.status);
  return body as T;
}

export const createWorkspace = () => call<Creds & { version: number }>(null, '', { method: 'POST' });
export const getWorkspace = (c: Creds) => call<WorkspaceView>(c, `/${c.id}`);
export const getVersion = (c: Creds) => call<{ version: number }>(c, `/${c.id}/version`);
export const putItems = (c: Creds, items: Presentation[]) =>
  call<{ version: number; usage: WorkspaceView['usage'] }>(c, `/${c.id}`, { method: 'PUT', body: JSON.stringify({ items }) });
export const deleteFile = (c: Creds, fileId: string) => call<{ ok: true }>(c, `/${c.id}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });

/** Uploads a file with progress (fetch has no upload progress, so this uses XHR). */
export function uploadFile(c: Creds, file: Blob, name: string, type: string, onProgress: (fraction: number) => void) {
  return new Promise<{ fileId: string; url: string; size: number }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/workspaces/${c.id}/files?name=${encodeURIComponent(name)}`);
    xhr.setRequestHeader('X-Workspace-Key', c.key);
    xhr.setRequestHeader('Content-Type', type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let body: { error?: string } & Record<string, unknown> = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status === 201) resolve(body as never);
      else reject(new HttpError(body.error ?? (xhr.status === 413 ? 'The file is too large.' : `Upload failed (${xhr.status})`), xhr.status));
    };
    xhr.onerror = () => reject(new HttpError('Upload failed: can’t reach the server.', 0));
    xhr.send(file);
  });
}
