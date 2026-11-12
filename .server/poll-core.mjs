// Pure poll logic shared by the server and its tests. No I/O here.

export const LIMITS = {
  questionMax: 200,
  answerMax: 40,
  optionMax: 80,
  optionsMin: 2,
  optionsMax: 8,
  openMax: 200,
  labelMax: 40,
  titleMax: 120,
  questionsMax: 30,
  perPersonMax: 10,
  answersPerPoll: 20000,
  bodyBytes: 4096,
  quizBytes: 64 * 1024,
};

/** Unambiguous alphabet for join codes (no 0/O, 1/I/L). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Random join code, e.g. "K7QF2". `rand` is injectable for tests. */
export function makeCode(len = 5, rand = Math.random) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return s;
}

export const isCode = (s) => typeof s === 'string' && /^[A-HJ-KM-NP-Z2-9]{4,8}$/.test(s);

/** Trims, collapses whitespace and strips control characters. Returns '' if nothing is left. */
export function cleanText(raw, max) {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
  return [...s].slice(0, max).join('').trim();
}

/** Key used to group answers in the word cloud: case-, accent-spacing- and punctuation-insensitive. */
export function wordKey(text) {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\u201c\u201d"'`\u2019\u2018.,!?;:()[\]{}<>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- Quizzes ---------------------------------------------------------------
// A poll is a quiz: a list of questions shown one at a time, with ONE join code/QR.
// Question types:
//   cloud  — word cloud (short free text, several answers per person)
//   choice — multiple choice (one changeable vote; optional correct answer to reveal)
//   rating — rating scale 1–5 (one changeable vote; average + distribution)
//   open   — open-ended text (longer answers shown as cards; moderated by hiding)

export const QUESTION_TYPES = ['cloud', 'choice', 'rating', 'open'];
export const RATING_MAX = 5;
const PID = /^[\w-]{8,64}$/;

const qType = (q) => (QUESTION_TYPES.includes(q?.type) ? q.type : 'cloud');

/** Validates one question definition. Returns the normalized question or { error }. */
export function validateQuestion(body) {
  const question = cleanText(body?.question, LIMITS.questionMax);
  if (!question) return { error: 'Please enter a question.' };
  const type = qType(body);
  if (type === 'choice') {
    if (!Array.isArray(body.options)) return { error: 'Add the answer options.' };
    const options = body.options.map((o) => cleanText(o, LIMITS.optionMax)).filter(Boolean);
    if (options.length < LIMITS.optionsMin) return { error: `Add at least ${LIMITS.optionsMin} options.` };
    if (options.length > LIMITS.optionsMax) return { error: `Use at most ${LIMITS.optionsMax} options.` };
    if (new Set(options.map(wordKey)).size !== options.length) return { error: 'Two options are the same.' };
    // The index refers to the submitted list; recompute it after empties were dropped.
    let correct = null;
    if (Number.isInteger(body.correct) && body.correct >= 0 && body.correct < body.options.length) {
      const label = cleanText(body.options[body.correct], LIMITS.optionMax);
      const i = options.indexOf(label);
      if (label && i >= 0) correct = i;
    }
    return { type, question, options, correct, perPerson: 1 };
  }
  if (type === 'rating') {
    return {
      type, question, perPerson: 1,
      lowLabel: cleanText(body.lowLabel, LIMITS.labelMax) || 'Poor',
      highLabel: cleanText(body.highLabel, LIMITS.labelMax) || 'Excellent',
    };
  }
  const max = type === 'open' ? 5 : LIMITS.perPersonMax;
  let perPerson = Number(body?.perPerson ?? (type === 'open' ? 1 : 3));
  if (!Number.isInteger(perPerson) || perPerson < 1 || perPerson > max) perPerson = type === 'open' ? 1 : 3;
  return { type, question, perPerson };
}

/** Validates a new quiz: { title?, questions: [...] }, or a single question (older clients). */
export function validateNewPoll(body) {
  const list = Array.isArray(body?.questions) ? body.questions : [body];
  if (list.length < 1) return { error: 'Add at least one question.' };
  if (list.length > LIMITS.questionsMax) return { error: `A quiz can have up to ${LIMITS.questionsMax} questions.` };
  const questions = [];
  for (const [i, q] of list.entries()) {
    const v = validateQuestion(q);
    if (v.error) return { error: list.length > 1 ? `Question ${i + 1}: ${v.error}` : v.error };
    questions.push(v);
  }
  const title = cleanText(body?.title, LIMITS.titleMax) || questions[0].question;
  return { title, questions };
}

/** A fresh question with no answers yet. */
export const makeQuestion = (v, id) => ({ id, ...v, open: true, revealed: false, answers: [], hidden: [] });

/** Converts a poll saved by the single-question version into a one-question quiz. */
export function migrate(poll) {
  if (Array.isArray(poll.questions)) return poll;
  const q = {
    id: 'q1', type: poll.type === 'choice' ? 'choice' : 'cloud', question: poll.question, perPerson: poll.perPerson ?? 1,
    ...(poll.type === 'choice' ? { options: poll.options, correct: poll.correct ?? null } : {}),
    open: poll.open !== false, revealed: !!poll.revealed, answers: poll.answers ?? [], hidden: poll.hidden ?? [],
  };
  const { type, question, perPerson, options, correct, revealed, open, answers, hidden, ...rest } = poll;
  return { ...rest, title: question, current: 0, seq: 1, questions: [q] };
}

export const currentQuestion = (poll) => poll.questions[Math.min(poll.current ?? 0, poll.questions.length - 1)];

const badPid = (pid) => typeof pid !== 'string' || !PID.test(pid);

/** Word cloud answer. @returns {{ text, left } | { error }} */
export function checkAnswer(q, pid, rawText) {
  if (!q.open) return { error: 'Voting is closed.' };
  if (badPid(pid)) return { error: 'Invalid participant.' };
  const text = cleanText(rawText, LIMITS.answerMax);
  if (!text || !wordKey(text)) return { error: 'Please type an answer.' };
  if (q.answers.length >= LIMITS.answersPerPoll) return { error: 'This poll is full.' };
  const mine = q.answers.filter((a) => a.pid === pid);
  if (mine.length >= q.perPerson) return { error: `You can send up to ${q.perPerson} answer${q.perPerson === 1 ? '' : 's'}.` };
  if (mine.some((a) => wordKey(a.text) === wordKey(text))) return { error: 'You already sent that one.' };
  return { text, left: q.perPerson - mine.length - 1 };
}

/** Open-ended answer (longer text). @returns {{ text, left } | { error }} */
export function checkOpen(q, pid, rawText) {
  if (!q.open) return { error: 'Voting is closed.' };
  if (badPid(pid)) return { error: 'Invalid participant.' };
  const text = cleanText(rawText, LIMITS.openMax);
  if (!text) return { error: 'Please type an answer.' };
  if (q.answers.length >= LIMITS.answersPerPoll) return { error: 'This poll is full.' };
  const mine = q.answers.filter((a) => a.pid === pid);
  if (mine.length >= q.perPerson) return { error: `You can send up to ${q.perPerson} answer${q.perPerson === 1 ? '' : 's'}.` };
  if (mine.some((a) => wordKey(a.text) === wordKey(text))) return { error: 'You already sent that one.' };
  return { text, left: q.perPerson - mine.length - 1 };
}

/** Multiple-choice vote; people may change it while voting is open. previous = index of the vote it replaces, or -1. */
export function checkVote(q, pid, rawChoice) {
  if (!q.open) return { error: 'Voting is closed.' };
  if (badPid(pid)) return { error: 'Invalid participant.' };
  const choice = Number(rawChoice);
  if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length) return { error: 'Please choose one of the options.' };
  const previous = q.answers.findIndex((a) => a.pid === pid);
  if (previous < 0 && q.answers.length >= LIMITS.answersPerPoll) return { error: 'This poll is full.' };
  return { choice, previous };
}

/** Rating 1–5; changeable like a vote. */
export function checkRating(q, pid, rawValue) {
  if (!q.open) return { error: 'Voting is closed.' };
  if (badPid(pid)) return { error: 'Invalid participant.' };
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 1 || value > RATING_MAX) return { error: `Please choose 1 to ${RATING_MAX}.` };
  const previous = q.answers.findIndex((a) => a.pid === pid);
  if (previous < 0 && q.answers.length >= LIMITS.answersPerPoll) return { error: 'This poll is full.' };
  return { value, previous };
}

/** Votes per option. */
export function tally(q) {
  const counts = q.options.map(() => 0);
  for (const a of q.answers) if (a.choice >= 0 && a.choice < counts.length) counts[a.choice]++;
  return counts;
}

/**
 * Word-cloud data: answers grouped by wordKey, most common first. The label shown is
 * the most frequent spelling within the group. Hidden keys are left out.
 */
export function aggregate(answers, hidden = []) {
  const hide = new Set(hidden);
  const groups = new Map();
  for (const a of answers) {
    const k = wordKey(a.text);
    if (!k || hide.has(k)) continue;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { key: k, count: 0, spellings: new Map() }));
    g.count++;
    g.spellings.set(a.text, (g.spellings.get(a.text) ?? 0) + 1);
  }
  return [...groups.values()]
    .map((g) => ({ key: g.key, text: [...g.spellings.entries()].sort((x, y) => y[1] - x[1])[0][0], count: g.count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** The correct option is only shared once the presenter reveals it. */
const answerKey = (q) => (qType(q) === 'choice'
  ? { hasCorrect: q.correct != null, revealed: !!q.revealed, ...(q.revealed && q.correct != null ? { correct: q.correct } : {}) }
  : {});

/** Fields of the current question that phones need (no answers). */
function questionInfo(q) {
  const type = qType(q);
  return {
    qid: q.id, type, question: q.question, open: q.open, perPerson: q.perPerson,
    ...(type === 'choice' ? { options: q.options, ...answerKey(q) } : {}),
    ...(type === 'rating' ? { lowLabel: q.lowLabel, highLabel: q.highLabel, scale: RATING_MAX } : {}),
  };
}

const quizMeta = (poll) => ({ code: poll.code, title: poll.title, current: poll.current ?? 0, count: poll.questions.length });

/** Live results of one question, for the presenter screen. */
export function questionResults(q) {
  const base = {
    ...questionInfo(q),
    total: q.answers.length,
    participants: new Set(q.answers.map((a) => a.pid)).size,
    words: [], hidden: 0,
  };
  switch (qType(q)) {
    case 'choice': return { ...base, counts: tally(q) };
    case 'rating': {
      const counts = Array.from({ length: RATING_MAX }, () => 0);
      let sum = 0;
      for (const a of q.answers) if (a.value >= 1 && a.value <= RATING_MAX) { counts[a.value - 1]++; sum += a.value; }
      return { ...base, counts, average: q.answers.length ? Math.round((sum / q.answers.length) * 10) / 10 : null };
    }
    case 'open': {
      const hide = new Set(q.hidden);
      const visible = q.answers.filter((a) => !hide.has(a.id));
      return { ...base, responses: visible.slice(-200).reverse().map((a) => ({ id: a.id, text: a.text })), hidden: q.hidden.length };
    }
    default: return { ...base, words: aggregate(q.answers, q.hidden), hidden: q.hidden.length };
  }
}

/** What the presenter screen gets: the quiz position and the current question's results. */
export const results = (poll) => ({ ...quizMeta(poll), ...questionResults(currentQuestion(poll)) });

/** What phones get: the quiz position and the current question (no answers). */
export const publicInfo = (poll) => ({ ...quizMeta(poll), ...questionInfo(currentQuestion(poll)) });

/** Full definition for the presenter's editor (includes correct answers, never answers). */
export const adminView = (poll) => ({
  ...quizMeta(poll),
  questions: poll.questions.map((q) => ({
    id: q.id, type: qType(q), question: q.question, perPerson: q.perPerson,
    ...(q.options ? { options: q.options, correct: q.correct ?? null } : {}),
    ...(qType(q) === 'rating' ? { lowLabel: q.lowLabel, highLabel: q.highLabel } : {}),
    answers: q.answers.length,
  })),
});

/**
 * Applies an edited question list. Questions keep their answers when their id, type
 * and options are unchanged; otherwise they start fresh.
 */
export function applyEdit(poll, body) {
  const list = Array.isArray(body?.questions) ? body.questions : null;
  if (!list?.length) return { error: 'Add at least one question.' };
  if (list.length > LIMITS.questionsMax) return { error: `A quiz can have up to ${LIMITS.questionsMax} questions.` };
  const byId = new Map(poll.questions.map((q) => [q.id, q]));
  const next = [];
  for (const [i, raw] of list.entries()) {
    const v = validateQuestion(raw);
    if (v.error) return { error: `Question ${i + 1}: ${v.error}` };
    const old = typeof raw.id === 'string' ? byId.get(raw.id) : undefined;
    const sameShape = old && old.type === v.type && JSON.stringify(old.options ?? null) === JSON.stringify(v.options ?? null);
    if (sameShape) next.push({ ...old, ...v, id: old.id });
    else { poll.seq = (poll.seq ?? poll.questions.length) + 1; next.push(makeQuestion(v, `q${poll.seq}`)); }
  }
  const currentId = currentQuestion(poll)?.id;
  poll.questions = next;
  poll.title = cleanText(body.title, LIMITS.titleMax) || poll.title;
  const keep = next.findIndex((q) => q.id === currentId);
  poll.current = keep >= 0 ? keep : Math.min(poll.current ?? 0, next.length - 1);
  return { ok: true };
}

/** Fixed-window rate limiter keyed by e.g. IP. */
export function rateLimiter({ max, windowMs, now = Date.now }) {
  const hits = new Map();
  return (key) => {
    const t = now();
    const h = hits.get(key);
    if (!h || t - h.start >= windowMs) {
      hits.set(key, { start: t, n: 1 });
      if (hits.size > 10000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
      return true;
    }
    h.n++;
    return h.n <= max;
  };
}
