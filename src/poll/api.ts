import { useEffect, useState } from 'react';

/** Client for the poll server (server/poll-server.mjs), served under /api on the same origin. */

export type PollInfo = { code: string; question: string; open: boolean; perPerson: number };
export type CloudWord = { key: string; text: string; count: number };
export type PollResults = PollInfo & { total: number; participants: number; words: CloudWord[]; hidden: number };
export type HostPoll = { code: string; hostKey: string };

async function call<T>(path: string, init: RequestInit & { hostKey?: string } = {}): Promise<T> {
  const { hostKey, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...rest,
      headers: { 'Content-Type': 'application/json', ...(hostKey ? { 'X-Host-Key': hostKey } : {}), ...(rest.headers ?? {}) },
    });
  } catch {
    throw new Error('Can’t reach the poll server. Check your connection and try again.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export const createPoll = (question: string, perPerson: number) =>
  call<PollInfo & { hostKey: string }>('/polls', { method: 'POST', body: JSON.stringify({ question, perPerson }) });
export const getPoll = (code: string) => call<PollInfo>(`/polls/${encodeURIComponent(code)}`);
export const sendAnswer = (code: string, pid: string, text: string) =>
  call<{ ok: true; left: number }>(`/polls/${encodeURIComponent(code)}/answers`, { method: 'POST', body: JSON.stringify({ pid, text }) });

export const hostApi = (p: HostPoll) => ({
  setOpen: (open: boolean) => call<PollResults>(`/polls/${p.code}`, { method: 'PATCH', hostKey: p.hostKey, body: JSON.stringify({ open }) }),
  setQuestion: (question: string) => call<PollResults>(`/polls/${p.code}`, { method: 'PATCH', hostKey: p.hostKey, body: JSON.stringify({ question }) }),
  hide: (key: string) => call<PollResults>(`/polls/${p.code}/hide`, { method: 'POST', hostKey: p.hostKey, body: JSON.stringify({ key }) }),
  unhide: () => call<PollResults>(`/polls/${p.code}/unhide`, { method: 'POST', hostKey: p.hostKey }),
  clear: () => call<PollResults>(`/polls/${p.code}/clear`, { method: 'POST', hostKey: p.hostKey }),
  remove: () => call<{ ok: true }>(`/polls/${p.code}`, { method: 'DELETE', hostKey: p.hostKey }),
});

/** The join link encoded in the QR code. */
export const joinUrl = (code: string) => `${window.location.origin}/p/${code}`;

/** A stable random id for this phone/browser, used to apply the per-person answer limit. */
export function participantId(): string {
  const make = () => (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`).replace(/[^\w-]/g, '');
  try {
    let id = localStorage.getItem('poll-participant');
    if (!id || !/^[\w-]{8,64}$/.test(id)) { id = make(); localStorage.setItem('poll-participant', id); }
    return id;
  } catch {
    return make();
  }
}

export type LiveState = { results?: PollResults; deleted?: boolean; connected: boolean; error?: string };

/** Live results over Server-Sent Events; EventSource reconnects by itself after drops. */
export function useLiveResults(code: string | undefined): LiveState {
  const [state, setState] = useState<LiveState>({ connected: false });
  useEffect(() => {
    if (!code) return;
    setState({ connected: false });
    const es = new EventSource(`/api/polls/${encodeURIComponent(code)}/stream`);
    es.onopen = () => setState((s) => ({ ...s, connected: true, error: undefined }));
    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.deleted) { setState({ deleted: true, connected: false }); es.close(); return; }
      setState({ results: data, connected: true });
    };
    es.onerror = () => {
      setState((s) => ({ ...s, connected: false }));
      // A 404 (poll gone) closes the stream for good; tell the presenter.
      if (es.readyState === EventSource.CLOSED) {
        fetch(`/api/polls/${encodeURIComponent(code)}`).then((r) => {
          if (r.status === 404) setState({ deleted: true, connected: false });
          else setState((s) => ({ ...s, error: 'Lost connection to the poll server. Retrying…' }));
        }).catch(() => setState((s) => ({ ...s, error: 'Lost connection to the poll server. Retrying…' })));
      }
    };
    return () => es.close();
  }, [code]);
  return state;
}
