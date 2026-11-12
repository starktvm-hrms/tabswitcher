import { useEffect, useRef, useState } from 'react';
import { hostApi, joinUrl, useLiveResults, type HostPoll, type PollResults } from './api';
import { BarChart } from './BarChart';
import { Qr } from './Qr';
import { WordCloud } from './WordCloud';

/**
 * A quiz on the presentation screen: the current question, ONE QR code for the whole
 * quiz, and live results for the question type (word cloud, bars, rating, answer wall).
 * The presenter steps through questions with Prev/Next (or a clicker / arrow keys);
 * phones follow automatically.
 */
export function PollStage({ poll, fallbackQuestion, active }: { poll: HostPoll; fallbackQuestion: string; active: boolean }) {
  const live = useLiveResults(poll.code);
  const r = live.results;
  const [showQr, setShowQr] = useState(true);
  // Multiple choice / rating: the presenter can keep results hidden while people vote.
  const [hideResults, setHideResults] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  // Confirmations are drawn inside the stage: a browser confirm() dialog would end fullscreen.
  const [ask, setAsk] = useState<{ text: string; yes: string; run: () => Promise<unknown> }>();
  const api = hostApi(poll);
  const url = joinUrl(poll.code);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(undefined);
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  // Quick clicker presses add up (2 × Next = two questions on); requests go out in order.
  const navTarget = useRef<number | null>(null);
  const navChain = useRef<Promise<unknown>>(Promise.resolve());
  const go = (d: -1 | 1) => {
    if (!r) return;
    const from = navTarget.current ?? r.current;
    const n = Math.max(0, Math.min(r.count - 1, from + d));
    if (n === from) return;
    navTarget.current = n;
    setHideResults(false);
    setAsk(undefined);
    navChain.current = navChain.current
      .then(() => api.go(n))
      .catch((e) => setErr((e as Error).message))
      .finally(() => { if (navTarget.current === n) navTarget.current = null; });
  };

  // Clickers send PageDown/PageUp (or arrows): step through questions while this quiz is on screen.
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (['PageDown', 'ArrowRight', 'ArrowDown'].includes(e.key)) { e.preventDefault(); goRef.current(1); }
      if (['PageUp', 'ArrowLeft', 'ArrowUp'].includes(e.key)) { e.preventDefault(); goRef.current(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  if (live.deleted) {
    return <div className="poll-stage"><div className="poll-msg">This quiz was deleted. Remove it from the list and create a new one.</div></div>;
  }

  const waiting = r ? (r.open ? (showQr ? 'Scan the QR code and answer on your phone' : 'Waiting for answers…') : 'Voting is closed') : 'Connecting…';
  const hideable = r?.type === 'choice' || r?.type === 'rating';

  return (
    <div className={`poll-stage ${showQr ? '' : 'no-qr'}`}>
      <header className="poll-head">
        {r && r.count > 1 && <div className="poll-kicker">{r.title} · Question {r.current + 1} of {r.count}</div>}
        <h2 className="poll-question">{r?.question ?? fallbackQuestion}</h2>
      </header>

      <div className="poll-body">
        <Results r={r} waiting={waiting} hidden={hideable && hideResults}
          onHideWord={(key, text) => setAsk({ text: `Hide “${text}” from the screen?`, yes: 'Hide', run: () => api.hide(key) })} />
        {showQr && (
          <aside className="poll-join">
            <Qr text={url} label="QR code to answer on your phone" />
            <div className="poll-join-text">
              <b className="poll-scan">Scan to answer</b>
              <span>with your phone camera</span>
            </div>
          </aside>
        )}
      </div>

      {ask && (
        <div className="poll-ask" role="alertdialog" aria-label={ask.text}>
          <span>{ask.text}</span>
          <button className="poll-btn danger" autoFocus onClick={() => { const a = ask; setAsk(undefined); run(a.run); }}>{ask.yes}</button>
          <button className="poll-btn" onClick={() => setAsk(undefined)}>Cancel</button>
        </div>
      )}

      <footer className="poll-foot">
        {r && r.count > 1 && (
          <div className="poll-nav">
            <button className="poll-btn" disabled={r.current === 0} onClick={() => go(-1)} aria-label="Previous question">◀ Prev</button>
            <span className="poll-pos">{r.current + 1} / {r.count}</span>
            <button className="poll-btn primary" disabled={r.current >= r.count - 1} onClick={() => go(1)} aria-label="Next question">Next ▶</button>
          </div>
        )}
        <span className={`poll-status ${r?.open ? 'open' : 'closed'}`}>{r ? (r.open ? '● Open' : '■ Closed') : '…'}</span>
        <span className="poll-count">{r ? countLabel(r) : ''}</span>
        {!live.connected && r && <span className="poll-warn">Reconnecting…</span>}
        {(err || live.error) && <span className="poll-warn">{err ?? live.error}</span>}
        <span className="grow" />
        <div className="poll-controls">
          <button className="poll-btn" onClick={() => setShowQr((s) => !s)}>{showQr ? 'Hide QR' : 'Show QR'}</button>
          {r && (
            <button className="poll-btn" disabled={busy} onClick={() => run(() => api.setOpen(!r.open))}>
              {r.open ? 'Close voting' : 'Reopen voting'}
            </button>
          )}
          {hideable && <button className="poll-btn" onClick={() => setHideResults((h) => !h)}>{hideResults ? 'Show results' : 'Hide results'}</button>}
          {r?.type === 'choice' && r.hasCorrect && (
            <button className="poll-btn" disabled={busy} onClick={() => { setHideResults(false); run(() => api.setRevealed(!r.revealed)); }}>
              {r.revealed ? 'Hide answer' : 'Reveal answer'}
            </button>
          )}
          {!!r?.hidden && <button className="poll-btn" disabled={busy} onClick={() => run(api.unhide)}>Show {r.hidden} hidden</button>}
          {!!r?.total && (
            <button className="poll-btn" disabled={busy} onClick={() => setAsk({ text: 'Delete all answers to this question?', yes: 'Delete all', run: api.clear })}>Clear</button>
          )}
        </div>
      </footer>
    </div>
  );
}

function countLabel(r: PollResults) {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  if (r.type === 'choice' || r.type === 'rating') return n(r.total, 'vote', 'votes');
  return `${n(r.total, 'answer', 'answers')} · ${n(r.participants, 'person', 'people')}`;
}

function Results({ r, waiting, hidden, onHideWord }: {
  r?: PollResults; waiting: string; hidden: boolean; onHideWord: (key: string, text: string) => void;
}) {
  if (!r) return <div className="cloud"><div className="cloud-empty">{waiting}</div></div>;
  switch (r.type) {
    case 'choice':
      return <BarChart options={r.options ?? []} counts={r.counts ?? []} correct={r.revealed ? r.correct : undefined} hidden={hidden} />;
    case 'rating':
      return <RatingChart counts={r.counts ?? []} average={r.average ?? null} low={r.lowLabel} high={r.highLabel} hidden={hidden} />;
    case 'open':
      return <OpenWall responses={r.responses ?? []} waiting={waiting} onHide={(id, text) => onHideWord(id, text)} />;
    default:
      return <WordCloud key={r.qid} words={r.words} emptyText={waiting} onWordClick={(w) => onHideWord(w.key, w.text)} />;
  }
}

/** Rating 1–5: big average with stars, and one column per score. */
function RatingChart({ counts, average, low, high, hidden }: { counts: number[]; average: number | null; low?: string; high?: string; hidden: boolean }) {
  const max = Math.max(1, ...counts);
  const total = counts.reduce((a, b) => a + b, 0);
  return (
    <div className="rating">
      <div className="rating-avg">
        <b>{hidden || average == null ? '–' : average.toFixed(1)}</b>
        <div className="rating-stars" aria-hidden>
          {[1, 2, 3, 4, 5].map((s) => (
            <span key={s} className="star"><span className="star-fill" style={{ width: hidden || average == null ? 0 : `${Math.max(0, Math.min(1, average - s + 1)) * 100}%` }}>★</span>★</span>
          ))}
        </div>
        <small>{hidden ? 'Results hidden' : `average of ${total} vote${total === 1 ? '' : 's'}`}</small>
      </div>
      <div className="rating-cols" role="list" aria-label="Votes per score">
        {counts.map((n, i) => (
          <div key={i} className="rating-col" role="listitem" aria-label={`${i + 1}: ${hidden ? 'hidden' : `${n} votes`}`}>
            <span className="rating-n">{hidden ? '' : n}</span>
            <div className="rating-bar"><i style={{ height: hidden ? 0 : `${(n / max) * 100}%` }} /></div>
            <span className="rating-label">{i + 1}</span>
          </div>
        ))}
        <div className="rating-ends"><span>{low}</span><span>{high}</span></div>
      </div>
    </div>
  );
}

/** Open text: newest answers as cards. Click a card to hide it. */
function OpenWall({ responses, waiting, onHide }: { responses: { id: string; text: string }[]; waiting: string; onHide: (id: string, text: string) => void }) {
  if (!responses.length) return <div className="cloud"><div className="cloud-empty">{waiting}</div></div>;
  return (
    <div className="wall">
      {responses.slice(0, 60).map((a) => (
        <button key={a.id} className="wall-card" title="Click to hide this answer" onClick={() => onHide(a.id, a.text.length > 40 ? `${a.text.slice(0, 40)}…` : a.text)}>
          {a.text}
        </button>
      ))}
    </div>
  );
}
