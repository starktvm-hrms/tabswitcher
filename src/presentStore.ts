import { useCallback, useEffect, useRef, useState } from 'react';
import type { Presentation } from './present';
import {
  HttpError, createWorkspace, deleteFile, getVersion, getWorkspace, loadCreds, parseShareLink, putItems, saveCreds, uploadFile,
  type Creds,
} from './workspace';

/**
 * Presentation playlist, stored in a server-side workspace so it opens on any
 * computer (see src/workspace.ts). A local copy is kept for a fast start and for
 * working through short network drops. Changes are saved automatically, and
 * changes made on another computer appear within a few seconds.
 *
 * Earlier versions kept the list in localStorage and files in IndexedDB; those are
 * uploaded into the workspace automatically the first time.
 */

export type SyncStatus = 'connecting' | 'saving' | 'saved' | 'offline' | 'error';
export type Upload = { id: string; name: string; progress: number };

const LEGACY_LIST = 'seminar-presentations';
const CACHE = 'seminar-workspace-cache';
const POLL_MS = 4000;

// ---- legacy IndexedDB files (read-only, for the one-time migration) ----
function legacyFile(id: string): Promise<Blob | undefined> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open('seminar-presenter', 1); } catch { return resolve(undefined); }
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onerror = () => resolve(undefined);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const get = db.transaction('files', 'readonly').objectStore('files').get(id);
        get.onsuccess = () => { resolve(get.result); db.close(); };
        get.onerror = () => { resolve(undefined); db.close(); };
      } catch { resolve(undefined); db.close(); }
    };
  });
}

const readJson = <T,>(key: string, fallback: T): T => {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
};
const writeJson = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* full / blocked */ } };

function initialItems(creds: Creds | null): Presentation[] {
  const cache = readJson<{ id?: string; items?: Presentation[] }>(CACHE, {});
  if (creds && cache.id === creds.id && Array.isArray(cache.items)) return cache.items;
  if (!creds) return readJson<Presentation[]>(LEGACY_LIST, []);
  return [];
}

const uid = () => `pr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const needsUpload = (p: Presentation) => (p.kind === 'pdf' || p.kind === 'image' || p.kind === 'video') && !p.src && !p.fileId;

export function usePresentations() {
  // A workspace link (/w/ID#KEY) opens that workspace in this browser.
  const [joined] = useState(() => {
    if (!window.location.pathname.startsWith('/w/')) return null;
    const c = parseShareLink(window.location.href);
    history.replaceState(null, '', '/');
    if (c) saveCreds(c);
    return c;
  });
  const [creds, setCreds] = useState<Creds | null>(() => joined ?? loadCreds());
  const [items, setItemsState] = useState<Presentation[]>(() => initialItems(joined ?? loadCreds()));
  const [status, setStatus] = useState<SyncStatus>('connecting');
  const [message, setMessage] = useState<string>();
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [missing, setMissing] = useState<Set<string>>(new Set());

  const itemsRef = useRef(items);
  const credsRef = useRef(creds);
  credsRef.current = creds;
  const version = useRef(0);
  const dirty = useRef(false);
  const saving = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);
  const retryTimer = useRef<number | undefined>(undefined);
  const ready = useRef(false);

  const apply = useCallback((next: Presentation[]) => {
    itemsRef.current = next;
    setItemsState(next);
    if (credsRef.current) writeJson(CACHE, { id: credsRef.current.id, items: next });
  }, []);

  const saveNow = useCallback(async () => {
    const c = credsRef.current;
    if (!c || !ready.current) return;
    if (saving.current) return; // the running save re-checks `dirty` when it finishes
    saving.current = true;
    dirty.current = false;
    let offline = false;
    setStatus('saving');
    try {
      const r = await putItems(c, itemsRef.current);
      version.current = r.version;
      setStatus(dirty.current ? 'saving' : 'saved');
      setMessage(undefined);
    } catch (e) {
      dirty.current = true;
      const err = e as HttpError;
      if (err.status === 0 || err.status >= 500) {
        offline = true;
        setStatus('offline');
        setMessage('Can’t reach the server — changes are kept in this browser and saved when the connection is back.');
        window.clearTimeout(retryTimer.current);
        retryTimer.current = window.setTimeout(() => { void saveNow(); }, 5000);
      } else {
        setStatus('error');
        setMessage(err.message);
      }
    } finally {
      saving.current = false;
      if (dirty.current && !offline) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => { void saveNow(); }, 300);
      }
    }
  }, []);

  /** Changes the list and saves it to the workspace shortly after. */
  const setItems = useCallback((fn: (list: Presentation[]) => Presentation[]) => {
    apply(fn(itemsRef.current));
    dirty.current = true;
    setStatus('saving');
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void saveNow(); }, 500);
  }, [apply, saveNow]);

  /** Uploads items that only exist in this browser (from before workspaces). */
  const migrateLocal = useCallback(async (c: Creds) => {
    const lost: string[] = [];
    for (const p of itemsRef.current.filter(needsUpload)) {
      const blob = await legacyFile(p.id);
      if (!blob) { lost.push(p.id); continue; }
      try {
        const up = await uploadFile(c, blob, p.name, blob.type, () => {});
        apply(itemsRef.current.map((x) => (x.id === p.id ? { ...x, src: up.url, fileId: up.fileId, size: up.size } : x)));
      } catch {
        lost.push(p.id);
      }
    }
    if (lost.length) setMissing(new Set(lost));
  }, [apply]);

  const load = useCallback(async (c: Creds, { replace }: { replace: boolean }) => {
    setStatus('connecting');
    try {
      const ws = await getWorkspace(c);
      version.current = ws.version;
      ready.current = true;
      if (replace || ws.items.length > 0 || itemsRef.current.length === 0) {
        apply(ws.items);
        setStatus('saved');
      } else {
        // Server workspace is empty but this browser has a list: move it up.
        await migrateLocal(c);
        dirty.current = true;
        await saveNow();
      }
      setMessage(undefined);
    } catch (e) {
      const err = e as HttpError;
      if (err.status === 403 || err.status === 404) {
        setStatus('error');
        setMessage(`${err.message} You can start a new workspace from “Use on another computer”.`);
      } else {
        setStatus('offline');
        setMessage('Can’t reach the server — showing the copy saved in this browser.');
        window.setTimeout(() => { void load(c, { replace }); }, 5000);
      }
    }
  }, [apply, migrateLocal, saveNow]);

  // Start: open the workspace from the link / this browser, or create one.
  useEffect(() => {
    (async () => {
      let c = credsRef.current;
      if (!c) {
        try {
          const created = await createWorkspace();
          c = { id: created.id, key: created.key };
          saveCreds(c);
          credsRef.current = c;
          setCreds(c);
        } catch {
          setStatus('offline');
          setMessage('Can’t reach the server — working in this browser only for now. Reload to try again.');
          return;
        }
      }
      await load(c, { replace: !!joined });
    })();
    return () => { window.clearTimeout(saveTimer.current); window.clearTimeout(retryTimer.current); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Pick up changes made on another computer.
  useEffect(() => {
    const t = window.setInterval(async () => {
      const c = credsRef.current;
      if (!c || !ready.current || dirty.current || saving.current || document.visibilityState !== 'visible') return;
      try {
        const { version: v } = await getVersion(c);
        if (v <= version.current) return;
        const ws = await getWorkspace(c);
        if (dirty.current || saving.current) return; // a local change started meanwhile; it wins
        version.current = ws.version;
        apply(ws.items);
        setStatus('saved');
      } catch { /* next tick */ }
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, [apply]);

  const addLink = useCallback((p: Omit<Presentation, 'id'>) => {
    const id = uid();
    setItems((list) => [...list, { ...p, id }]);
    return id;
  }, [setItems]);

  /** Uploads a file into the workspace, then adds it to the list. Resolves to an error message or undefined. */
  const addFile = useCallback(async (file: File, p: Omit<Presentation, 'id' | 'src'>): Promise<string | undefined> => {
    const c = credsRef.current;
    if (!c) return 'Not connected to the server yet — try again in a moment.';
    const upId = uid();
    setUploads((u) => [...u, { id: upId, name: file.name, progress: 0 }]);
    try {
      const up = await uploadFile(c, file, file.name, file.type, (f) =>
        setUploads((u) => u.map((x) => (x.id === upId ? { ...x, progress: f } : x))));
      setItems((list) => [...list, { ...p, id: uid(), src: up.url, fileId: up.fileId, size: up.size }]);
      return undefined;
    } catch (e) {
      return `${file.name}: ${(e as Error).message}`;
    } finally {
      setUploads((u) => u.filter((x) => x.id !== upId));
    }
  }, [setItems]);

  const update = useCallback((id: string, patch: Partial<Presentation>) => {
    setItems((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, [setItems]);

  const remove = useCallback((id: string) => {
    const gone = itemsRef.current.find((p) => p.id === id);
    setItems((list) => list.filter((p) => p.id !== id));
    const c = credsRef.current;
    if (c && gone?.fileId) deleteFile(c, gone.fileId).catch(() => { /* cleaned up later by the server */ });
  }, [setItems]);

  const reorder = useCallback((next: Presentation[]) => setItems(() => next), [setItems]);

  /** Opens a different workspace (from a pasted link) in this browser. */
  const switchWorkspace = useCallback(async (c: Creds) => {
    window.clearTimeout(saveTimer.current);
    if (dirty.current && credsRef.current) await saveNow();
    saveCreds(c);
    credsRef.current = c;
    setCreds(c);
    ready.current = false;
    dirty.current = false;
    await load(c, { replace: true });
  }, [load, saveNow]);

  /** Starts a new, empty workspace in this browser. */
  const newWorkspace = useCallback(async () => {
    const created = await createWorkspace();
    await switchWorkspace({ id: created.id, key: created.key });
  }, [switchWorkspace]);

  const srcOf = useCallback((p: Presentation) => p.src || undefined, []);

  return {
    items, srcOf, missing, addLink, addFile, update, remove, reorder,
    creds, status, message, uploads, switchWorkspace, newWorkspace,
  };
}
