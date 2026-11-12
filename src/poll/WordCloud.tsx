import { useEffect, useMemo, useRef, useState } from 'react';
import { layoutCloud } from './cloudLayout';
import type { CloudWord } from './api';

const FONT = '700 {size}px Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
export const CLOUD_COLORS = 8;

/** Live word cloud. Words animate to their new spots and sizes as answers come in. */
export function WordCloud({ words, onWordClick, emptyText }: {
  words: CloudWord[];
  onWordClick?: (w: CloudWord) => void;
  emptyText?: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      setBox((b) => (Math.abs(b.w - width) < 2 && Math.abs(b.h - height) < 2 ? b : { w: width, h: height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // While answers pour in (hundreds of phones), redraw at most every 700 ms.
  const [shown, setShown] = useState(words);
  const lastDraw = useRef(0);
  useEffect(() => {
    const wait = Math.max(0, 700 - (Date.now() - lastDraw.current));
    const t = window.setTimeout(() => { lastDraw.current = Date.now(); setShown(words); }, wait);
    return () => window.clearTimeout(t);
  }, [words]);

  // Text widths are measured once per word and scaled (width is linear in font size).
  const widths = useRef(new Map<string, number>());
  const placed = useMemo(() => {
    if (!box.w || !box.h) return [];
    const ctx = document.createElement('canvas').getContext('2d');
    if (ctx) ctx.font = FONT.replace('{size}', '100');
    const measure = (text: string, size: number) => {
      let w100 = widths.current.get(text);
      if (w100 === undefined) {
        w100 = ctx ? ctx.measureText(text).width : text.length * 60;
        if (widths.current.size > 5000) widths.current.clear();
        widths.current.set(text, w100);
      }
      return (w100 * size) / 100;
    };
    return layoutCloud(shown, { width: box.w, height: box.h, measure, colors: CLOUD_COLORS });
  }, [shown, box]);

  return (
    <div className="cloud" ref={boxRef}>
      {shown.length === 0 && <div className="cloud-empty">{emptyText ?? 'Waiting for answers…'}</div>}
      {placed.map((p) => (
        <span
          key={p.key}
          className={`cloud-word c${p.color} ${onWordClick ? 'clickable' : ''}`}
          style={{ left: p.x, top: p.y, fontSize: p.size }}
          title={`${p.text} — ${p.count} ${p.count === 1 ? 'answer' : 'answers'}${onWordClick ? ' · click to hide' : ''}`}
          onClick={onWordClick ? () => onWordClick(p) : undefined}
        >
          {p.text}
        </span>
      ))}
    </div>
  );
}
