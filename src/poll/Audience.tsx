import { useEffect, useRef, useState, type FormEvent } from 'react';
import { getPoll, participantId, sendAnswer, sendVote, type PollInfo } from './api';

const MAX = 40;

/**
 * What people see after scanning the QR code: the question and a box to answer.
 * Opened at /p/CODE; /p alone asks for the code.
 */
export default function Audience({ code: initialCode }: { code?: string }) {
  const [code, setCode] = useState(initialCode?.toUpperCase());
  const [poll, setPoll] = useState<PollInfo>();
  const [loadErr, setLoadErr] = useState<string>();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string }>();
  const [left, setLeft] = useState<number>();
  const [sent, setSent] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }, []);

  useEffect(() => {
    if (!code) return;
    setLoadErr(undefined);
    getPoll(code).then((p) => { setPoll(p); document.title = p.question; }).catch((e) => setLoadErr((e as Error).message));
  }, [code]);

  // Multiple choice: check now and then so people see when voting closes or the answer is revealed.
  useEffect(() => {
    if (!code || poll?.type !== 'choice') return;
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') getPoll(code).then(setPoll).catch(() => { /* keep showing what we have */ });
    }, 6000);
    return () => window.clearInterval(t);
  }, [code, poll?.type]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!poll || !text.trim() || sending) return;
    setSending(true); setMsg(undefined);
    try {
      const r = await sendAnswer(poll.code, participantId(), text);
      setSent((s) => [...s, text.trim()]);
      setLeft(r.left);
      setText('');
      setMsg({ kind: 'ok', text: r.left > 0 ? `Sent! You can add ${r.left} more.` : 'Sent! Thanks for taking part.' });
      if (r.left > 0) inputRef.current?.focus();
    } catch (err) {
      const m = (err as Error).message;
      setMsg({ kind: 'err', text: m });
      if (/closed/i.test(m)) setPoll((p) => (p ? { ...p, open: false } : p));
      if (/up to/i.test(m)) setLeft(0);
    } finally {
      setSending(false);
    }
  };

  if (!code) {
    return (
      <main className="aud">
        <form className="aud-card" onSubmit={(e) => { e.preventDefault(); const v = String(new FormData(e.currentTarget).get('code') ?? '').trim().toUpperCase(); if (v) { history.replaceState(null, '', `/p/${v}`); setCode(v); } }}>
          <h1 className="aud-q">Join a poll</h1>
          <p className="muted">Enter the code shown on the screen.</p>
          <input name="code" className="aud-input aud-code" autoCapitalize="characters" autoComplete="off" maxLength={8} placeholder="e.g. K7QF2" aria-label="Poll code" autoFocus />
          <button className="aud-send" type="submit">Join</button>
        </form>
      </main>
    );
  }

  if (loadErr) {
    return (
      <main className="aud">
        <div className="aud-card">
          <h1 className="aud-q">Poll not found</h1>
          <p className="muted">This poll has ended or the link is incomplete. Please scan the QR code on the screen again.</p>
          <button className="aud-send" onClick={() => { history.replaceState(null, '', '/p'); setCode(undefined); }}>Enter a code</button>
        </div>
      </main>
    );
  }

  if (!poll) return <main className="aud"><div className="aud-card"><p className="muted">Loading…</p></div></main>;

  if (poll.type === 'choice' && poll.options) return <ChoiceAnswer poll={poll} onPoll={setPoll} />;

  const done = left === 0;
  return (
    <main className="aud">
      <form className="aud-card" onSubmit={submit}>
        <div className="aud-kicker">Live poll</div>
        <h1 className="aud-q">{poll.question}</h1>
        {!poll.open ? (
          <p className="aud-msg">Voting is closed. Look at the screen for the results.</p>
        ) : done ? (
          <p className="aud-msg ok">You’ve sent all your answers. Look at the screen to see them in the word cloud!</p>
        ) : (
          <>
            <input
              ref={inputRef}
              className="aud-input"
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, MAX))}
              maxLength={MAX}
              placeholder="Type a word or short phrase"
              aria-label="Your answer"
              autoComplete="off"
              enterKeyHint="send"
              autoFocus
            />
            <div className="aud-row">
              <span className="muted small">{poll.perPerson > 1 ? `Up to ${poll.perPerson} answers` : 'One answer'}</span>
              <span className="muted small">{text.length}/{MAX}</span>
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
    </main>
  );
}

/** Multiple choice: tap an option to vote; tap another to change your vote while voting is open. */
function ChoiceAnswer({ poll, onPoll }: { poll: PollInfo; onPoll: (p: PollInfo) => void }) {
  const storeKey = `poll-vote-${poll.code}`;
  const [mine, setMine] = useState<number | undefined>(() => {
    try { const v = localStorage.getItem(storeKey); return v == null ? undefined : Number(v); } catch { return undefined; }
  });
  const [sending, setSending] = useState<number>();
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string }>();
  const options = poll.options ?? [];

  const vote = async (i: number) => {
    if (!poll.open || sending !== undefined || i === mine) return;
    setSending(i); setMsg(undefined);
    try {
      const r = await sendVote(poll.code, participantId(), i);
      setMine(i);
      try { localStorage.setItem(storeKey, String(i)); } catch { /* private mode */ }
      setMsg({ kind: 'ok', text: r.changed ? 'Vote changed. Look at the screen for the results.' : 'Vote sent! Look at the screen for the results.' });
    } catch (err) {
      const m = (err as Error).message;
      setMsg({ kind: 'err', text: m });
      if (/closed/i.test(m)) onPoll({ ...poll, open: false });
    } finally {
      setSending(undefined);
    }
  };

  const revealed = poll.revealed && poll.correct != null;
  return (
    <main className="aud">
      <div className="aud-card">
        <div className="aud-kicker">{poll.hasCorrect ? 'Quiz' : 'Live poll'}</div>
        <h1 className="aud-q">{poll.question}</h1>
        <div className="aud-opts" role="radiogroup" aria-label="Options">
          {options.map((o, i) => (
            <button
              key={i}
              role="radio"
              aria-checked={mine === i}
              className={`aud-opt ${mine === i ? 'sel' : ''} ${revealed && poll.correct === i ? 'right' : ''}`}
              disabled={!poll.open || sending !== undefined}
              onClick={() => vote(i)}
            >
              <span className="opt-letter">{revealed && poll.correct === i ? '✓' : String.fromCharCode(65 + i)}</span>
              <span className="grow">{o}</span>
              {sending === i && <span className="muted small">Sending…</span>}
            </button>
          ))}
        </div>
        {revealed && mine !== undefined && (
          <p className={`aud-msg ${mine === poll.correct ? 'ok' : 'err'}`}>{mine === poll.correct ? 'Correct! 🎉' : `The answer is ${String.fromCharCode(65 + (poll.correct ?? 0))}: ${options[poll.correct ?? 0]}.`}</p>
        )}
        {!poll.open && !revealed && <p className="aud-msg">Voting is closed. Look at the screen for the results.</p>}
        {msg && poll.open && !revealed && <p className={`aud-msg ${msg.kind}`} role="status">{msg.text}</p>}
        {poll.open && mine !== undefined && !msg && <p className="muted small">You voted {String.fromCharCode(65 + mine)}. Tap another option to change your vote.</p>}
      </div>
    </main>
  );
}
