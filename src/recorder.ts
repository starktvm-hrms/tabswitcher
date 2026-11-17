import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Records this tab (or a window/screen) with its sound, optionally mixed with the
 * microphone. Produces two files at once:
 *   - video: picture + mixed sound, for watching/downloading later
 *   - audio: mixed sound only (small), for speech-to-text
 *
 * Tab sound includes everything playing in the presentation — embedded videos,
 * uploaded audio — so it is captured digitally, not through the room's speakers.
 * Works in Chrome and Edge. Choose "This tab" and keep "Also share tab audio" ticked.
 */

export type RecPhase = 'idle' | 'starting' | 'recording' | 'stopping';
export type Recording = {
  video: Blob; audio: Blob; startedAt: number; durationSec: number;
  hasTabAudio: boolean; hasMic: boolean; videoType: string; audioType: string;
};

const pick = (types: string[]) => types.find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) ?? '';
const stopAll = (s?: MediaStream | null) => s?.getTracks().forEach((t) => t.stop());

export const canRecord = () =>
  typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia && typeof MediaRecorder !== 'undefined';

export function useRecorder() {
  const [phase, setPhase] = useState<RecPhase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [info, setInfo] = useState<{ hasTabAudio: boolean; hasMic: boolean } | null>(null);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<Recording | null>(null);

  const r = useRef<{
    display?: MediaStream; mic?: MediaStream | null; ctx?: AudioContext;
    videoRec?: MediaRecorder; audioRec?: MediaRecorder;
    videoChunks: Blob[]; audioChunks: Blob[]; startedAt: number; raf?: number; timer?: number;
    finish?: (rec: Recording | null) => void;
  }>({ videoChunks: [], audioChunks: [], startedAt: 0 });

  const cleanup = useCallback(() => {
    const s = r.current;
    if (s.raf) cancelAnimationFrame(s.raf);
    if (s.timer) window.clearInterval(s.timer);
    stopAll(s.display); stopAll(s.mic);
    s.ctx?.close().catch(() => {});
    setLevel(0);
  }, []);

  const stop = useCallback(() => {
    const s = r.current;
    if (!s.videoRec || s.videoRec.state === 'inactive') return;
    setPhase('stopping');
    let pending = 2;
    const done = () => {
      if (--pending > 0) return;
      const durationSec = Math.round((Date.now() - s.startedAt) / 1000);
      const rec: Recording = {
        video: new Blob(s.videoChunks, { type: s.videoRec?.mimeType || 'video/webm' }),
        audio: new Blob(s.audioChunks, { type: s.audioRec?.mimeType || 'audio/webm' }),
        startedAt: s.startedAt, durationSec,
        hasTabAudio: !!info?.hasTabAudio, hasMic: !!info?.hasMic,
        videoType: s.videoRec?.mimeType || 'video/webm', audioType: s.audioRec?.mimeType || 'audio/webm',
      };
      cleanup();
      setResult(rec);
      setPhase('idle');
    };
    s.videoRec.onstop = done;
    s.audioRec!.onstop = done;
    s.videoRec.stop();
    s.audioRec!.stop();
  }, [cleanup, info]);

  const start = useCallback(async ({ mic }: { mic: boolean }) => {
    if (!canRecord()) { setError('Recording needs Chrome or Edge on a computer.'); return; }
    setError(undefined); setResult(null); setPhase('starting');
    const s = r.current;
    s.videoChunks = []; s.audioChunks = [];
    try {
      // Chrome: offers "This tab" first, with "Also share tab audio" ticked.
      s.display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false } as MediaTrackConstraints,
        preferCurrentTab: true, selfBrowserSurface: 'include', systemAudio: 'include', surfaceSwitching: 'include',
      } as DisplayMediaStreamOptions);
    } catch (e) {
      setPhase('idle');
      setError((e as Error).name === 'NotAllowedError' ? 'Recording was cancelled.' : `Couldn’t start recording: ${(e as Error).message}`);
      return;
    }
    const hasTabAudio = s.display.getAudioTracks().length > 0;
    s.mic = null;
    if (mic) {
      try {
        // Voice in the room: let the browser clean it up (echo, noise, level).
        s.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch {
        s.mic = null;
      }
    }
    if (!hasTabAudio && !s.mic) {
      stopAll(s.display);
      setPhase('idle');
      setError('No sound would be recorded. Choose “This tab” and tick “Also share tab audio”, or allow the microphone.');
      return;
    }

    // Mix tab sound + microphone into one track.
    const ctx = new AudioContext();
    s.ctx = ctx;
    const dest = ctx.createMediaStreamDestination();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    for (const src of [hasTabAudio ? s.display : null, s.mic]) {
      if (!src) continue;
      const node = ctx.createMediaStreamSource(src);
      node.connect(dest);
      node.connect(analyser);
    }
    const mixed = dest.stream.getAudioTracks()[0];

    const videoType = pick(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']);
    const audioType = pick(['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']);
    s.videoRec = new MediaRecorder(new MediaStream([...s.display.getVideoTracks(), mixed]), {
      ...(videoType ? { mimeType: videoType } : {}), videoBitsPerSecond: 1_500_000, audioBitsPerSecond: 128_000,
    });
    s.audioRec = new MediaRecorder(new MediaStream([mixed]), { ...(audioType ? { mimeType: audioType } : {}), audioBitsPerSecond: 96_000 });
    s.videoRec.ondataavailable = (e) => { if (e.data.size) s.videoChunks.push(e.data); };
    s.audioRec.ondataavailable = (e) => { if (e.data.size) s.audioChunks.push(e.data); };
    s.videoRec.start(1000);
    s.audioRec.start(1000);
    s.startedAt = Date.now();

    // "Stop sharing" in the browser bar ends the recording too.
    s.display.getVideoTracks()[0]?.addEventListener('ended', () => stopRef.current());

    // Live level meter + timer.
    const buf = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128);
      setLevel((l) => Math.max(peak, l * 0.85));
      s.raf = requestAnimationFrame(tick);
    };
    s.raf = requestAnimationFrame(tick);
    setElapsed(0);
    s.timer = window.setInterval(() => setElapsed(Math.round((Date.now() - s.startedAt) / 1000)), 500);
    setInfo({ hasTabAudio, hasMic: !!s.mic });
    setPhase('recording');
  }, []);

  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => () => { if (r.current.videoRec?.state === 'recording') r.current.videoRec.stop(); cleanup(); }, [cleanup]);

  // Leaving the page while recording would lose it: warn.
  useEffect(() => {
    if (phase !== 'recording') return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [phase]);

  return { phase, elapsed, level, info, error, result, start, stop, clearResult: () => setResult(null), clearError: () => setError(undefined) };
}

export const fmtClock = (sec: number) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s).padStart(2, '0')}`;
};
