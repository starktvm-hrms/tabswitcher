import { useState } from 'react';
import { hostApi, joinUrl, useLiveResults, type HostPoll } from './api';
import { Qr } from './Qr';
import { WordCloud } from './WordCloud';

/**
 * The poll as it appears on the presentation screen: question, QR code to join,
 * and the live word cloud. Presenter controls sit in a small bar at the bottom.
 */
export function PollStage({ poll, fallbackQuestion }: { poll: HostPoll; fallbackQuestion: string }) {
  const live = useLiveResults(poll.code);
  const r = live.results;
  const [showQr, setShowQr] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  // Confirmations are drawn inside the stage: a browser confirm() dialog would end fullscreen.
  const [ask, setAsk] = useState<{ text: string; yes: string; run: () => Promise<unknown> }>();
  const api = hostApi(poll);
  const url = joinUrl(poll.code);
  const prettyUrl = url.replace(/^https?:\/\//, '');

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(undefined);
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  if (live.deleted) {
    return <div className="poll-stage"><div className="poll-msg">This poll was deleted. Remove it from the list and create a new one.</div></div>;
  }

  return (
    <div className={`poll-stage ${showQr ? '' : 'no-qr'}`}>
      <header className="poll-head">
        <h2 className="poll-question">{r?.question ?? fallbackQuestion}</h2>
        {!showQr && <div className="poll-join-inline">Join at <b>{prettyUrl}</b></div>}
      </header>

      <div className="poll-body">
        <WordCloud
          words={r?.words ?? []}
          emptyText={r ? (r.open ? 'Scan the QR code and send your answer' : 'Voting is closed') : 'Connecting…'}
          onWordClick={(w) => setAsk({ text: `Hide “${w.text}” from the word cloud?`, yes: 'Hide', run: () => api.hide(w.key) })}
        />
        {showQr && (
          <aside className="poll-join">
            <Qr text={url} label={`QR code to join the poll at ${prettyUrl}`} />
            <div className="poll-join-text">
              <span>Scan or go to</span>
              <b>{prettyUrl}</b>
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
        <span className={`poll-status ${r?.open ? 'open' : 'closed'}`}>{r ? (r.open ? '● Voting open' : '■ Voting closed') : '…'}</span>
        <span className="poll-count">
          {r ? `${r.total} ${r.total === 1 ? 'answer' : 'answers'} · ${r.participants} ${r.participants === 1 ? 'person' : 'people'}` : ''}
        </span>
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
          {!!r?.hidden && <button className="poll-btn" disabled={busy} onClick={() => run(api.unhide)}>Show {r.hidden} hidden</button>}
          {!!r?.total && (
            <button className="poll-btn" disabled={busy} onClick={() => setAsk({ text: 'Delete all answers in this poll?', yes: 'Delete all', run: api.clear })}>Clear</button>
          )}
        </div>
      </footer>
    </div>
  );
}
