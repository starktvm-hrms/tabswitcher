import { useEffect, useRef, useState, type FormEvent } from 'react';
import { getPoll, participantId, sendAnswer, type PollInfo } from './api';

const FOLLOW_MS = 2500;
const letter = (i: number) => String.fromCharCode(65 + i);

/**
 * What people see after scanning the QR code. The page follows the presenter: when
 * they move to the next question, it appears here by itself. Opened at /p/CODE.
 */
export default function Audience({ code: initialCode }: { code?: string }) {
  const [code, setCode] = useState(initialCode?.toUpperCase());
  const [poll, setPoll] = useState<PollInfo>();
  const [loadErr, setLoadErr] = useState<string>();

  useEffect(() => {
    document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }, []);

  // Load, then keep following the presenter's current question.
  useEffect(() => {
    if (!code) return;
    let stop = false;
    let loaded = false;
    const load = () => getPoll(code)
      .then((p) => { if (!stop) { loaded = true; setPoll(p); setLoadErr(undefined); document.title = p.title; } })
      .catch((e) => { if (!stop && !loaded) setLoadErr((e as Error).message); });
    load();
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') load(); }, FOLLOW_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { stop = true; window.clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [code]);

  if (!code) {
    return (
      <main className="aud">
        <form className="aud-card" onSubmit={(e) => { e.preventDefault(); const v = String(new FormData(e.currentTarget).get('code') ?? '').trim().toUpperCase(); if (v) { history.replaceState(null, '', `/p/${v}`); setCode(v); } }}>
          <h1 className="aud-q">Join</h1>
          <p className="muted">Scan the QR code on the screen with your phone camera.</p>
          <input name="code" className="aud-input aud-code" autoCapitalize="characters" autoComplete="off" maxLength={8} placeholder="or type the code" aria-label="Code" />
          <button className="aud-send" type="submit">Join</button>
        </form>
      </main>
    );
  }
  if (loadErr && !poll) {
    return (
      <main className="aud">
        <div className="aud-card">
          <h1 className="aud-q">Not found</h1>
          <p className="muted">This quiz has ended or the link is incomplete. Please scan the QR code on the screen again.</p>
        </div>
      </main>
    );
  }
  if (!poll) return <main className="aud"><div className="aud-card"><p className="muted">Loading…</p></div></main>;

  return (
    <main className="aud">
      {/* key: a new question starts with a fresh answer form */}
      <div className="aud-card" key={poll.qid}>
        <div className="aud-kicker">
          {poll.count > 1 ? `${poll.title} · Question ${poll.current + 1} of ${poll.count}` : poll.type === 'choice' && poll.hasCorrect ? 'Quiz' : 'Live poll'}
        </div>
        <h1 className="aud-q">{poll.question}</h1>
        {poll.type === 'choice' && <ChoiceAnswer poll={poll} onPoll={setPoll} />}
        {poll.type === 'rating' && <RatingAnswer poll={poll} onPoll={setPoll} />}
        {(poll.type === 'cloud' || poll.type === 'open') && <TextAnswer poll={poll} onPoll={setPoll} />}
      </div>
    </main>
  );
}

type Msg = { kind: 'ok' | 'err'; text: string };
const remember = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ } };
const recall = <T,>(key: string): T | undefined => { try { const v = localStorage.getItem(key); return v == null ? undefined : JSON.parse(v); } catch { return undefined; } };

/** Sends an answer for the current question. If the screen moved on or closed, refresh instead of nagging. */
function useSend(poll: PollInfo, onPoll: (p: PollInfo) => void) {
  const [msg, setMsg] = useState<Msg>();
  const [sending, setSending] = useState(false);
  const send = async (body: { text?: string; choice?: number; value?: number }) => {
    setSending(true); setMsg(undefined);
    try {
      return await sendAnswer(poll.code, { pid: participantId(), qid: poll.qid, ...body });
    } catch (err) {
      const m = (err as Error).message;
      setMsg({ kind: 'err', text: m });
      if (/closed/i.test(m)) onPoll({ ...poll, open: false });
      if (/moved/i.test(m)) getPoll(poll.code).then(onPoll).catch(() => {});
      return undefined;
    } finally {
      setSending(false);
    }
  };
  return { msg, setMsg, sending, send };
}

function Closed() {
  return <p className="aud-msg">Voting is closed for this question. Look at the screen — the next one will appear here.</p>;
}

/** Word cloud and open text: type and send (several answers if allowed). */
function TextAnswer({ poll, onPoll }: { poll: PollInfo; onPoll: (p: PollInfo) => void }) {
  const max = poll.type === 'open' ? 200 : 40;
  const key = `poll-sent-${poll.code}-${poll.qid}`;
  const [text, setText] = useState('');
  const [sent, setSent] = useState<string[]>(() => recall<string[]>(key) ?? []);
  const { msg, setMsg, sending, send } = useSend(poll, onPoll);
  const inputRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const left = poll.perPerson - sent.length;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || sending) return;
    const r = await send({ text });
    if (!r) return;
    const next = [...sent, text.trim()];
    setSent(next); remember(key, next); setText('');
    setMsg({ kind: 'ok', text: (r.left ?? 0) > 0 ? `Sent! You can add ${r.left} more.` : 'Sent! Look at the screen.' });
    if ((r.left ?? 0) > 0) (inputRef.current ?? areaRef.current)?.focus();
  };

  return (
    <form className="stack" style={{ gap: 12 }} onSubmit={submit}>
      {!poll.open ? <Closed /> : left <= 0 ? (
        <p className="aud-msg ok">Thanks! Look at the screen — the next question will appear here.</p>
      ) : (
        <>
          {poll.type === 'open' ? (
            <textarea ref={areaRef} className="aud-input" value={text} onChange={(e) => setText(e.target.value.slice(0, max))} maxLength={max} rows={4} placeholder="Type your answer" aria-label="Your answer" />
          ) : (
            <input ref={inputRef} className="aud-input" value={text} onChange={(e) => setText(e.target.value.slice(0, max))} maxLength={max} placeholder="Type a word or short phrase" aria-label="Your answer" autoComplete="off" enterKeyHint="send" />
          )}
          <div className="aud-row">
            <span className="muted small">{poll.perPerson > 1 ? `Up to ${poll.perPerson} answers` : 'One answer'}</span>
            <span className="muted small">{text.length}/{max}</span>
          </div>
          <button className="aud-send" type="submit" disabled={!text.trim() || sending}>{sending ? 'Sending…' : 'Send'}</button>
        </>
      )}
      {msg && <p className={`aud-msg ${msg.kind}`} role="status">{msg.text}</p>}
      {sent.length > 0 && (
        <div className="aud-sent">
          <span className="muted small">Your answers</span>
          <div>{sent.map((s, i) => <span key={i} className="aud-chip">{s}</span>)}</div>
        </div>
      )}
    </form>
  );
}

/** Multiple choice: tap an option; tap another to change your vote while voting is open. */
function ChoiceAnswer({ poll, onPoll }: { poll: PollInfo; onPoll: (p: PollInfo) => void }) {
  const key = `poll-vote-${poll.code}-${poll.qid}`;
  const [mine, setMine] = useState<number | undefined>(() => recall<number>(key));
  const [pending, setPending] = useState<number>();
  const { msg, setMsg, send } = useSend(poll, onPoll);
  const options = poll.options ?? [];
  const revealed = poll.revealed && poll.correct != null;

  const vote = async (i: number) => {
    if (!poll.open || pending !== undefined || i === mine) return;
    setPending(i);
    const r = await send({ choice: i });
    setPending(undefined);
    if (!r) return;
    setMine(i); remember(key, i);
    setMsg({ kind: 'ok', text: r.changed ? 'Vote changed.' : 'Vote sent! Look at the screen.' });
  };

  return (
    <>
      <div className="aud-opts" role="radiogroup" aria-label="Options">
        {options.map((o, i) => (
          <button key={i} role="radio" aria-checked={mine === i}
            className={`aud-opt ${mine === i ? 'sel' : ''} ${revealed && poll.correct === i ? 'right' : ''}`}
            disabled={!poll.open || pending !== undefined} onClick={() => vote(i)}>
            <span className="opt-letter">{revealed && poll.correct === i ? '✓' : letter(i)}</span>
            <span className="grow">{o}</span>
            {pending === i && <span className="muted small">Sending…</span>}
          </button>
        ))}
      </div>
      {revealed && mine !== undefined && (
        <p className={`aud-msg ${mine === poll.correct ? 'ok' : 'err'}`}>{mine === poll.correct ? 'Correct! 🎉' : `The answer is ${letter(poll.correct ?? 0)}: ${options[poll.correct ?? 0]}.`}</p>
      )}
      {!poll.open && !revealed && <Closed />}
      {msg && poll.open && !revealed && <p className={`aud-msg ${msg.kind}`} role="status">{msg.text}</p>}
      {poll.open && mine !== undefined && !msg && <p className="muted small">You voted {letter(mine)}. Tap another option to change your vote.</p>}
    </>
  );
}

/** Rating 1–5: tap a score; changeable while voting is open. */
function RatingAnswer({ poll, onPoll }: { poll: PollInfo; onPoll: (p: PollInfo) => void }) {
  const key = `poll-vote-${poll.code}-${poll.qid}`;
  const [mine, setMine] = useState<number | undefined>(() => recall<number>(key));
  const { msg, setMsg, sending, send } = useSend(poll, onPoll);

  const rate = async (v: number) => {
    if (!poll.open || sending || v === mine) return;
    const r = await send({ value: v });
    if (!r) return;
    setMine(v); remember(key, v);
    setMsg({ kind: 'ok', text: r.changed ? 'Rating changed.' : 'Thanks! Look at the screen.' });
  };

  return (
    <>
      <div className="aud-rating" role="radiogroup" aria-label="Rating from 1 to 5">
        {[1, 2, 3, 4, 5].map((v) => (
          <button key={v} role="radio" aria-checked={mine === v} aria-label={`${v} of 5`}
            className={`aud-star ${mine !== undefined && v <= mine ? 'on' : ''}`} disabled={!poll.open || sending} onClick={() => rate(v)}>
            <span aria-hidden>★</span><small>{v}</small>
          </button>
        ))}
      </div>
      <div className="aud-row"><span className="muted small">{poll.lowLabel}</span><span className="muted small">{poll.highLabel}</span></div>
      {!poll.open && <Closed />}
      {msg && poll.open && <p className={`aud-msg ${msg.kind}`} role="status">{msg.text}</p>}
    </>
  );
}
