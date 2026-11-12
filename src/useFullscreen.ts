import { useCallback, useEffect, useState, type RefObject } from 'react';

type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void>; webkitFullscreenEnabled?: boolean };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
type KbNav = Navigator & { keyboard?: { lock?: (codes?: string[]) => Promise<void>; unlock?: () => void } };

const fsElement = () => document.fullscreenElement ?? (document as FsDoc).webkitFullscreenElement ?? null;

/**
 * Element fullscreen for `ref`, with a WebKit fallback. Optionally captures
 * Escape with the Keyboard Lock API (Chromium) so a single Esc doesn't exit.
 */
export function useFullscreen(ref: RefObject<HTMLElement | null>, { lockEscape = false }: { lockEscape?: boolean } = {}) {
  const [active, setActive] = useState(false);
  const supported = typeof document !== 'undefined' && !!(document.fullscreenEnabled || (document as FsDoc).webkitFullscreenEnabled);

  useEffect(() => {
    const on = () => {
      const is = !!ref.current && fsElement() === ref.current;
      setActive(is);
      const kb = (navigator as KbNav).keyboard;
      if (!lockEscape) return;
      if (is) kb?.lock?.(['Escape']).catch(() => { /* not supported / not allowed */ });
      else kb?.unlock?.();
    };
    document.addEventListener('fullscreenchange', on);
    document.addEventListener('webkitfullscreenchange', on);
    return () => {
      document.removeEventListener('fullscreenchange', on);
      document.removeEventListener('webkitfullscreenchange', on);
    };
  }, [ref, lockEscape]);

  const toggle = useCallback(async () => {
    const el = ref.current as FsEl | null;
    if (!el) return;
    try {
      if (fsElement()) {
        await (document.exitFullscreen?.() ?? (document as FsDoc).webkitExitFullscreen?.());
      } else {
        await (el.requestFullscreen?.() ?? el.webkitRequestFullscreen?.());
      }
    } catch { /* user gesture missing or blocked — ignore */ }
  }, [ref]);

  return { active, supported, toggle };
}
