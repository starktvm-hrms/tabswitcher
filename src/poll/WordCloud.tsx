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

  const placed = useMemo(() => {
    if (!box.w || !box.h) return [];
    const ctx = document.createElement('canvas').getContext('2d');
    const measure = (text: string, size: number) => {
      if (!ctx) return text.length * size * 0.6;
      ctx.font = FONT.replace('{size}', String(size));
      return ctx.measureText(text).width;
    };
    return layoutCloud(words, { width: box.w, height: box.h, measure, colors: CLOUD_COLORS });
  }, [words, box]);

  return (
    <div className="cloud" ref={boxRef}>
      {words.length === 0 && <div className="cloud-empty">{emptyText ?? 'Waiting for answers…'}</div>}
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
