import React, { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { useFullscreen } from './useFullscreen';
import { baseName, fileKind, move, toEmbed, type Presentation } from './present';
import { usePresentations } from './presentStore';
import { createPoll, hostApi, joinUrl } from './poll/api';
import { PollStage } from './poll/PollStage';
import { Qr } from './poll/Qr';
import { parseShareLink, shareLink } from './workspace';

/**
 * Presentation player. Browsers always leave fullscreen when you switch browser
 * tabs, so instead every presentation is loaded into one fullscreen "stage" in
 * this tab, and the on-screen bar switches which one is visible. Frames stay
 * mounted after their first view, so each deck keeps its current slide.
 */
export default function Presenter() {
  const store = usePresentations();
  const { items } = store;
  const [activeId, setActiveId] = useState<string | undefined>(items[0]?.id);
  const [link, setLink] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pollForm, setPollForm] = useState<false | 'cloud' | 'choice'>(false);
  const [pollOpts, setPollOpts] = useState<string[]>(['', '', '', '']);
  const [pollCorrect, setPollCorrect] = useState<number | null>(null);
  const [pollQ, setPollQ] = useState('');
  const [pollPer, setPollPer] = useState(3);
  const [pollBusy, setPollBusy] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const fullscreen = useFullscreen(stageRef, { lockEscape: false });

  // Keep a valid selection as items are added/removed.
  useEffect(() => {
    if (!items.some((p) => p.id === activeId)) setActiveId(items[0]?.id);
  }, [items, activeId]);

  const addLink = (e: FormEvent) => {
    e.preventDefault();
    if (!link.trim()) return;
    const r = toEmbed(link);
    if ('error' in r) { setErrors([r.error]); return; }
    store.addLink({ name: r.name, kind: 'embed', src: r.src, original: link.trim(), source: r.source });
    setLink('');
    setErrors([]);
  };

  const addFiles = async (files: FileList) => {
    const errs: string[] = [];
    for (const f of Array.from(files)) {
      const k = fileKind(f.name, f.type);
      if ('error' in k) { errs.push(k.error); continue; }
      const err = await store.addFile(f, { name: baseName(f.name), kind: k.kind, source: k.source });
      if (err) errs.push(err);
    }
    setErrors(errs);
  };

  const addPoll = async (e: FormEvent) => {
    e.preventDefault();
    if (!pollQ.trim() || pollBusy) return;
    setPollBusy(true);
    try {
      const created = await createPoll(pollForm === 'choice'
        ? { type: 'choice', question: pollQ, options: pollOpts, correct: pollCorrect }
        : { type: 'cloud', question: pollQ, perPerson: pollPer });
      const source = created.type === 'choice' ? (created.hasCorrect ? 'Quiz question' : 'Multiple-choice poll') : 'Word cloud poll';
      const id = store.addLink({ name: created.question, kind: 'poll', src: '', source, poll: { code: created.code, hostKey: created.hostKey } });
      setActiveId(id);
      setPollQ('');
      setPollOpts(['', '', '', '']);
      setPollCorrect(null);
      setPollForm(false);
      setErrors([]);
    } catch (err) {
      setErrors([(err as Error).message]);
    } finally {
      setPollBusy(false);
    }
  };

  const removeItem = (p: Presentation) => {
    const msg = p.poll ? `Delete the poll “${p.name}” and all its answers?` : `Remove “${p.name}”?`;
    if (!window.confirm(msg)) return;
    if (p.poll) hostApi(p.poll).remove().catch(() => { /* already gone */ });
    store.remove(p.id);
  };

  const presentFrom = (id?: string) => {
    if (id) setActiveId(id);
    if (!fullscreen.active) fullscreen.toggle();
  };

  return (
    <main className="main">
      <header className="page-head">
        <div>
          <h1>Seminar Presenter</h1>
          <p className="muted">
            Line up decks, PDFs, videos, audio and live polls (word cloud or multiple choice), then present them in one fullscreen window. Switch between them from the bar
            at the bottom of the screen without leaving fullscreen.
          </p>
        </div>
        <div className="row gap wrap">
          <SyncBadge status={store.status} />
          <button className="btn" onClick={() => setShareOpen((v) => !v)} aria-expanded={shareOpen}>⇆ Use on another computer</button>
          <ThemeToggle />
          <button className="btn btn-primary" disabled={!items.length || !fullscreen.supported} onClick={() => presentFrom(activeId)}>
            ▶ Present fullscreen
          </button>
        </div>
      </header>

      {store.message && <div className={`sync-msg ${store.status}`} role="status">{store.message}</div>}
      {shareOpen && <SharePanel store={store} onClose={() => setShareOpen(false)} />}

      <div className="present-grid">
        <div className="card">
          <div className="card-head"><h2>Presentations</h2><span className="muted small">{items.length} in this workspace</span></div>
          <div className="card-pad stack" style={{ gap: 10 }}>
            <form className="row gap" onSubmit={addLink}>
              <input
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder="Paste a Google Slides, Canva, PowerPoint, Pitch, Figma or YouTube link"
                aria-label="Presentation link"
              />
              <button className="btn" type="submit" disabled={!link.trim()}>Add link</button>
            </form>
            <div className="row gap wrap">
              <button className="btn" onClick={() => fileRef.current?.click()}>⇪ Upload PDF / image / video / audio</button>
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                accept="application/pdf,image/*,video/*,audio/*,.pdf,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.pptx,.ppt,.key"
                onChange={(e) => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = ''; }}
              />
            </div>
            <div className="row gap wrap">
              <button className={`btn ${pollForm === 'cloud' ? 'btn-on' : ''}`} onClick={() => setPollForm((v) => (v === 'cloud' ? false : 'cloud'))} aria-expanded={pollForm === 'cloud'}>☁ Word-cloud poll</button>
              <button className={`btn ${pollForm === 'choice' ? 'btn-on' : ''}`} onClick={() => setPollForm((v) => (v === 'choice' ? false : 'choice'))} aria-expanded={pollForm === 'choice'}>▤ Multiple-choice poll</button>
            </div>
            <span className="muted small">PowerPoint/Keynote files: export as PDF first.</span>
            {pollForm && (
              <form className="poll-form" onSubmit={addPoll}>
                <input
                  value={pollQ}
                  onChange={(e) => setPollQ(e.target.value)}
                  maxLength={200}
                  placeholder={pollForm === 'choice' ? 'Question, e.g. “Which topic should we cover next?”' : 'Question, e.g. “One word to describe today?”'}
                  aria-label="Poll question"
                  autoFocus
                />
                {pollForm === 'choice' && (
                  <div className="opt-list">
                    {pollOpts.map((o, i) => (
                      <div key={i} className="opt-row">
                        <span className="opt-letter">{String.fromCharCode(65 + i)}</span>
                        <input
                          value={o}
                          onChange={(e) => setPollOpts((list) => list.map((x, j) => (j === i ? e.target.value : x)))}
                          maxLength={80}
                          placeholder={`Option ${String.fromCharCode(65 + i)}`}
                          aria-label={`Option ${String.fromCharCode(65 + i)}`}
                        />
                        <label className="opt-correct" title="Mark as the correct answer (optional — turns this into a quiz)">
                          <input type="radio" name="poll-correct" checked={pollCorrect === i} onChange={() => setPollCorrect(i)} onClick={() => { if (pollCorrect === i) setPollCorrect(null); }} />
                          <span>Correct</span>
                        </label>
                        <button
                          type="button" className="icon-btn present-act" title="Remove option" disabled={pollOpts.length <= 2}
                          onClick={() => {
                            setPollOpts((list) => list.filter((_, j) => j !== i));
                            setPollCorrect((c) => (c === i ? null : c != null && c > i ? c - 1 : c));
                          }}
                        >×</button>
                      </div>
                    ))}
                    <div className="row gap">
                      <button type="button" className="link-btn small" disabled={pollOpts.length >= 8} onClick={() => setPollOpts((l) => [...l, ''])}>+ Add option</button>
                      <span className="muted small">2–8 options. Marking a correct answer is optional; you can reveal it on screen.</span>
                    </div>
                  </div>
                )}
                <div className="row gap wrap">
                  {pollForm === 'cloud' && (
                    <label className="row gap small muted">
                      Answers per person
                      <select value={pollPer} onChange={(e) => setPollPer(Number(e.target.value))} style={{ width: 'auto' }}>
                        {[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}
                      </select>
                    </label>
                  )}
                  <span className="grow" />
                  <button className="btn" type="button" onClick={() => setPollForm(false)}>Cancel</button>
                  <button
                    className="btn btn-primary" type="submit"
                    disabled={!pollQ.trim() || pollBusy || (pollForm === 'choice' && pollOpts.filter((o) => o.trim()).length < 2)}
                  >{pollBusy ? 'Creating…' : 'Create poll'}</button>
                </div>
              </form>
            )}
            {store.uploads.map((u) => (
              <div key={u.id} className="upload-row" role="status">
                <span className="grow">Uploading {u.name}…</span>
                <span className="muted small">{Math.round(u.progress * 100)}%</span>
                <div className="upload-bar"><i style={{ width: `${u.progress * 100}%` }} /></div>
              </div>
            ))}
            {errors.map((err) => <div key={err} className="present-error" role="alert">{err}</div>)}
          </div>

          {items.length === 0 ? (
            <div className="empty">No presentations yet. Add a link, upload a file or create a word-cloud poll to get started.</div>
          ) : (
            <ol className="present-list">
              {items.map((p, i) => (
                <li key={p.id} className={`present-row ${p.id === activeId ? 'active' : ''}`} onClick={() => setActiveId(p.id)}>
                  <span className="present-num">{i + 1}</span>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <input
                      className="present-name"
                      value={p.name}
                      onChange={(e) => store.update(p.id, { name: e.target.value })}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Name of presentation ${i + 1}`}
                    />
                    <div className="muted small row gap">
                      <span>{p.source}</span>
                      {store.missing.has(p.id) && <span className="bad">· file not found on this computer, upload it again</span>}
                      {p.original && <a href={p.original} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>open original ↗</a>}
                      {p.kind === 'embed' && p.stopOnLeave && <span>· sound stops when you switch away</span>}
                      {p.poll && <span>· code <b>{p.poll.code}</b></span>}
                      {p.poll && <a href={joinUrl(p.poll.code)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>audience page ↗</a>}
                    </div>
                  </div>
                  <div className="row" onClick={(e) => e.stopPropagation()}>
                    <button className="icon-btn present-act" title="Move up" disabled={i === 0} onClick={() => store.reorder(move(items, i, i - 1))}>↑</button>
                    <button className="icon-btn present-act" title="Move down" disabled={i === items.length - 1} onClick={() => store.reorder(move(items, i, i + 1))}>↓</button>
                    {p.kind === 'embed' && !canPauseEmbed(p.src) && (
                      <button
                        className={`icon-btn present-act ${p.stopOnLeave ? 'on' : ''}`}
                        aria-pressed={!!p.stopOnLeave}
                        title={p.stopOnLeave
                          ? 'Sound stops when you switch away (the deck restarts from the beginning when you come back). Click to keep it loaded instead.'
                          : 'Stop sound when switching away — use this if this deck has a video or audio, so it doesn’t keep playing behind other presentations. The deck will restart from the beginning when you come back.'}
                        onClick={() => store.update(p.id, { stopOnLeave: !p.stopOnLeave })}
                      >{p.stopOnLeave ? '🔇' : '🔊'}</button>
                    )}
                    <button className="icon-btn present-act" title="Present from here" disabled={!fullscreen.supported} onClick={() => presentFrom(p.id)}>▶</button>
                    <button className="icon-btn present-act" title="Remove" onClick={() => removeItem(p)}>×</button>
                  </div>
                </li>
              ))}
            </ol>
          )}

          <details className="card-pad present-tips">
            <summary>A presentation shows a blank or “refused to connect” page?</summary>
            <ul>
              <li><b>Google Slides:</b> Share → “Anyone with the link”, or File → Share → Publish to web. The normal edit link is converted automatically.</li>
              <li><b>Canva:</b> Share → “Anyone with the link can view”. The view link is converted automatically.</li>
              <li><b>PowerPoint:</b> In PowerPoint for the web, File → Share → Embed, and paste the address from the embed code.</li>
              <li>Some sites don’t allow being shown inside another page. For those, download the deck as PDF and upload it.</li>
            </ul>
          </details>
        </div>

        <Stage
          stageRef={stageRef}
          items={items}
          srcOf={store.srcOf}
          activeId={activeId}
          onSelect={setActiveId}
          fullscreen={fullscreen}
        />
      </div>
    </main>
  );
}

function SyncBadge({ status }: { status: ReturnType<typeof usePresentations>['status'] }) {
  const label = { connecting: 'Connecting…', saving: 'Saving…', saved: '✓ Saved', offline: '⚠ Offline', error: '⚠ Not saved' }[status];
  return <span className={`sync-badge ${status}`} title="Your presentations are stored on the server and open on any computer with the workspace link">{label}</span>;
}

/** Link + QR code to open this workspace on another computer, and a way to open a different one. */
function SharePanel({ store, onClose }: { store: ReturnType<typeof usePresentations>; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [paste, setPaste] = useState('');
  const [err, setErr] = useState<string>();
  const link = store.creds ? shareLink(store.creds) : '';
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { setErr('Couldn’t copy — select the link and copy it by hand.'); }
  };
  const open = async (e: FormEvent) => {
    e.preventDefault();
    const c = parseShareLink(paste);
    if (!c) { setErr('That isn’t a workspace link. It looks like https://seminar.starkpeople.in/w/…#…'); return; }
    setErr(undefined);
    await store.switchWorkspace(c);
    setPaste('');
    onClose();
  };
  return (
    <section className="card card-pad share-panel" aria-label="Use on another computer">
      <div className="share-main">
        <div className="stack" style={{ gap: 10, flex: 1, minWidth: 0 }}>
          <h2>Use on another computer</h2>
          <p className="muted small" style={{ margin: 0 }}>
            Open this link on any computer (or scan the code) to get the same presentations, files and polls.
            Anyone with the link can view and change this workspace, so share it only with people you trust.
          </p>
          {link ? (
            <div className="row gap">
              <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Workspace link" />
              <button className="btn btn-primary" onClick={copy}>{copied ? 'Copied ✓' : 'Copy link'}</button>
            </div>
          ) : <p className="muted small">Connecting to the server…</p>}
          <form className="row gap" onSubmit={open}>
            <input value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Or paste a workspace link to open it here" aria-label="Open a workspace link" />
            <button className="btn" type="submit" disabled={!paste.trim()}>Open</button>
          </form>
          {err && <div className="present-error" role="alert">{err}</div>}
          <div className="row gap">
            <button className="link-btn small" onClick={() => { if (window.confirm('Start a new, empty workspace in this browser? Keep the current link if you want to come back to this one.')) store.newWorkspace(); }}>Start a new empty workspace</button>
            <span className="grow" />
            <button className="btn btn-sm" onClick={onClose}>Close</button>
          </div>
        </div>
        {link && <div className="share-qr"><Qr text={link} label="QR code with the workspace link" /></div>}
      </div>
    </section>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      return (localStorage.getItem('presenter-theme') as 'light' | 'dark') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    } catch {
      return 'light';
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('presenter-theme', theme); } catch { /* ignore */ }
  }, [theme]);
  return (
    <button className="btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Toggle dark mode">
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}

/* ------------------------------------------------------------------ */

function Stage({ stageRef, items, srcOf, activeId, onSelect, fullscreen }: {
  stageRef: RefObject<HTMLDivElement | null>;
  items: Presentation[];
  srcOf: (p: Presentation) => string | undefined;
  activeId?: string;
  onSelect: (id: string) => void;
  fullscreen: ReturnType<typeof useFullscreen>;
}) {
  const idx = Math.max(0, items.findIndex((p) => p.id === activeId));
  const active = items[idx];

  // Frames are created on first view (plus the next one, preloaded) and then kept,
  // so switching back returns to the same slide instantly.
  const [mounted, setMounted] = useState<Set<string>>(new Set());
  useEffect(() => {
    const want = [items[idx]?.id, items[idx + 1]?.id].filter((x): x is string => !!x);
    setMounted((m) => (want.every((id) => m.has(id)) ? m : new Set([...m, ...want])));
  }, [items, idx]);

  // Dock auto-hides in fullscreen. Pointer events over an embedded page don't
  // reach us, so a thin hot zone along the bottom edge and a corner button bring it back.
  const [dockShown, setDockShown] = useState(true);
  const hideTimer = useRef<number | undefined>(undefined);
  const hovering = useRef(false);
  const showDock = useCallback(() => {
    setDockShown(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => { if (!hovering.current) setDockShown(false); }, 2500);
  }, []);
  useEffect(() => {
    if (fullscreen.active) showDock();
    else { window.clearTimeout(hideTimer.current); setDockShown(true); }
  }, [fullscreen.active, showDock]);
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  const go = (id: string) => {
    onSelect(id);
    if (fullscreen.active) showDock();
  };
  const step = (dir: 1 | -1) => {
    if (!items.length) return;
    go(items[(idx + dir + items.length) % items.length].id);
  };

  const docked = !fullscreen.active || dockShown;

  return (
    <div ref={stageRef} className={`stage ${fullscreen.active ? 'is-fs' : 'card'}`} onMouseMove={fullscreen.active ? showDock : undefined}>
      <div className="stage-view">
        {items.length === 0 && <div className="stage-empty">Your presentations will appear here.</div>}
        {items.map((p) => mounted.has(p.id) && (
          <Frame key={p.id} p={p} src={srcOf(p)} active={p.id === active?.id} />
        ))}
      </div>

      {fullscreen.active && !dockShown && (
        <>
          <div className="stage-hotzone" onMouseEnter={showDock} aria-hidden />
          <button className="stage-pill" onClick={showDock} aria-label="Show presentation switcher">
            ▦ {idx + 1} / {items.length}
          </button>
        </>
      )}

      <nav
        className={`stage-dock ${docked ? '' : 'hidden'}`}
        aria-label="Switch presentation"
        onMouseEnter={() => { hovering.current = true; window.clearTimeout(hideTimer.current); }}
        onMouseLeave={() => { hovering.current = false; if (fullscreen.active) showDock(); }}
      >
        <button className="dock-btn" onClick={() => step(-1)} disabled={items.length < 2} aria-label="Previous presentation">‹</button>
        <div className="dock-items">
          {items.map((p, i) => (
            <button key={p.id} className={`dock-item ${p.id === active?.id ? 'active' : ''}`} onClick={() => go(p.id)} title={p.name} aria-current={p.id === active?.id}>
              <span className="dock-num">{i + 1}</span>
              <span className="dock-name">{p.name}</span>
            </button>
          ))}
        </div>
        <button className="dock-btn" onClick={() => step(1)} disabled={items.length < 2} aria-label="Next presentation">›</button>
        {fullscreen.supported && (
          <button className="dock-btn dock-fs" onClick={fullscreen.toggle} disabled={!items.length}>
            {fullscreen.active ? '⤡ Exit' : '⤢ Fullscreen'}
          </button>
        )}
      </nav>
    </div>
  );
}

/** Pauses an embedded YouTube/Vimeo player via its postMessage API. */
function pauseEmbed(frame: HTMLIFrameElement, src: string) {
  const w = frame.contentWindow;
  if (!w) return;
  if (src.includes('youtube.com/embed')) w.postMessage(JSON.stringify({ event: 'command', func: 'pauseVideo', args: [] }), '*');
  else if (src.includes('player.vimeo.com')) w.postMessage(JSON.stringify({ method: 'pause' }), '*');
}

/** Only one sound at a time: when any video/audio in the stage starts, pause the rest. */
function pauseOtherMedia(playing: HTMLMediaElement) {
  document.querySelectorAll<HTMLMediaElement>('.stage video, .stage audio').forEach((m) => {
    if (m !== playing && !m.paused) m.pause();
  });
}

/** True for embeds we can pause ourselves (YouTube/Vimeo players). */
export const canPauseEmbed = (src: string) => src.includes('youtube.com/embed') || src.includes('player.vimeo.com');

function Frame({ p, src, active }: { p: Presentation; src?: string; active: boolean }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const mediaRef = useRef<HTMLMediaElement>(null);
  // "Stop sound when switching away": unload the page while it's not on screen.
  const unloaded = !active && !!p.stopOnLeave;

  useEffect(() => {
    if (active) {
      // Give keyboard focus to the visible deck, so arrow keys / clickers move its slides.
      const t = window.setTimeout(() => iframeRef.current?.focus(), 50);
      return () => window.clearTimeout(t);
    }
    mediaRef.current?.pause();
    if (iframeRef.current && src) pauseEmbed(iframeRef.current, src);
  }, [active, src]);

  const mediaProps = {
    src,
    controls: true,
    preload: 'auto' as const,
    onPlay: (e: React.SyntheticEvent<HTMLMediaElement>) => pauseOtherMedia(e.currentTarget),
  };

  let body;
  if (p.kind === 'poll' && p.poll) body = <PollStage poll={p.poll} fallbackQuestion={p.name} />;
  else if (!src) body = <div className="stage-empty">{p.kind === 'embed' ? 'No link' : 'Loading file… (if this stays, upload the file again)'}</div>;
  else if (p.kind === 'image') body = <img src={src} alt={p.name} />;
  else if (p.kind === 'video') body = <video ref={mediaRef as React.RefObject<HTMLVideoElement>} {...mediaProps} playsInline />;
  else if (p.kind === 'audio') {
    body = (
      <div className="audio-stage">
        <div className="audio-art" aria-hidden>♪</div>
        <h2 className="audio-title">{p.name}</h2>
        <audio ref={mediaRef as React.RefObject<HTMLAudioElement>} {...mediaProps} />
      </div>
    );
  }
  else {
    body = (
      <iframe
        ref={iframeRef}
        title={p.name}
        src={unloaded ? 'about:blank' : p.kind === 'pdf' && !src.includes('#') ? `${src}#view=Fit&toolbar=0&navpanes=0` : src}
        // No allowfullscreen on purpose: if an embed took fullscreen for itself,
        // our switcher bar would be hidden and switching would drop you out.
        allow="autoplay; encrypted-media; picture-in-picture; clipboard-write"
        referrerPolicy="strict-origin-when-cross-origin"
      />
    );
  }
  return <div className={`stage-frame ${active ? 'on' : ''}`} aria-hidden={!active}>{body}</div>;
}
