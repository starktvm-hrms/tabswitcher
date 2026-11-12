// Pure poll logic shared by the server and its tests. No I/O here.

export const LIMITS = {
  questionMax: 200,
  answerMax: 40,
  optionMax: 80,
  optionsMin: 2,
  optionsMax: 8,
  perPersonMax: 10,
  answersPerPoll: 20000,
  bodyBytes: 4096,
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

/** Poll type: 'cloud' (word cloud, free text) or 'choice' (multiple choice, one vote each). */
export const pollType = (poll) => (poll.type === 'choice' ? 'choice' : 'cloud');

export function validateNewPoll(body) {
  const question = cleanText(body?.question, LIMITS.questionMax);
  if (!question) return { error: 'Please enter a question.' };
  if (body?.type === 'choice') {
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
    return { type: 'choice', question, options, correct, perPerson: 1 };
  }
  let perPerson = Number(body?.perPerson ?? 3);
  if (!Number.isInteger(perPerson) || perPerson < 1 || perPerson > LIMITS.perPersonMax) perPerson = 3;
  return { type: 'cloud', question, perPerson };
}

/**
 * Checks a multiple-choice vote. People may change their vote while voting is open.
 * @returns {{ choice: number, previous: number } | { error: string }} previous = index of the vote it replaces, or -1
 */
export function checkVote(poll, pid, rawChoice) {
  if (!poll.open) return { error: 'Voting is closed.' };
  if (typeof pid !== 'string' || !/^[\w-]{8,64}$/.test(pid)) return { error: 'Invalid participant.' };
  const choice = Number(rawChoice);
  if (!Number.isInteger(choice) || choice < 0 || choice >= poll.options.length) return { error: 'Please choose one of the options.' };
  const previous = poll.answers.findIndex((a) => a.pid === pid);
  if (previous < 0 && poll.answers.length >= LIMITS.answersPerPoll) return { error: 'This poll is full.' };
  return { choice, previous };
}

/** Votes per option. */
export function tally(poll) {
  const counts = poll.options.map(() => 0);
  for (const a of poll.answers) if (a.choice >= 0 && a.choice < counts.length) counts[a.choice]++;
  return counts;
}

/**
 * Checks one submitted answer against the poll's rules.
 * @param poll {{ open: boolean, perPerson: number, answers: {pid: string, text: string}[] }}
 */
export function checkAnswer(poll, pid, rawText) {
  if (!poll.open) return { error: 'Voting is closed.' };
  if (typeof pid !== 'string' || !/^[\w-]{8,64}$/.test(pid)) return { error: 'Invalid participant.' };
  const text = cleanText(rawText, LIMITS.answerMax);
  if (!text || !wordKey(text)) return { error: 'Please type an answer.' };
  if (poll.answers.length >= LIMITS.answersPerPoll) return { error: 'This poll is full.' };
  const mine = poll.answers.filter((a) => a.pid === pid);
  if (mine.length >= poll.perPerson) return { error: `You can send up to ${poll.perPerson} answer${poll.perPerson === 1 ? '' : 's'}.` };
  if (mine.some((a) => wordKey(a.text) === wordKey(text))) return { error: 'You already sent that one.' };
  return { text, left: poll.perPerson - mine.length - 1 };
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
const answerKey = (poll) => (pollType(poll) === 'choice'
  ? { hasCorrect: poll.correct != null, revealed: !!poll.revealed, ...(poll.revealed && poll.correct != null ? { correct: poll.correct } : {}) }
  : {});

/** What the presenter screen gets. */
export function results(poll) {
  const base = {
    code: poll.code,
    type: pollType(poll),
    question: poll.question,
    open: poll.open,
    perPerson: poll.perPerson,
    total: poll.answers.length,
    participants: new Set(poll.answers.map((a) => a.pid)).size,
  };
  if (base.type === 'choice') return { ...base, options: poll.options, counts: tally(poll), ...answerKey(poll), words: [], hidden: 0 };
  return { ...base, words: aggregate(poll.answers, poll.hidden), hidden: poll.hidden.length };
}

/** What the audience page gets (no answers). */
export const publicInfo = (poll) => ({
  code: poll.code, type: pollType(poll), question: poll.question, open: poll.open, perPerson: poll.perPerson,
  ...(pollType(poll) === 'choice' ? { options: poll.options, ...answerKey(poll) } : {}),
});

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
