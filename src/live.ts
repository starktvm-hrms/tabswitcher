import { useEffect, useState } from 'react';

/**
 * Live tabs: an application window, another browser tab, or a whole screen, shown
 * live inside the presenter (screen-share style). Streams exist only in this page —
 * after a reload, or on another computer, the tab shows a Reconnect button.
 */

export type Surface = 'window' | 'browser' | 'monitor';

const streams = new Map<string, MediaStream>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const canCapture = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;

/** Opens the browser's picker. `prefer` only suggests which tab of the picker opens first. */
export async function capture(prefer: Surface): Promise<{ stream: MediaStream; surface: Surface; label: string }> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: prefer, frameRate: { ideal: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    // Another tab's own sound keeps playing from that tab; don't capture it twice.
    audio: false,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    preferCurrentTab: false,
  } as DisplayMediaStreamOptions);
  const track = stream.getVideoTracks()[0];
  const surface = ((track.getSettings() as { displaySurface?: Surface }).displaySurface ?? prefer) as Surface;
  return { stream, surface, label: niceLabel(track.label, surface) };
}

/** Chrome labels windows with their title ("deck.pptx - PowerPoint"); tabs/screens get generic ids. */
export function niceLabel(label: string, surface: Surface): string {
  const l = (label || '').trim();
  if (l && !/^(web-contents-media-stream|window:|screen:|tab:)/i.test(l) && !/^\d+$/.test(l)) return l.slice(0, 120);
  return surface === 'window' ? 'Application window' : surface === 'browser' ? 'Browser tab' : 'Screen';
}

export function setStream(id: string, stream: MediaStream) {
  streams.get(id)?.getTracks().forEach((t) => t.stop());
  streams.set(id, stream);
  // Sharing stopped from the browser bar or the app closed: show Reconnect.
  stream.getVideoTracks()[0]?.addEventListener('ended', () => {
    if (streams.get(id) === stream) { streams.delete(id); emit(); }
  });
  emit();
}

export function dropStream(id: string) {
  streams.get(id)?.getTracks().forEach((t) => t.stop());
  if (streams.delete(id)) emit();
}

export function useLiveStream(id: string): MediaStream | undefined {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return streams.get(id);
}

export const surfaceIcon = (s?: string) => (s === 'browser' ? '⧉' : s === 'monitor' ? '🖵' : '🗔');
