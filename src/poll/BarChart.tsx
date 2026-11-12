/**
 * Live results for a multiple-choice poll: one horizontal bar per option, with the
 * vote count and percentage. Bars grow smoothly as votes arrive. Once the presenter
 * reveals the answer, the correct option turns green and the others fade.
 */
export function BarChart({ options, counts, correct, hidden }: {
  options: string[];
  counts: number[];
  /** Index of the correct option, once revealed. */
  correct?: number;
  /** Results hidden by the presenter: show the options without bars. */
  hidden?: boolean;
}) {
  const total = counts.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...counts);
  const letter = (i: number) => String.fromCharCode(65 + i);
  return (
    <div className={`bars ${hidden ? 'bars-hidden' : ''} ${correct != null ? 'bars-revealed' : ''}`} role="list" aria-label="Results">
      {options.map((label, i) => {
        const n = counts[i] ?? 0;
        const pct = total ? Math.round((n / total) * 100) : 0;
        const isCorrect = correct === i;
        return (
          <div key={i} role="listitem" className={`bar-row b${i % 8} ${isCorrect ? 'correct' : ''}`} aria-label={`${label}: ${hidden ? 'hidden' : `${n} votes, ${pct}%`}`}>
            <span className="bar-letter" aria-hidden>{isCorrect ? '✓' : letter(i)}</span>
            <div className="bar-main">
              <div className="bar-label">{label}</div>
              <div className="bar-track">
                <div className="bar-fill" style={{ width: hidden ? '0%' : `${(n / max) * 100}%` }} />
              </div>
            </div>
            <span className="bar-value">{hidden ? '' : <><b>{pct}%</b><small>{n}</small></>}</span>
          </div>
        );
      })}
    </div>
  );
}
