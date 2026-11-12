import { useState, type FormEvent } from 'react';
import { TYPE_LABEL, type PollType, type QuestionDef, type QuizDef } from './api';

const letter = (i: number) => String.fromCharCode(65 + i);

const blank = (type: PollType): QuestionDef => {
  switch (type) {
    case 'choice': return { type, question: '', options: ['', '', '', ''], correct: null };
    case 'rating': return { type, question: '', lowLabel: 'Poor', highLabel: 'Excellent' };
    case 'open': return { type, question: '', perPerson: 1 };
    default: return { type, question: '', perPerson: 3 };
  }
};

const PLACEHOLDER: Record<PollType, string> = {
  cloud: 'e.g. One word to describe today?',
  choice: 'e.g. Which session did you enjoy most?',
  rating: 'e.g. How useful was this session?',
  open: 'e.g. What questions do you have for the speaker?',
};

/** Problems that would stop the quiz from saving, per question (empty = fine). */
export function questionProblem(q: QuestionDef): string | null {
  if (!q.question.trim()) return 'Type the question.';
  if (q.type === 'choice') {
    const opts = (q.options ?? []).map((o) => o.trim()).filter(Boolean);
    if (opts.length < 2) return 'Add at least 2 options.';
    if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) return 'Two options are the same.';
  }
  return null;
}

/**
 * Builds a quiz: any number of questions of any type, in order. All of them share
 * one QR code; the presenter steps through them on screen.
 */
export function QuizEditor({ initial, busy, onSave, onCancel, saveLabel }: {
  initial?: QuizDef;
  busy?: boolean;
  onSave: (quiz: QuizDef) => void;
  onCancel: () => void;
  saveLabel: string;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [questions, setQuestions] = useState<QuestionDef[]>(() => initial?.questions.map((q) => ({ ...q, options: q.options ? [...q.options] : undefined })) ?? [blank('cloud')]);
  const [tried, setTried] = useState(false);

  const set = (i: number, patch: Partial<QuestionDef>) => setQuestions((qs) => qs.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const move = (i: number, d: -1 | 1) => setQuestions((qs) => {
    const next = [...qs];
    const [q] = next.splice(i, 1);
    next.splice(i + d, 0, q);
    return next;
  });
  const changeType = (i: number, type: PollType) => setQuestions((qs) => qs.map((q, j) => {
    if (j !== i) return q;
    // Keep the question text; a new type means a fresh question (and no old id).
    return { ...blank(type), question: q.question };
  }));

  const problems = questions.map(questionProblem);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (problems.some(Boolean)) return;
    onSave({
      title: title.trim(),
      questions: questions.map((q) => ({
        ...q,
        question: q.question.trim(),
        // Drop empty options and keep the correct mark on the same option.
        ...(q.type === 'choice' ? (() => {
          const kept = (q.options ?? []).map((o, idx) => ({ o: o.trim(), idx })).filter((x) => x.o);
          const correct = q.correct == null ? null : kept.findIndex((x) => x.idx === q.correct);
          return { options: kept.map((x) => x.o), correct: correct != null && correct >= 0 ? correct : null };
        })() : {}),
      })),
    });
  };

  return (
    <form className="quiz-editor" onSubmit={submit}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="Quiz name (optional), e.g. “Seminar quiz”" aria-label="Quiz name" />
      <ol className="qe-list">
        {questions.map((q, i) => (
          <li key={i} className={`qe-item ${tried && problems[i] ? 'bad' : ''}`}>
            <div className="qe-head">
              <span className="qe-num">Q{i + 1}</span>
              <select value={q.type} onChange={(e) => changeType(i, e.target.value as PollType)} aria-label={`Question ${i + 1} type`} style={{ width: 'auto' }}>
                {(Object.keys(TYPE_LABEL) as PollType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </select>
              {!!q.answers && <span className="muted small">{q.answers} answer{q.answers === 1 ? '' : 's'}</span>}
              <span className="grow" />
              <button type="button" className="icon-btn present-act" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button type="button" className="icon-btn present-act" title="Move down" disabled={i === questions.length - 1} onClick={() => move(i, 1)}>↓</button>
              <button type="button" className="icon-btn present-act" title="Remove question" disabled={questions.length === 1} onClick={() => setQuestions((qs) => qs.filter((_, j) => j !== i))}>×</button>
            </div>
            <input
              value={q.question}
              onChange={(e) => set(i, { question: e.target.value })}
              maxLength={200}
              placeholder={PLACEHOLDER[q.type]}
              aria-label={`Question ${i + 1}`}
              autoFocus={i === questions.length - 1 && !initial}
            />

            {q.type === 'choice' && (
              <div className="opt-list">
                {(q.options ?? []).map((o, k) => (
                  <div key={k} className="opt-row">
                    <span className="opt-letter">{letter(k)}</span>
                    <input
                      value={o}
                      onChange={(e) => set(i, { options: (q.options ?? []).map((x, m) => (m === k ? e.target.value : x)) })}
                      maxLength={80}
                      placeholder={`Option ${letter(k)}`}
                      aria-label={`Question ${i + 1} option ${letter(k)}`}
                    />
                    <label className="opt-correct" title="Mark as the correct answer (optional — makes this a quiz question you can reveal)">
                      <input type="radio" name={`correct-${i}`} checked={q.correct === k} onChange={() => set(i, { correct: k })} onClick={() => { if (q.correct === k) set(i, { correct: null }); }} />
                      <span>Correct</span>
                    </label>
                    <button
                      type="button" className="icon-btn present-act" title="Remove option" disabled={(q.options ?? []).length <= 2}
                      onClick={() => set(i, {
                        options: (q.options ?? []).filter((_, m) => m !== k),
                        correct: q.correct === k ? null : q.correct != null && q.correct > k ? q.correct - 1 : q.correct,
                      })}
                    >×</button>
                  </div>
                ))}
                <button type="button" className="link-btn small" disabled={(q.options ?? []).length >= 8} onClick={() => set(i, { options: [...(q.options ?? []), ''] })}>+ Add option</button>
              </div>
            )}

            {q.type === 'rating' && (
              <div className="row gap wrap small">
                <label className="row gap muted">1 =<input value={q.lowLabel ?? ''} onChange={(e) => set(i, { lowLabel: e.target.value })} maxLength={40} style={{ width: 130 }} aria-label={`Question ${i + 1} low label`} /></label>
                <label className="row gap muted">5 =<input value={q.highLabel ?? ''} onChange={(e) => set(i, { highLabel: e.target.value })} maxLength={40} style={{ width: 130 }} aria-label={`Question ${i + 1} high label`} /></label>
              </div>
            )}

            {(q.type === 'cloud' || q.type === 'open') && (
              <label className="row gap small muted">
                Answers per person
                <select value={q.perPerson ?? 1} onChange={(e) => set(i, { perPerson: Number(e.target.value) })} style={{ width: 'auto' }}>
                  {(q.type === 'open' ? [1, 2, 3, 4, 5] : [1, 2, 3, 4, 5]).map((n) => <option key={n}>{n}</option>)}
                </select>
              </label>
            )}
            {tried && problems[i] && <div className="present-error small">{problems[i]}</div>}
          </li>
        ))}
      </ol>
      <div className="row gap wrap">
        <span className="muted small">Add question:</span>
        {(Object.keys(TYPE_LABEL) as PollType[]).map((t) => (
          <button key={t} type="button" className="btn btn-sm" disabled={questions.length >= 30} onClick={() => setQuestions((qs) => [...qs, blank(t)])}>+ {TYPE_LABEL[t]}</button>
        ))}
      </div>
      <div className="row gap">
        <span className="muted small">All questions share one QR code. Step through them on screen with Next / Prev.</span>
        <span className="grow" />
        <button className="btn" type="button" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : saveLabel}</button>
      </div>
    </form>
  );
}
