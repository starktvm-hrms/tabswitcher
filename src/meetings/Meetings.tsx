import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Creds } from '../workspace';
import { fmtClock } from '../recorder';
import {
  deleteMeeting, download, getMeeting, getSettings, listMeetings, safeName, saveSettings, startMinutes, startTranscribe, updateMeeting,
  type AiSettings, type Meeting, type MeetingSummary,
} from './api';
import { markdownToHtml } from './markdown';

const LANGUAGES: [string, string][] = [
  ['', 'Detect automatically'], ['en', 'English'], ['hi', 'Hindi'], ['ml', 'Malayalam'], ['ta', 'Tamil'], ['te', 'Telugu'],
  ['kn', 'Kannada'], ['mr', 'Marathi'], ['bn', 'Bengali'], ['gu', 'Gujarati'], ['ar', 'Arabic'], ['fr', 'French'], ['de', 'German'], ['es', 'Spanish'],
];

const when = (ts: number) => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/* ---------------------------------------------------------------- settings */

export function AiSettingsPanel({ creds, onClose, onSaved }: { creds: Creds; onClose: () => void; onSaved?: (s: AiSettings) => void }) {
  const [s, setS] = useState<AiSettings>();
  const [el, setEl] = useState('');
  const [ds, setDs] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string }>();

  useEffect(() => { getSettings(creds).then((v) => { setS(v); setModel(v.deepseek.model); }).catch((e) => setMsg({ kind: 'err', text: e.message })); }, [creds]);

  const save = async (e: FormEvent, extra?: Record<string, string>) => {
    e.preventDefault();
    setBusy(true); setMsg(undefined);
    try {
      const body: Record<string, string> = { ...extra };
      if (el.trim()) body.elevenlabsKey = el.trim();
      if (ds.trim()) body.deepseekKey = ds.trim();
      if (model.trim() && model.trim() !== s?.deepseek.model) body.deepseekModel = model.trim();
      const v = await saveSettings(creds, body);
      setS(v); setEl(''); setDs('');
      setMsg({ kind: 'ok', text: 'Saved. Keys are stored on your server only and are never shown again.' });
      onSaved?.(v);
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    } finally { setBusy(false); }
  };

  return (
    <section className="card card-pad share-panel" aria-label="AI settings">
      <form className="stack" style={{ gap: 12 }} onSubmit={save}>
        <div className="row gap"><h2>AI settings</h2><span className="grow" /><button type="button" className="btn btn-sm" onClick={onClose}>Close</button></div>
        <p className="muted small" style={{ margin: 0 }}>
          Used to turn recordings into text and minutes. Keys are saved on your server for this workspace only, and never sent back to any browser.
        </p>
        <div className="ai-grid">
          <label className="field">
            <span>ElevenLabs API key — speech to text {s && <KeyState configured={s.elevenlabs.configured} hint={s.elevenlabs.hint} />}</span>
            <input type="password" value={el} onChange={(e) => setEl(e.target.value)} placeholder={s?.elevenlabs.configured ? 'Enter a new key to replace it' : 'sk_…'} autoComplete="off" />
            <a className="small" href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noreferrer">Get a key ↗</a>
          </label>
          <label className="field">
            <span>DeepSeek API key — minutes of meeting {s && <KeyState configured={s.deepseek.configured} hint={s.deepseek.hint} />}</span>
            <input type="password" value={ds} onChange={(e) => setDs(e.target.value)} placeholder={s?.deepseek.configured ? 'Enter a new key to replace it' : 'sk-…'} autoComplete="off" />
            <a className="small" href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">Get a key ↗</a>
          </label>
          <label className="field">
            <span>DeepSeek model</span>
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-chat" />
            <span className="muted small">If this name stops working, an available model is picked automatically.</span>
          </label>
        </div>
        {msg && <div className={msg.kind === 'ok' ? 'sync-msg saved' : 'present-error'} role="status">{msg.text}</div>}
        <div className="row gap wrap">
          <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          {s?.elevenlabs.hint?.startsWith('…') && <button type="button" className="link-btn small" onClick={(e) => save(e, { elevenlabsKey: '' })}>Remove ElevenLabs key</button>}
          {s?.deepseek.hint?.startsWith('…') && <button type="button" className="link-btn small" onClick={(e) => save(e, { deepseekKey: '' })}>Remove DeepSeek key</button>}
        </div>
      </form>
    </section>
  );
}

function KeyState({ configured, hint }: { configured: boolean; hint: string | null }) {
  return configured ? <b className="good"> · ✓ set {hint}</b> : <b className="bad"> · not set</b>;
}

/* ---------------------------------------------------------------- meetings list */

export function MeetingsPanel({ creds, refreshKey, onOpenSettings }: { creds: Creds; refreshKey: number; onOpenSettings: () => void }) {
  const [list, setList] = useState<MeetingSummary[]>([]);
  const [openId, setOpenId] = useState<string>();
  const [err, setErr] = useState<string>();

  const load = useCallback(() => listMeetings(creds).then((l) => { setList(l); setErr(undefined); }).catch((e) => setErr(e.message)), [creds]);
  useEffect(() => { load(); }, [load, refreshKey]);
  // While anything is being transcribed/written, check every 3 s.
  const busy = list.some((m) => m.transcribe.state === 'running' || m.minutes.state === 'running');
  useEffect(() => {
    if (!busy) return;
    const t = window.setInterval(load, 3000);
    return () => window.clearInterval(t);
  }, [busy, load]);

  return (
    <section className="card meetings" aria-label="Recordings and minutes">
      <div className="card-head">
        <h2>Recordings &amp; minutes</h2>
        <span className="muted small">{list.length ? `${list.length} recording${list.length === 1 ? '' : 's'}` : ''}</span>
      </div>
      {err && <div className="card-pad"><div className="present-error">{err}</div></div>}
      {list.length === 0 ? (
        <div className="empty">No recordings yet. Click <b>● Record</b> at the top to record this tab with its sound and your microphone.</div>
      ) : (
        <ul className="meet-list">
          {list.map((m) => (
            <li key={m.id} className={`meet-row ${openId === m.id ? 'open' : ''}`}>
              <button className="meet-head" onClick={() => setOpenId(openId === m.id ? undefined : m.id)} aria-expanded={openId === m.id}>
                <span className="meet-title">{m.title}</span>
                <span className="muted small">{when(m.startedAt)} · {fmtClock(m.durationSec)}</span>
                <span className="grow" />
                <Chip label="Transcript" job={m.transcribe} done={m.hasTranscript} />
                <Chip label="Minutes" job={m.minutes} done={m.hasMinutes} />
              </button>
              {openId === m.id && (
                <MeetingDetail creds={creds} id={m.id} summary={m} onChanged={load} onOpenSettings={onOpenSettings}
                  onDeleted={() => { setOpenId(undefined); load(); }} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Chip({ label, job, done }: { label: string; job: MeetingSummary['transcribe']; done: boolean }) {
  const [cls, text] = job.state === 'running' ? ['run', `${label}…`] : job.state === 'error' ? ['err', `${label} failed`] : done ? ['ok', `${label} ✓`] : ['none', label];
  return <span className={`chip chip-${cls}`}>{text}</span>;
}

/* ---------------------------------------------------------------- one meeting */

function MeetingDetail({ creds, id, summary, onChanged, onDeleted, onOpenSettings }: {
  creds: Creds; id: string; summary: MeetingSummary; onChanged: () => void; onDeleted: () => void; onOpenSettings: () => void;
}) {
  const [m, setM] = useState<Meeting>();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [names, setNames] = useState<Record<string, string>>({});
  const [lang, setLang] = useState('');
  const [instructions, setInstructions] = useState('');
  const [editMinutes, setEditMinutes] = useState(false);
  const [mdDraft, setMdDraft] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string }>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => getMeeting(creds, id).then((v) => {
    setM(v); setTitle(v.title); setText(v.transcript?.text ?? ''); setMdDraft(v.minutesDoc?.markdown ?? '');
  }).catch((e) => setMsg({ kind: 'err', text: e.message })), [creds, id]);
  // Reload when a background job finishes (the list polls and passes new summaries).
  useEffect(() => { load(); }, [load, summary.transcribe.state, summary.minutes.state]);

  const speakers = useMemo(() => [...new Set([...(text.matchAll(/\] (Speaker \d+):/g))].map((x) => x[1]))], [text]);
  const dirty = !!m && text !== (m.transcript?.text ?? '');

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setMsg(undefined);
    try { await fn(); if (ok) setMsg({ kind: 'ok', text: ok }); onChanged(); await load(); }
    catch (e) {
      const t = (e as Error).message;
      setMsg({ kind: 'err', text: t });
      if (/AI settings/.test(t)) onOpenSettings();
    } finally { setBusy(false); }
  };

  const applyNames = () => {
    let t = text;
    for (const [sp, name] of Object.entries(names)) if (name.trim()) t = t.replace(new RegExp(`\\] ${sp}:`, 'g'), `] ${name.trim()}:`);
    setText(t); setNames({});
  };

  const html = useMemo(() => markdownToHtml(m?.minutesDoc?.markdown ?? ''), [m?.minutesDoc?.markdown]);
  const printMinutes = () => {
    const w = window.open('', '_blank', 'noopener=no');
    if (!w) { setMsg({ kind: 'err', text: 'Allow pop-ups to print.' }); return; }
    w.document.write(`<!doctype html><meta charset="utf-8"><title>${safeName(m?.title ?? 'Minutes')}</title>
      <style>body{font:14px/1.5 system-ui,sans-serif;max-width:800px;margin:32px auto;padding:0 16px;color:#111}h1{font-size:22px}h2{font-size:17px;margin-top:22px;border-bottom:1px solid #ddd;padding-bottom:4px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f3f4f6}code{background:#f3f4f6;padding:0 4px;border-radius:4px}</style>
      ${html}<script>window.onload=()=>window.print()</script>`);
    w.document.close();
  };

  if (!m) return <div className="meet-body"><p className="muted">Loading…</p></div>;
  const tState = m.transcribe.state, mState = m.minutes.state;

  return (
    <div className="meet-body">
      <div className="row gap wrap">
        <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Recording title" style={{ flex: 1, minWidth: 200 }} />
        {title !== m.title && <button className="btn btn-sm" disabled={busy} onClick={() => run(() => updateMeeting(creds, id, { title }), 'Title saved.')}>Save title</button>}
        <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => window.confirm('Delete this recording, its transcript and minutes?') && run(async () => { await deleteMeeting(creds, id); onDeleted(); })}>Delete</button>
      </div>
      <div className="row gap wrap">
        <audio controls preload="metadata" src={m.audioUrl} style={{ flex: 1, minWidth: 260 }} />
        {m.videoUrl && <a className="btn btn-sm" href={m.videoUrl} target="_blank" rel="noreferrer">▶ Video</a>}
        <a className="btn btn-sm" href={m.audioUrl} download={`${safeName(m.title)}.webm`}>⇩ Audio</a>
      </div>
      {msg && <div className={msg.kind === 'ok' ? 'sync-msg saved' : 'present-error'} role="status">{msg.text}</div>}

      {/* ---- Transcript ---- */}
      <h3>1 · Transcript <span className="muted small">(ElevenLabs speech to text)</span></h3>
      {tState === 'running' && <p className="job-run">Transcribing… this takes about a minute per 10–20 minutes of audio. You can keep presenting.</p>}
      {tState === 'error' && <div className="present-error">{m.transcribe.error}</div>}
      {tState !== 'running' && (
        <div className="row gap wrap">
          <label className="row gap small muted">Language
            <select value={lang} onChange={(e) => setLang(e.target.value)} style={{ width: 'auto' }}>{LANGUAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => (!m.transcript?.text || window.confirm('Transcribe again? Your edits to the transcript will be replaced.')) && run(() => startTranscribe(creds, id, lang || undefined))}>
            {m.transcript?.text ? '↻ Transcribe again' : '✎ Transcribe'}
          </button>
        </div>
      )}
      {m.transcript?.text != null && (
        <>
          {speakers.length > 0 && (
            <div className="speaker-names">
              <span className="muted small">Rename speakers:</span>
              {speakers.map((sp) => (
                <input key={sp} placeholder={sp} value={names[sp] ?? ''} onChange={(e) => setNames({ ...names, [sp]: e.target.value })} aria-label={`Name for ${sp}`} style={{ width: 140 }} />
              ))}
              <button className="btn btn-sm" disabled={!Object.values(names).some((v) => v.trim())} onClick={applyNames}>Apply</button>
            </div>
          )}
          <textarea className="transcript" value={text} onChange={(e) => setText(e.target.value)} rows={12} aria-label="Transcript" spellCheck={false} />
          <div className="row gap wrap">
            <button className="btn btn-sm" disabled={!dirty || busy} onClick={() => run(() => updateMeeting(creds, id, { transcript: text }), 'Transcript saved.')}>Save transcript</button>
            <button className="btn btn-sm" onClick={() => download(new Blob([text], { type: 'text/plain;charset=utf-8' }), `${safeName(m.title)} - transcript.txt`)}>⇩ Transcript .txt</button>
            <span className="muted small">{m.transcript.speakers ? `${m.transcript.speakers} speaker(s)` : ''}{m.transcript.language ? ` · ${m.transcript.language}` : ''}</span>
          </div>
        </>
      )}

      {/* ---- Minutes ---- */}
      <h3>2 · Minutes of meeting <span className="muted small">(DeepSeek)</span></h3>
      {mState === 'running' && <p className="job-run">Writing the minutes…</p>}
      {mState === 'error' && <div className="present-error">{m.minutes.error}</div>}
      {mState !== 'running' && (
        <div className="row gap wrap">
          <input value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={1000} style={{ flex: 1, minWidth: 220 }}
            placeholder="Optional instructions, e.g. “Write in English. Attendees: Priya, Arun, Meera.”" aria-label="Instructions for the minutes" />
          <button className="btn btn-sm btn-primary" disabled={busy || !m.transcript?.text || dirty}
            title={dirty ? 'Save the transcript first' : !m.transcript?.text ? 'Transcribe first' : ''}
            onClick={() => run(() => startMinutes(creds, id, instructions || undefined))}>
            {m.minutesDoc?.markdown ? '↻ Write again' : '✦ Write minutes'}
          </button>
        </div>
      )}
      {m.minutesDoc?.markdown && (
        <>
          <div className="row gap wrap">
            <button className="btn btn-sm" onClick={() => navigator.clipboard.writeText(m.minutesDoc!.markdown).then(() => setMsg({ kind: 'ok', text: 'Minutes copied.' }))}>⧉ Copy</button>
            <button className="btn btn-sm" onClick={() => download(new Blob([m.minutesDoc!.markdown], { type: 'text/markdown;charset=utf-8' }), `${safeName(m.title)} - MOM.md`)}>⇩ .md</button>
            <button className="btn btn-sm" onClick={() => download(new Blob([`<html><head><meta charset="utf-8"></head><body>${html}</body></html>`], { type: 'application/msword' }), `${safeName(m.title)} - MOM.doc`)}>⇩ Word</button>
            <button className="btn btn-sm" onClick={printMinutes}>⎙ Print / PDF</button>
            <button className="btn btn-sm" onClick={() => setEditMinutes((v) => !v)}>{editMinutes ? 'Done editing' : '✎ Edit'}</button>
          </div>
          {editMinutes ? (
            <>
              <textarea className="transcript" value={mdDraft} onChange={(e) => setMdDraft(e.target.value)} rows={16} aria-label="Minutes (Markdown)" />
              <button className="btn btn-sm" disabled={mdDraft === m.minutesDoc.markdown || busy} onClick={() => run(() => updateMeeting(creds, id, { minutes: mdDraft }), 'Minutes saved.')}>Save minutes</button>
            </>
          ) : (
            <article className="mom" dangerouslySetInnerHTML={{ __html: html }} />
          )}
        </>
      )}
    </div>
  );
}
