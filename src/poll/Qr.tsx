import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/** QR code as a crisp SVG (one path), scaled by CSS. Dark modules on white for reliable scanning. */
export function Qr({ text, label }: { text: string; label: string }) {
  const { size, d } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let path = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!qr.isDark(r, c)) continue;
        // Merge runs of dark modules in a row into one rectangle.
        let run = 1;
        while (c + run < n && qr.isDark(r, c + run)) run++;
        path += `M${c + 4} ${r + 4}h${run}v1h-${run}z`;
        c += run - 1;
      }
    }
    return { size: n + 8, d: path };
  }, [text]);
  return (
    <svg className="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
