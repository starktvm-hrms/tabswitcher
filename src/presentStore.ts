import { useCallback, useEffect, useRef, useState } from 'react';
import type { Presentation } from './present';

/**
 * Presentation playlist storage. The list (names, links, order) lives in
 * localStorage; uploaded files are Blobs in IndexedDB, which can hold far more
 * than localStorage and keeps PDFs/videos available after a reload.
 */

const LIST_KEY = 'seminar-presentations';
const DB = 'seminar-presenter';
const STORE = 'files';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

const putFile = (id: string, blob: Blob) => tx('readwrite', (s) => s.put(blob, id));
const getFile = (id: string) => tx<Blob | undefined>('readonly', (s) => s.get(id));
const delFile = (id: string) => tx('readwrite', (s) => s.delete(id));

function loadList(): Presentation[] {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    return raw ? (JSON.parse(raw) as Presentation[]) : [];
  } catch {
    return [];
  }
}

const uid = () => `pr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function usePresentations() {
  const [items, setItems] = useState<Presentation[]>(loadList);
  /** Object URLs for uploaded files, by presentation id. */
  const [fileUrls, setFileUrls] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const urlsRef = useRef(fileUrls);
  urlsRef.current = fileUrls;

  useEffect(() => {
    try { localStorage.setItem(LIST_KEY, JSON.stringify(items)); } catch { /* storage full / blocked */ }
  }, [items]);

  // Load blobs for file-based items that don't have a URL yet.
  useEffect(() => {
    let cancelled = false;
    const need = items.filter((p) => p.kind !== 'embed' && !p.src && !urlsRef.current[p.id] && !missing.has(p.id));
    if (!need.length) return;
    (async () => {
      const found: Record<string, string> = {};
      const lost: string[] = [];
      for (const p of need) {
        try {
          const blob = await getFile(p.id);
          if (blob) found[p.id] = URL.createObjectURL(blob);
          else lost.push(p.id);
        } catch {
          lost.push(p.id);
        }
      }
      if (cancelled) { Object.values(found).forEach(URL.revokeObjectURL); return; }
      setFileUrls((u) => ({ ...u, ...found }));
      if (lost.length) setMissing((m) => new Set([...m, ...lost]));
    })();
    return () => { cancelled = true; };
  }, [items, missing]);

  useEffect(() => () => Object.values(urlsRef.current).forEach(URL.revokeObjectURL), []);

  const addLink = useCallback((p: Omit<Presentation, 'id'>) => {
    setItems((list) => [...list, { ...p, id: uid() }]);
  }, []);

  const addFile = useCallback(async (file: File, p: Omit<Presentation, 'id' | 'src'>) => {
    const id = uid();
    const url = URL.createObjectURL(file);
    setFileUrls((u) => ({ ...u, [id]: url }));
    setItems((list) => [...list, { ...p, id, src: '' }]);
    try {
      await putFile(id, file);
      return true;
    } catch {
      return false; // still playable this session, just not saved
    }
  }, []);

  const update = useCallback((id: string, patch: Partial<Presentation>) => {
    setItems((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  const remove = useCallback((id: string) => {
    setItems((list) => list.filter((p) => p.id !== id));
    setFileUrls((u) => {
      if (u[id]) URL.revokeObjectURL(u[id]);
      const { [id]: _gone, ...rest } = u;
      return rest;
    });
    delFile(id).catch(() => { /* ignore */ });
  }, []);

  const reorder = useCallback((next: Presentation[]) => setItems(next), []);

  /** The URL to show for an item, or undefined while a file is loading / if it's gone. */
  const srcOf = useCallback((p: Presentation) => (p.kind === 'embed' || p.src ? p.src : fileUrls[p.id]), [fileUrls]);

  return { items, srcOf, missing, addLink, addFile, update, remove, reorder };
}
