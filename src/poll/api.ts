import { useEffect, useState } from 'react';

/** Client for the poll server (server/poll-server.mjs), served under /api on the same origin. */

export type PollType = 'cloud' | 'choice' | 'rating' | 'open';
/** What phones get: the quiz position and the current question. */
export type PollInfo = {
  code: string; title: string; current: number; count: number;
  qid: string; type: PollType; question: string; open: boolean; perPerson: number;
  /** Multiple choice only. `correct` is present once the presenter reveals it. */
  options?: string[]; hasCorrect?: boolean; revealed?: boolean; correct?: number;
  /** Rating only. */
  lowLabel?: string; highLabel?: string; scale?: number;
};
export type CloudWord = { key: string; text: string; count: number };
export type PollResults = PollInfo & {
  total: number; participants: number; words: CloudWord[]; hidden: number;
  counts?: number[]; average?: number | null; responses?: { id: string; text: string }[];
};
/** One question as edited in the quiz editor (and returned by /admin). */
export type QuestionDef = {
  id?: string; type: PollType; question: string; perPerson?: number;
  options?: string[]; correct?: number | null; lowLabel?: string; highLabel?: string; answers?: number;
};
export type QuizDef = { title: string; questions: QuestionDef[] };

export type HostPoll = { code: string; hostKey: string };

export const TYPE_LABEL: Record<PollType, string> = { cloud: 'Word cloud', choice: 'Multiple choice', rating: 'Rating 1–5', open: 'Open text' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * JSON request to the poll server. Network errors, 429 (busy) and 5xx are retried
 * with backoff + jitter, so a burst of hundreds of phones on one venue Wi-Fi smooths
 * itself out instead of showing errors.
 */
async function call<T>(path: string, init: RequestInit & { hostKey?: string; retries?: number } = {}): Promise<T> {
  const { hostKey, retries = 4, ...rest } = init;
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    try {
      res = await fetch(`/api${path}`, {
        ...rest,
        headers: { 'Content-Type': 'application/json', ...(hostKey ? { 'X-Host-Key': hostKey } : {}), ...(rest.headers ?? {}) },
      });
    } catch {
      res = undefined;
    }
    const retryable = !res || res.status === 429 || res.status >= 500;
    if (retryable && attempt < retries) {
      await sleep(Math.min(8000, 600 * 2 ** attempt) * (0.5 + Math.random()));
      continue;
    }
    if (!res) throw new Error('Can’t reach the poll server. Check your connection and try again.');
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
    return body as T;
  }
}

export const createQuiz = (quiz: QuizDef) =>
  call<PollInfo & { hostKey: string }>('/polls', { method: 'POST', retries: 0, body: JSON.stringify(quiz) });
export const getPoll = (code: string) => call<PollInfo>(`/polls/${encodeURIComponent(code)}`, { retries: 2 });
/** Sends an answer to question `qid`: text (word cloud / open), choice (multiple choice) or value (rating). */
export const sendAnswer = (code: string, body: { pid: string; qid: string; text?: string; choice?: number; value?: number }) =>
  call<{ ok: true; left?: number; changed?: boolean }>(`/polls/${encodeURIComponent(code)}/answers`, { method: 'POST', body: JSON.stringify(body) });

export const hostApi = (p: HostPoll) => ({
  setOpen: (open: boolean) => call<PollResults>(`/polls/${p.code}`, { method: 'PATCH', hostKey: p.hostKey, body: JSON.stringify({ open }) }),
  go: (current: number) => call<PollResults>(`/polls/${p.code}`, { method: 'PATCH', hostKey: p.hostKey, body: JSON.stringify({ current }) }),
  admin: () => call<QuizDef & { code: string; current: number; count: number }>(`/polls/${p.code}/admin`, { hostKey: p.hostKey }),
  edit: (quiz: QuizDef) => call<PollResults>(`/polls/${p.code}/questions`, { method: 'PUT', hostKey: p.hostKey, body: JSON.stringify(quiz) }),
  setRevealed: (revealed: boolean) => call<PollResults>(`/polls/${p.code}`, { method: 'PATCH', hostKey: p.hostKey, body: JSON.stringify({ revealed }) }),
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
