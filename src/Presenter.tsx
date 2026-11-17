import React, { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { useFullscreen } from './useFullscreen';
import { baseName, fileKind, move, toEmbed, type Presentation } from './present';
import { usePresentations } from './presentStore';
import { createQuiz, hostApi, joinUrl, type QuizDef } from './poll/api';
import { QuizEditor } from './poll/QuizEditor';
import { PollStage } from './poll/PollStage';
import { Qr } from './poll/Qr';
import { parseShareLink, shareLink, uploadFile } from './workspace';
import { canRecord, fmtClock, useRecorder, type Recording } from './recorder';
import { canCapture, capture, dropStream, setStream, surfaceIcon, useLiveStream, type Surface } from './live';
import { AiSettingsPanel, MeetingsPanel } from './meetings/Meetings';
import { createMeeting, download, getSettings, safeName, startTranscribe } from './meetings/api';

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
  // Quiz editor: closed, creating a new quiz, or editing the quiz of a playlist item.
  const [quizEdit, setQuizEdit] = useState<false | { itemId?: string; initial?: QuizDef }>(false);
  const [pollBusy, setPollBusy] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const recorder = useRecorder();
  const [withMic, setWithMic] = useState(true);
  const [meetingsKey, setMeetingsKey] = useState(0);
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

  const quizSource = (count: number) => (count === 1 ? 'Quiz · 1 question' : `Quiz · ${count} questions`);

  /** Creates a new quiz, or saves edits to an existing one. */
  const saveQuiz = async (quiz: QuizDef) => {
    if (!quizEdit || pollBusy) return;
    setPollBusy(true);
    try {
      const item = quizEdit.itemId ? items.find((p) => p.id === quizEdit.itemId) : undefined;
      if (item?.poll) {
        const r = await hostApi(item.poll).edit(quiz);
        store.update(item.id, { name: r.title, source: quizSource(r.count) });
        setActiveId(item.id);
      } else {
        const created = await createQuiz(quiz);
        const id = store.addLink({ name: created.title, kind: 'poll', src: '', source: quizSource(created.count), poll: { code: created.code, hostKey: created.hostKey } });
        setActiveId(id);
      }
      setQuizEdit(false);
      setErrors([]);
    } catch (err) {
      setErrors([(err as Error).message]);
    } finally {
      setPollBusy(false);
    }
  };

  const editQuiz = async (p: Presentation) => {
    if (!p.poll) return;
    try {
      const def = await hostApi(p.poll).admin();
      setQuizEdit({ itemId: p.id, initial: { title: def.title, questions: def.questions } });
      setErrors([]);
    } catch (err) {
      setErrors([(err as Error).message]);
    }
  };

  const removeItem = (p: Presentation) => {
    const msg = p.poll ? `Delete the quiz “${p.name}” and all its answers?` : `Remove “${p.name}”?`;
    if (!window.confirm(msg)) return;
    if (p.poll) hostApi(p.poll).remove().catch(() => { /* already gone */ });
    if (p.kind === 'live') dropStream(p.id);
    store.remove(p.id);
  };

  /** Adds an application window / browser tab / screen as a live tab. */
  const addLive = async (prefer: Surface) => {
    try {
      const { stream, surface, label } = await capture(prefer);
      const id = store.addLink({ name: label, kind: 'live', src: '', source: surface === 'window' ? 'Application (live)' : surface === 'browser' ? 'Browser tab (live)' : 'Screen (live)', surface });
      setStream(id, stream);
      setActiveId(id);
      setErrors([]);
    } catch (e) {
      if ((e as Error).name !== 'NotAllowedError') setErrors([`Couldn’t add it: ${(e as Error).message}`]);
    }
  };

  /** Picks the window/tab again for a live tab whose stream is gone (reload, other computer). */
  const reconnectLive = async (p: Presentation) => {
    try {
      const { stream, surface, label } = await capture(p.surface ?? 'window');
      setStream(p.id, stream);
      if (label !== p.name && /^(Application window|Browser tab|Screen)$/.test(p.name)) store.update(p.id, { name: label, surface });
    } catch { /* cancelled */ }
  };

  /** From the tab strip's ＋ menu (also in fullscreen): add a link. Returns an error message, if any. */
  const addLinkFromStage = (url: string): string | undefined => {
    const r = toEmbed(url);
    if ('error' in r) return r.error;
    const id = store.addLink({ name: r.name, kind: 'embed', src: r.src, original: url.trim(), source: r.source });
    setActiveId(id);
    return undefined;
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
            Line up decks, PDFs, videos, audio and live quizzes (word cloud, multiple choice, rating, open questions), then present them in one fullscreen window. Switch between them from the bar
            at the bottom of the screen without leaving fullscreen.
          </p>
        </div>
        <div className="row gap wrap">
          <SyncBadge status={store.status} />
          <RecordControls recorder={recorder} withMic={withMic} setWithMic={setWithMic} />
          <button className="btn" onClick={() => setAiOpen((v) => !v)} aria-expanded={aiOpen}>⚙ AI settings</button>
          <button className="btn" onClick={() => setShareOpen((v) => !v)} aria-expanded={shareOpen}>⇆ Use on another computer</button>
          <ThemeToggle />
          <button className="btn btn-primary" disabled={!items.length || !fullscreen.supported} onClick={() => presentFrom(activeId)}>
            ▶ Present fullscreen
          </button>
        </div>
      </header>

      {store.message && <div className={`sync-msg ${store.status}`} role="status">{store.message}</div>}
      {shareOpen && <SharePanel store={store} onClose={() => setShareOpen(false)} />}
      {aiOpen && store.creds && <AiSettingsPanel creds={store.creds} onClose={() => setAiOpen(false)} />}
      {recorder.error && (
        <div className="present-error rec-error" role="alert">
          {recorder.error} <button className="link-btn small" onClick={recorder.clearError}>Dismiss</button>
        </div>
      )}
      {recorder.result && store.creds && (
        <SaveRecording
          rec={recorder.result}
          creds={store.creds}
          onDone={() => { setMeetingsKey((k) => k + 1); }}
          onClose={recorder.clearResult}
          onNeedKeys={() => setAiOpen(true)}
        />
      )}

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
            {canCapture() && (
              <div className="row gap wrap">
                <button className="btn" onClick={() => addLive('window')} title="Show an open application (PowerPoint, Excel, a demo…) live as a tab">🗔 Add application</button>
                <button className="btn" onClick={() => addLive('browser')} title="Show another browser tab live — works for any website, including ones that can’t be embedded">⧉ Add browser tab</button>
              </div>
            )}
            <div className="row gap wrap">
              <button className={`btn ${quizEdit && !quizEdit.itemId ? 'btn-on' : ''}`} onClick={() => setQuizEdit((v) => (v && !v.itemId ? false : {}))} aria-expanded={!!quizEdit && !quizEdit.itemId}>
                ＋ Quiz / poll
              </button>
              <span className="muted small">Word cloud, multiple choice, rating and open questions — all behind one QR code.</span>
            </div>
            {quizEdit && (
              <div className="quiz-panel">
                <h3>{quizEdit.itemId ? 'Edit quiz' : 'New quiz / poll'}</h3>
                <QuizEditor
                  key={quizEdit.itemId ?? 'new'}
                  initial={quizEdit.initial}
                  busy={pollBusy}
                  saveLabel={quizEdit.itemId ? 'Save changes' : 'Create'}
                  onSave={saveQuiz}
                  onCancel={() => setQuizEdit(false)}
                />
              </div>
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
            <div className="empty">No presentations yet. Add a link, upload a file or create a quiz to get started.</div>
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
                    {p.poll && <button className="icon-btn present-act" title="Edit questions" onClick={() => editQuiz(p)}>✎</button>}
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
          recorder={recorder}
          onAddLink={addLinkFromStage}
          onAddLive={addLive}
          onReconnect={reconnectLive}
        />
      </div>

      {store.creds && <MeetingsPanel creds={store.creds} refreshKey={meetingsKey} onOpenSettings={() => setAiOpen(true)} />}
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

function Stage({ stageRef, items, srcOf, activeId, onSelect, fullscreen, recorder, onAddLink, onAddLive, onReconnect }: {
  stageRef: RefObject<HTMLDivElement | null>;
  items: Presentation[];
  srcOf: (p: Presentation) => string | undefined;
  activeId?: string;
  onSelect: (id: string) => void;
  fullscreen: ReturnType<typeof useFullscreen>;
  recorder: ReturnType<typeof useRecorder>;
  onAddLink: (url: string) => string | undefined;
  onAddLive: (prefer: Surface) => void;
  onReconnect: (p: Presentation) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
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
        {addOpen && <AddTabMenu onClose={() => setAddOpen(false)} onAddLink={onAddLink} onAddLive={(s) => { setAddOpen(false); onAddLive(s); }} />}
        {items.map((p) => mounted.has(p.id) && (
          <Frame key={p.id} p={p} src={srcOf(p)} active={p.id === active?.id} onReconnect={() => onReconnect(p)} />
        ))}
      </div>

      {/* Recording indicator: always visible, also in fullscreen; click to stop. */}
      {recorder.phase === 'recording' && (
        <button className="rec-badge" onClick={recorder.stop} title="Stop recording">
          <i className="rec-dot" aria-hidden /> REC {fmtClock(recorder.elapsed)} <span className="rec-stop">■ Stop</span>
        </button>
      )}

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
              <span className="dock-ico" aria-hidden>{kindIcon(p)}</span>
              <span className="dock-num">{i + 1}</span>
              <span className="dock-name">{p.name}</span>
            </button>
          ))}
        </div>
        <button className="dock-btn dock-add" onClick={() => { setAddOpen((v) => !v); if (fullscreen.active) showDock(); }} aria-label="Add a tab" title="Add a tab: web page, application or browser tab">＋</button>
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

function Frame({ p, src, active, onReconnect }: { p: Presentation; src?: string; active: boolean; onReconnect: () => void }) {
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
  if (p.kind === 'poll' && p.poll) body = <PollStage poll={p.poll} fallbackQuestion={p.name} active={active} />;
  else if (p.kind === 'live') body = <LiveFrame p={p} active={active} onReconnect={onReconnect} />;
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

/* ---------------------------------------------------------------- recording */

function RecordControls({ recorder, withMic, setWithMic }: { recorder: ReturnType<typeof useRecorder>; withMic: boolean; setWithMic: (v: boolean) => void }) {
  if (!canRecord()) return null;
  if (recorder.phase === 'recording' || recorder.phase === 'stopping') {
    return (
      <div className="rec-live" role="status">
        <i className="rec-dot" aria-hidden />
        <b>{fmtClock(recorder.elapsed)}</b>
        <span className="rec-meter" title="Sound level being recorded"><i style={{ width: `${Math.min(100, recorder.level * 140)}%` }} /></span>
        <span className="muted small">{[recorder.info?.hasTabAudio && 'tab sound', recorder.info?.hasMic && 'mic'].filter(Boolean).join(' + ')}</span>
        <button className="btn btn-sm btn-danger" onClick={recorder.stop} disabled={recorder.phase === 'stopping'}>■ Stop</button>
      </div>
    );
  }
  return (
    <div className="rec-start">
      <button className="btn" onClick={() => recorder.start({ mic: withMic })} disabled={recorder.phase === 'starting'}
        title="Record this tab with its sound (videos, audio) — choose “This tab” and keep “Also share tab audio” ticked">
        <i className="rec-dot idle" aria-hidden /> Record
      </button>
      <label className="row small muted" title="Also record your voice from the microphone" style={{ gap: 4 }}>
        <input type="checkbox" checked={withMic} onChange={(e) => setWithMic(e.target.checked)} /> Mic
      </label>
    </div>
  );
}

/**
 * After a recording stops: upload the audio to the workspace (for transcription),
 * create the meeting, start transcribing if ElevenLabs is set up. The video can be
 * downloaded, and optionally kept in the workspace too.
 */
function SaveRecording({ rec, creds, onDone, onClose, onNeedKeys }: {
  rec: Recording; creds: NonNullable<ReturnType<typeof usePresentations>['creds']>;
  onDone: () => void; onClose: () => void; onNeedKeys: () => void;
}) {
  const stamp = new Date(rec.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const [title, setTitle] = useState(`Meeting ${stamp}`);
  const [keepVideo, setKeepVideo] = useState(false);
  const [phase, setPhase] = useState<'ready' | 'saving' | 'saved' | 'error'>('ready');
  const [progress, setProgress] = useState(0);
  const [note, setNote] = useState<string>();
  const ext = (type: string) => (type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : 'webm');

  const save = async () => {
    setPhase('saving'); setNote(undefined);
    try {
      const total = rec.audio.size + (keepVideo ? rec.video.size : 0);
      let done = 0;
      const audio = await uploadFile(creds, rec.audio, `${safeName(title)}.${ext(rec.audioType) === 'webm' ? 'weba' : ext(rec.audioType)}`, rec.audioType.split(';')[0],
        (f) => setProgress((done + f * rec.audio.size) / total));
      done += rec.audio.size;
      const video = keepVideo
        ? await uploadFile(creds, rec.video, `${safeName(title)}.${ext(rec.videoType)}`, rec.videoType.split(';')[0], (f) => setProgress((done + f * rec.video.size) / total))
        : undefined;
      const meeting = await createMeeting(creds, { title, audioFileId: audio.fileId, videoFileId: video?.fileId, durationSec: rec.durationSec, startedAt: rec.startedAt });
      const settings = await getSettings(creds).catch(() => undefined);
      if (settings?.elevenlabs.configured) {
        await startTranscribe(creds, meeting.id);
        setNote('Saved. Transcribing now — see “Recordings & minutes” below.');
      } else {
        setNote('Saved. Add your ElevenLabs key in AI settings to transcribe it.');
        onNeedKeys();
      }
      setPhase('saved');
      onDone();
    } catch (e) {
      setPhase('error');
      setNote((e as Error).message);
    }
  };

  const mb = (b: Blob) => `${(b.size / 1024 / 1024).toFixed(1)} MB`;
  return (
    <section className="card card-pad share-panel rec-saved" aria-label="Recording finished">
      <div className="row gap wrap">
        <h2>Recording finished · {fmtClock(rec.durationSec)}</h2>
        <span className="muted small">{[rec.hasTabAudio && 'tab sound', rec.hasMic && 'microphone'].filter(Boolean).join(' + ')}</span>
        <span className="grow" />
        <button className="btn btn-sm" onClick={() => { if (phase === 'saved' || window.confirm('Close without saving? Download the video first if you want to keep it.')) onClose(); }}>Close</button>
      </div>
      <div className="row gap wrap">
        <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Recording title" style={{ flex: 1, minWidth: 220 }} disabled={phase !== 'ready' && phase !== 'error'} />
        <button className="btn" onClick={() => download(rec.video, `${safeName(title)}.${ext(rec.videoType)}`)}>⇩ Download video ({mb(rec.video)})</button>
      </div>
      {phase !== 'saved' && (
        <div className="row gap wrap">
          <label className="row gap small"><input type="checkbox" checked={keepVideo} onChange={(e) => setKeepVideo(e.target.checked)} disabled={phase === 'saving'} /> Also keep the video in the workspace ({mb(rec.video)})</label>
          <span className="grow" />
          <button className="btn btn-primary" onClick={save} disabled={phase === 'saving'}>
            {phase === 'saving' ? `Saving… ${Math.round(progress * 100)}%` : 'Save & transcribe'}
          </button>
        </div>
      )}
      {note && <div className={phase === 'error' ? 'present-error' : 'sync-msg saved'} role="status">{note}</div>}
    </section>
  );
}

/* ---------------------------------------------------------------- tabs: icons, ＋ menu, live apps */

function kindIcon(p: Presentation) {
  switch (p.kind) {
    case 'live': return surfaceIcon(p.surface);
    case 'poll': return '📊';
    case 'pdf': return '📄';
    case 'image': return '🖼';
    case 'video': return '🎬';
    case 'audio': return '♪';
    default: return /youtube|vimeo/i.test(p.source) ? '▶' : '🌐';
  }
}

/** The tab strip's ＋ menu. Drawn inside the stage, so it also works in fullscreen. */
function AddTabMenu({ onClose, onAddLink, onAddLive }: { onClose: () => void; onAddLink: (url: string) => string | undefined; onAddLive: (s: Surface) => void }) {
  const [url, setUrl] = useState('');
  const [err, setErr] = useState<string>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    const problem = onAddLink(url);
    if (problem) setErr(problem); else onClose();
  };
  return (
    <div className="add-menu" role="dialog" aria-label="Add a tab">
      <div className="row gap"><b>New tab</b><span className="grow" /><button className="dock-btn" onClick={onClose} aria-label="Close">×</button></div>
      <form className="row gap" onSubmit={submit}>
        <input autoFocus value={url} onChange={(e) => { setUrl(e.target.value); setErr(undefined); }} placeholder="Paste a link — Google Slides, Canva, YouTube, a website…" aria-label="Link for the new tab" />
        <button className="btn btn-primary" type="submit" disabled={!url.trim()}>Open</button>
      </form>
      {err && <div className="present-error small">{err}</div>}
      {canCapture() && (
        <div className="add-live">
          <button className="add-opt" onClick={() => onAddLive('window')}>
            <span className="add-ico">🗔</span><span><b>Application</b><small>PowerPoint, Excel, a software demo… shown live</small></span>
          </button>
          <button className="add-opt" onClick={() => onAddLive('browser')}>
            <span className="add-ico">⧉</span><span><b>Browser tab</b><small>Any website, even ones that can’t be embedded</small></span>
          </button>
          <button className="add-opt" onClick={() => onAddLive('monitor')}>
            <span className="add-ico">🖵</span><span><b>Whole screen</b><small>Everything on another monitor</small></span>
          </button>
        </div>
      )}
    </div>
  );
}

/** A live application / browser tab / screen. View-only: control it on your own screen. */
function LiveFrame({ p, active, onReconnect }: { p: Presentation; active: boolean; onReconnect: () => void }) {
  const stream = useLiveStream(p.id);
  const ref = useRef<HTMLVideoElement>(null);
  const [tip, setTip] = useState(true);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (v.srcObject !== (stream ?? null)) v.srcObject = stream ?? null;
    if (stream) v.play().catch(() => {});
  }, [stream]);
  useEffect(() => { if (!active) return; const t = window.setTimeout(() => setTip(false), 6000); return () => window.clearTimeout(t); }, [active]);

  const what = p.surface === 'browser' ? 'browser tab' : p.surface === 'monitor' ? 'screen' : 'application';
  return (
    <div className="live-frame">
      <video ref={ref} muted playsInline autoPlay className={stream ? '' : 'off'} />
      {!stream && (
        <div className="live-off">
          <div className="live-off-ico" aria-hidden>{surfaceIcon(p.surface)}</div>
          <b>{p.name}</b>
          <span>Not connected — choose the {what} again to show it here.</span>
          <button className="btn btn-primary" onClick={onReconnect}>Reconnect</button>
        </div>
      )}
      {stream && <span className="live-badge"><i aria-hidden /> LIVE · {p.name}</span>}
      {stream && active && tip && p.surface !== 'monitor' && (
        <div className="live-tip">
          Shown live. To control it, use it on your laptop screen — or press <kbd>Alt</kbd>+<kbd>Tab</kbd> to switch to it and back.
          <button className="link-btn small" onClick={() => setTip(false)}>OK</button>
        </div>
      )}
    </div>
  );
}
