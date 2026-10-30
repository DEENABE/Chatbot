// Turns a user's question about a spreadsheet into a query plan WITHOUT a model.
//
// Why: a small local LLM that has to guess exact column names and cell values
// as JSON is the weakest link of spreadsheet Q&A (wrong column, "Chenai" vs
// "Chennai", "average per company" computed as one overall average, ...).
// Here the plan is built from the data itself:
//   * values are found by looking the table's real cell values up in the question
//     ("Chennai la ethana per irukaanga" → City = Chennai, count),
//   * columns are found by name / synonym ("sambalam", "joined", "wise"),
//   * numbers, dates, top-N, group-by and aggregates come from keyword rules,
//   * every word of the question must be accounted for, otherwise the plan is
//     marked "uncertain" and the caller falls back to the model (whose plan is then
//     repaired against the same data by repairPlan()).
// Pure functions: no database, no network.
import { toNumber, toDate } from './valueUtils.js';

// ───────────────────────── text helpers ─────────────────────────
export function normText(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim();
}

export function stemWord(word) {
  const w = String(word || '');
  if (w === 'ids' || w === 'nos') return w.slice(0, -1);
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(ch|sh|x|s|z)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** "joined" → "join", "restocked" → "restock", "joining" → "join" (column names use other word forms). */
export function verbStem(word) {
  const w = String(word || '');
  if (w.length > 5 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 6 && w.endsWith('ing')) return w.slice(0, -3);
  return w;
}

// Tanglish glue attached to a word: "chennaila", "madurai-ku".
const SUFFIXES = ['ukku', 'kku', 'ooda', 'oda', 'ila', 'il', 'la', 'ku', 'le'];
export function stripSuffix(word) {
  const w = String(word || '');
  if (w.length >= 6) {
    for (const s of SUFFIXES)
      if (w.endsWith(s) && w.length - s.length >= 4) return w.slice(0, -s.length);
  }
  return w;
}

const wordsOf = (text) => {
  const n = normText(text);
  return n ? n.split(' ') : [];
};

function editDistance(a, b, limit = 3) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

// ───────────────────────── vocabulary ─────────────────────────
// Words that carry no filter/column meaning (English + Tanglish).
const FILLER = new Set(
  `a an the is are was were be been am of in on at to for from by with and or not no nor what who whom whose where when which why how
  does do did done give me show tell list all any some please can could would you your i my mine his her their them he she they it
  its this that these those there here have has had get got find us our we also just only than then like want need see display
  details detail info information about data sheet sheets excel file files table tables record records row rows entry entries
  enna ena yenna enga engae engu irukaru irukkaru irukar iruka irukka epa eppa eppo eppadi epdi entha endha yaaru yaru yar oda
  ooda la le ku kku kitta pathi patthi sollu sollunga kaattu kattu kudu kodu venum vendum iruku irukku ellam ellaam ellaa avar avaru
  avanga ivar ivaru naa na nu um oru panni pannu pannunga panunga ah aa pa da per peru name naame panna pannanga panraru
  irundhu iruntha vandha vanthu vandhu sonna current currently now today pls plz ippo inniku ithu athu adhu idhu ivanga ivlo
  thaan than dhan tha ya yaa ngala nga ga mela keela illa illama illaama illaatha thavira ulla ullavanga ullathu irukkura
  irukkum irukum irukkuma irukuma iruppanga mattum matum thane ithanai sari seri ok okay hi hello bro sir mam
  need needed want wanted know let lets tell work works working worked came come comes coming present exist exists exactly totally
  velai vela seiraanga seiranga seyraanga irukaanga irukkaanga irukkanga irukaangala irukkaangala iruppaanga ullaanga ullanga
  yaar yaarunga belong belongs belonging visited visiting visit stay stays staying live lives living located based
  placed place made booked received raised created sold sell report reports sample everyone everybody anybody anyone`
    .split(/\s+/)
    .filter(Boolean),
);
const TANGLISH_VERB =
  /^(iru[kp]\w*|pan[nr]\w*|sollu\w*|kaattu\w*|kudu\w*|kodu\w*|thar\w*|vand\w*|vanth\w*|aan\w*|aag\w*|vaang\w*|seir\w*|seyy\w*|ullav\w*)$/;

const PEOPLE_WORDS = new Set(
  `employee employees emp people person persons staff member members worker workers student students customer customers visitor visitors
  candidate candidates per aal aalga aalunga irukaanga irukkaanga irukkanga iruppanga who whom`
    .split(/\s+/)
    .filter(Boolean),
);

// Nouns that name "a row" rather than a column.
const ENTITY = new Set(
  `employee employees emp people person persons staff member members worker workers student students customer customers
  visitor visitors product products item items candidate candidates user users record records row rows entry entries
  guy guys fellow fellows aal aalga`
    .split(/\s+/)
    .filter(Boolean),
);

// concept id → regex over stemmed/normalised words. A column name and a question
// word that share a concept refer to the same thing ("salary" ~ "ctc" ~ "sambalam").
const CONCEPTS = [
  [
    'salary',
    /^(salary|ctc|pay|paid|wage|income|compensation|earning|earner|earn|sambalam|சம்பளம்)$/,
  ],
  ['revenue', /^(revenue|sales|sale|turnover|sold)$/],
  ['price', /^(price|cost|amount|rate|mrp|worth|vilai|விலை|costly|expensive|cheap)$/],
  ['quantity', /^(quantity|qty|stock|unit|piece|available|inventory|onhand)$/],
  ['location', /^(city|location|place|town|ooru|branch|office|area|region|ஊர்|இடம்)$/],
  ['company', /^(company|organization|organisation|employer|firm|client)$/],
  ['department', /^(department|dept|team|division|section)$/],
  ['joined', /^(join|joined|joining|doj|hire|hired|hiring|onboard|onboarded)$/],
  ['name', /^(name|peru|பெயர்)$/],
  ['status', /^(status|state)$/],
  ['category', /^(category|type|kind|class|group)$/],
  ['supplier', /^(supplier|vendor)$/],
  ['warehouse', /^(warehouse|store|godown|depot)$/],
  ['date', /^(date|day|when|epa|eppo)$/],
  ['email', /^(email|mail)$/],
  ['phone', /^(phone|mobile|contact|cell)$/],
  ['designation', /^(designation|role|title|position|job)$/],
  ['purpose', /^(purpose|reason)$/],
  ['host', /^(host|met|meeting)$/],
];

export function conceptsOf(words) {
  const found = new Set();
  for (const word of words) {
    const stem = stemWord(word);
    for (const [id, pattern] of CONCEPTS)
      if (pattern.test(stem) || pattern.test(word)) found.add(id);
  }
  return found;
}

const MONTHS = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const OP_WORDS = [
  'how',
  'many',
  'number',
  'count',
  'ethana',
  'ethanai',
  'evlo',
  'evalo',
  'yevlo',
  'எத்தனை',
  'kanakku',
  'total',
  'sum',
  'overall',
  'combined',
  'mothama',
  'motham',
  'mottham',
  'மொத்த',
  'மொத்தம்',
  'average',
  'avg',
  'mean',
  'saraasari',
  'சராசரி',
  'highest',
  'maximum',
  'max',
  'largest',
  'biggest',
  'greatest',
  'most',
  'top',
  'best',
  'costliest',
  'priciest',
  'athigam',
  'athigama',
  'adhigam',
  'adhigama',
  'adhikam',
  'அதிக',
  'lowest',
  'minimum',
  'min',
  'smallest',
  'least',
  'cheapest',
  'fewest',
  'worst',
  'bottom',
  'kuraivu',
  'குறைந்த',
  'distinct',
  'unique',
  'different',
  'types',
  'kinds',
  'latest',
  'newest',
  'recent',
  'recently',
  'oldest',
  'earliest',
  'first',
  'last',
  'list',
  'show',
  'display',
  'give',
  'all',
  'every',
  'wise',
  'each',
  'which',
  'what',
  'who',
  'whom',
  'common',
  'frequent',
  'number',
  'highly',
  'paid',
  'group',
  'grouped',
  'popular',
  'commonly',
  'much',
  'many',
];

// ───────────────────────── table profile ─────────────────────────
const ID_NAME =
  /(^| )(id|code|phone|mobile|contact|pin|zip|aadhaar|aadhar|account|email|mail|sku|serial|no|number|uid)( |$)/;

/**
 * Describes every column once: type, role and (for text columns) the cell values
 * the question can be matched against.
 */
export function profileTable(table, rows) {
  const total = rows.length;
  const columns = table.columns.map((name, index) => {
    const counts = new Map();
    let filled = 0;
    let numeric = 0;
    let dates = 0;
    let min = Infinity;
    let max = -Infinity;
    let dmin = Infinity;
    let dmax = -Infinity;
    for (const row of rows) {
      const value = String(row[index] ?? '').trim();
      if (!value) continue;
      filled++;
      counts.set(value, (counts.get(value) || 0) + 1);
      const n = toNumber(value);
      if (n != null) {
        numeric++;
        if (n < min) min = n;
        if (n > max) max = n;
      } else {
        const d = toDate(value);
        if (d != null) {
          dates++;
          if (d < dmin) dmin = d;
          if (d > dmax) dmax = d;
        }
      }
    }
    const distinct = counts.size;
    const examples = [...counts.keys()].slice(0, 5);
    const type =
      filled && numeric / filled >= 0.8
        ? 'number'
        : filled && dates / filled >= 0.8
          ? 'date'
          : 'text';
    const wordList = wordsOf(name);
    const normName = wordList.join(' ');
    const idLike =
      ID_NAME.test(normName) || (type === 'text' && filled >= 20 && distinct / filled >= 0.95);
    let role;
    if (type === 'date') role = 'date';
    else if (idLike) role = 'identifier';
    else if (type === 'number') role = 'measure';
    else if (distinct <= 60 && (distinct <= 12 || distinct / Math.max(filled, 1) <= 0.6))
      role = 'category';
    else role = 'label';
    const entry = {
      index,
      name,
      normName,
      words: wordList.map(stemWord),
      concepts: conceptsOf(wordList),
      type,
      role,
      filled,
      distinct,
      min: min === Infinity ? null : min,
      max: max === -Infinity ? null : max,
      dmin: dmin === Infinity ? null : dmin,
      dmax: dmax === -Infinity ? null : dmax,
      counts,
      examples,
      values: null,
      lookup: null,
    };
    // Match index for text-like columns.
    if (type === 'text' || role === 'identifier') {
      const values = [];
      const lookup = new Map();
      for (const [value] of counts) {
        const vWords = wordsOf(value);
        if (!vWords.length) continue;
        const norm = vWords.join(' ');
        if (/^\d+$/.test(norm) && role !== 'identifier') continue;
        const stems = vWords.map(stemWord);
        const upper = /^[A-Z0-9&]{2,6}$/.test(value);
        if (norm.length < 3 && !upper) continue;
        if (vWords.length === 1 && (FILLER.has(norm) || ENTITY.has(norm))) continue;
        values.push({ value, norm, words: stems, upper });
        lookup.set(norm, value);
        lookup.set(stems.join(' '), value);
      }
      if (values.length <= 6000) {
        entry.values = values;
        entry.lookup = lookup;
      }
    }
    // Columns with thousands of distinct cells (ids, emails) cannot be matched by value: free that memory.
    if (distinct > 6000) entry.counts = new Map();
    return entry;
  });
  const nameWords = new Set(
    wordsOf(
      `${table.sheet || table.name || ''} ${String(table.filename || '').replace(/\.[a-z0-9]+$/i, '')}`,
    )
      .map(stemWord)
      .filter((w) => w.length >= 4),
  );
  return {
    name: table.sheet || table.name,
    filename: table.filename,
    columns,
    rowCount: total,
    nameWords,
  };
}

// ───────────────────────── question preparation ─────────────────────────
function prepareQuestion(question, now) {
  const raw = String(question || '');
  const lower = raw
    .toLowerCase()
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/[“”]/g, '"');
  const norm = normText(lower);
  const tokens = norm ? norm.split(' ') : [];
  const stems = tokens.map(stemWord);
  return {
    raw,
    lower,
    norm,
    padded: ` ${norm} `,
    tokens,
    stems,
    stripped: stems.map(stripSuffix),
    used: new Array(tokens.length).fill(false),
    now: now instanceof Date ? now : new Date(),
  };
}

const hasPhrase = (q, phrase) => q.padded.includes(` ${phrase} `);
const hasAny = (q, phrases) => phrases.some((p) => hasPhrase(q, p));
const markRange = (q, start, len = 1) => {
  for (let i = start; i < start + len && i < q.used.length; i++) q.used[i] = true;
};
function markWords(q, words) {
  const wanted = new Set(words);
  q.tokens.forEach((t, i) => {
    if (wanted.has(t)) q.used[i] = true;
  });
}

// ───────────────────────── value & column grounding ─────────────────────────
function findPhrase(q, vStems) {
  const n = vStems.length;
  const hits = [];
  for (let i = 0; i + n <= q.stems.length; i++) {
    let ok = true;
    for (let k = 0; k < n; k++) {
      if (q.stems[i + k] !== vStems[k] && q.stripped[i + k] !== vStems[k]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/** How strongly the words in tokens[from..to) point at each column (0..1). */
function columnScores(profile, q, from = 0, to = q.tokens.length) {
  const slice = q.tokens.slice(from, to);
  const stems = new Set(slice.map(stemWord));
  const stripped = new Set(slice.map((t) => stripSuffix(stemWord(t))));
  const verbs = new Set(slice.map((t) => verbStem(stemWord(t))));
  const concepts = conceptsOf(slice);
  return profile.columns.map((col) => {
    if (!col.words.length) return { col, score: 0 };
    const matched = col.words.filter(
      (w) => stems.has(w) || stripped.has(w) || (w.length >= 4 && verbs.has(verbStem(w))),
    ).length;
    let score = matched / col.words.length;
    if (score < 1 && col.concepts.size) {
      for (const c of col.concepts) {
        if (concepts.has(c)) {
          score = Math.max(score, 0.75);
          break;
        }
      }
    }
    return { col, score };
  });
}

function matchValues(profile, q, scores) {
  const scoreOf = new Map(scores.map((s) => [s.col.index, s.score]));
  const candidates = [];
  for (const col of profile.columns) {
    if (!col.values) continue;
    for (const v of col.values) {
      if (v.words.length === 1 && v.norm.length < 3 && !(v.upper && q.raw.includes(v.value)))
        continue;
      for (const start of findPhrase(q, v.words)) {
        candidates.push({ col, v, start, len: v.words.length, chars: v.norm.length });
      }
    }
  }
  candidates.sort(
    (a, b) =>
      b.len - a.len ||
      b.chars - a.chars ||
      (scoreOf.get(b.col.index) || 0) - (scoreOf.get(a.col.index) || 0) ||
      a.col.distinct - b.col.distinct ||
      a.start - b.start,
  );
  const taken = new Array(q.tokens.length).fill(false);
  const picked = [];
  for (const c of candidates) {
    let free = true;
    for (let i = c.start; i < c.start + c.len; i++) if (taken[i]) free = false;
    if (!free) continue;
    for (let i = c.start; i < c.start + c.len; i++) taken[i] = true;
    picked.push(c);
  }
  // Typos: "Chenai" → Chennai. Only single-word values, only words the question
  // has no other explanation for, and only when exactly one cell value is that close.
  const known = knownWords();
  const columnWords = new Set(profile.columns.flatMap((c) => c.words));
  q.tokens.forEach((token, i) => {
    if (taken[i] || token.length < 5 || /\d/.test(token)) return;
    const stem = stemWord(token);
    if (known.has(token) || known.has(stem) || columnWords.has(stem) || MONTHS[token]) return;
    const limit = token.length >= 8 ? 2 : 1;
    let best = null;
    let bestDistance = limit + 1;
    let ties = 0;
    for (const col of profile.columns) {
      if (!col.values) continue;
      for (const v of col.values) {
        if (v.words.length !== 1 || Math.abs(v.norm.length - token.length) > limit) continue;
        const d = Math.min(
          editDistance(v.norm, token, limit),
          editDistance(v.words[0], stem, limit),
        );
        if (d === 0 || d > limit) continue;
        if (d < bestDistance) {
          bestDistance = d;
          best = { col, v };
          ties = 1;
        } else if (d === bestDistance && v.value !== best.v.value) ties++;
      }
    }
    if (best && ties === 1) {
      taken[i] = true;
      picked.push({
        col: best.col,
        v: best.v,
        start: i,
        len: 1,
        chars: best.v.norm.length,
        fuzzy: true,
      });
    }
  });
  return picked.sort((a, b) => a.start - b.start);
}

function nearKnownWord(token) {
  for (const w of knownWords()) {
    if (w.length < 6 || Math.abs(w.length - token.length) > 1) continue;
    if (editDistance(w, token, 1) <= 1) return true;
  }
  return false;
}

let KNOWN_WORDS = null;
/** Every word the compiler itself understands (fillers, entities, operation words). */
function knownWords() {
  if (!KNOWN_WORDS)
    KNOWN_WORDS = new Set([
      ...FILLER,
      ...ENTITY,
      ...OP_WORDS,
      ...Object.keys(MONTHS),
      'wise',
      'per',
      'each',
      'by',
    ]);
  return KNOWN_WORDS;
}

const NEG_BRIDGE = new Set(
  `in from at of to with the by for on belong belongs belonging work works working worked are is be being been was were do does did have has had come came comes based located present a an`.split(
    ' ',
  ),
);
const NEGATION = new Set([
  'not',
  'except',
  'excluding',
  'exclude',
  'without',
  'other',
  'thavira',
  'illama',
  'illaama',
  'illaatha',
  'illa',
]);

// ───────────────────────── numbers & dates ─────────────────────────
const NUM =
  '(?:rs\\.?|inr|₹|\\$)?\\s*(\\d+(?:\\.\\d+)?)\\s*(k|lakhs?|lacs?|crores?|cr|million|m)?\\b';
function amount(value, unit) {
  let n = Number(value);
  const u = (unit || '').toLowerCase();
  if (u === 'k') n *= 1e3;
  else if (/^(lakh|lakhs|lac|lacs)$/.test(u)) n *= 1e5;
  else if (/^(crore|crores|cr)$/.test(u)) n *= 1e7;
  else if (/^(m|million)$/.test(u)) n *= 1e6;
  return n;
}
const isYear = (n) => Number.isInteger(n) && n >= 1950 && n <= 2100;
const pad2 = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function monthNumber(word) {
  return MONTHS[String(word || '').toLowerCase()] || null;
}

/** Picks the column a number/date comparison most likely belongs to. */
function pickColumn(profile, scores, roles, nearText, q) {
  const near = nearText ? columnScores(profile, { ...q, tokens: wordsOf(nearText) }, 0, 99) : null;
  const rank = (list) =>
    list
      .filter((s) => roles.includes(s.col.role) && s.score >= 0.5)
      .sort((a, b) => b.score - a.score || a.col.index - b.col.index)[0]?.col;
  return (near && rank(near)) || rank(scores) || null;
}

/** The one measure column whose min..max contains `value` ("orders above 50000" → Revenue, not Units). */
function rangeFit(profile, value) {
  const fits = profile.columns.filter(
    (c) => c.role === 'measure' && c.min != null && value >= c.min && value <= c.max * 1.5,
  );
  return fits.length === 1 ? fits[0] : null;
}

function soleColumn(profile, role) {
  const list = profile.columns.filter((c) => c.role === role);
  return list.length === 1 ? list[0] : null;
}

// ───────────────────────── the compiler ─────────────────────────
function analyseTable(q, profile) {
  const scores = columnScores(profile, q);
  const values = matchValues(profile, q, scores);
  return { profile, scores, values };
}

function evidenceOf(analysis) {
  const { values, scores, profile, q } = analysis;
  let evidence = 0;
  // "visitors who came for interview" → the sheet called "Visitors" (or file "visitor-log.xlsx").
  const nameWords = new Set(
    wordsOf(`${profile.name || ''} ${String(profile.filename || '').replace(/\.[a-z0-9]+$/i, '')}`)
      .map(stemWord)
      .filter((w) => w.length >= 4),
  );
  if (
    q.stems.some(
      (w) =>
        nameWords.has(w) ||
        (w.length >= 6 &&
          [...nameWords].some(
            (n) => Math.abs(n.length - w.length) <= 1 && editDistance(n, w, 1) <= 1,
          )),
    )
  )
    evidence += 2;
  // "Chennai la ethana per irukaanga" → people words point at the table that lists people.
  if (q.tokens.some((t) => PEOPLE_WORDS.has(t) || PEOPLE_WORDS.has(stemWord(t)))) {
    const peopleTable = profile.columns.some((c) =>
      c.words.some((w) =>
        ['name', 'employee', 'visitor', 'student', 'customer', 'person', 'candidate'].includes(w),
      ),
    );
    const thingTable = profile.columns.some((c) =>
      c.words.some((w) => ['product', 'item', 'sku', 'quantity', 'stock', 'warehouse'].includes(w)),
    );
    if (peopleTable && !thingTable) evidence += 1;
  }
  // Longer matches win: "Rajesh Subramanian" (2 words, Name) beats "Rajesh" (1 word, Host).
  for (const v of values)
    evidence += v.len * 2 + (v.col.role === 'category' ? 1 : v.fuzzy ? 0 : 0.5);
  evidence +=
    scores.filter((s) => s.score >= 0.75).length * 1.5 +
    scores.filter((s) => s.score >= 0.5 && s.score < 0.75).length * 0.75;
  return evidence;
}

/**
 * @param {string} question
 * @param {Array<{table:object, rows:string[][], profile?:object}>} candidates
 * @returns {{kind:"analytic"|"lookup"|"unknown", confident:boolean, plan?:object, tableIndex?:number, unexplained:string[], grounded:object[], cues:object, notes:string[]}}
 */
export function compileQuestion(question, candidates, { now } = {}) {
  const result = {
    kind: 'unknown',
    confident: false,
    unexplained: [],
    grounded: [],
    cues: {},
    notes: [],
  };
  if (!candidates?.length || !String(question || '').trim()) return result;

  const prepared = candidates.map((c) => {
    c.profile ||= profileTable(c.table, c.rows);
    return { c, q: prepareQuestion(question, now) };
  });
  const analyses = prepared.map(({ c, q }) => ({ ...analyseTable(q, c.profile), q, c }));
  const ranked = analyses
    .map((a, i) => ({ a, i, evidence: evidenceOf(a) }))
    .sort((x, y) => y.evidence - x.evidence || x.i - y.i);
  const best = ranked[0];
  if (candidates.length > 1) {
    if (best.evidence === 0) {
      result.notes.push('no table matches the question');
      return result;
    }
    if (ranked[1].evidence === best.evidence) {
      result.notes.push('two tables match equally');
      result.tie = true;
    }
  }
  const outcome = buildPlan(best.a);
  Object.assign(result, outcome, { tableIndex: best.i });
  if (result.tie) result.confident = false;
  return result;
}

// ───────────────────────── column projection ─────────────────────────
// "show only id", "list product names", "name and city mattum" → keep just those columns of every row.
const PROJECT_ONLY = new Set([
  'only',
  'just',
  'mattum',
  'maattum',
  'matum',
  'alone',
  'maathram',
  'மட்டும்',
]);
const PROJECT_VERBS = new Set([
  'show',
  'list',
  'display',
  'give',
  'get',
  'print',
  'fetch',
  'extract',
  'select',
  'kaattu',
  'kattu',
  'sollu',
  'kudu',
  'kodu',
  'kaamii',
  'view',
]);
const PROJECT_NOUNS = new Set([
  'column',
  'columns',
  'field',
  'fields',
  'value',
  'values',
  'data',
  'info',
  'detail',
  'details',
  'col',
  'cols',
]);
const GENERIC_COLUMN_WORDS = new Set([
  'id',
  'name',
  'email',
  'mail',
  'phone',
  'mobile',
  'price',
  'cost',
  'date',
  'status',
  'category',
  'address',
  'code',
  'city',
  'location',
]);

/**
 * Which columns does the question ask to see? Returns column objects, or null when it is not a projection.
 * `only` ("show only id") is a strong signal; without it the question must be a plain show/list verb that
 * names whole column names ("list product names"), so "show all products" keeps showing full rows.
 */
function detectProjection({
  profile,
  q,
  mentioned,
  firstMention,
  matchedColumn,
  mentionTokens,
  sortBy,
  cues,
}) {
  const tokens = q.tokens;
  const onlyCue = tokens.some((t) => PROJECT_ONLY.has(t));
  const verbCue = tokens.some((t) => PROJECT_VERBS.has(t));
  if (!onlyCue && !verbCue) return null;
  const candidates = mentioned
    .filter(
      (s) =>
        firstMention.has(s.col.index) && !matchedColumn.has(s.col.index) && s.col.name !== sortBy,
    )
    .map((s) => s.col);
  if (!candidates.length) return null;

  // Which question words name which column, and how completely ("Product Name" ← "product names" = 1,
  // "Product ID" ← "id" = 0.5, a synonym only = 0.9).
  const stems = tokens.map((t) => stemWord(t));
  const hitOf = (col, i) => {
    if (q.used[i]) return 0;
    const stem = stems[i];
    if (
      col.words.some(
        (w) => w === stem || w === stripSuffix(stem) || stripSuffix(w) === stripSuffix(stem),
      )
    )
      return 1;
    if (col.concepts.size && [...conceptsOf([tokens[i]])].some((c) => col.concepts.has(c)))
      return 0.9;
    return 0;
  };
  const coverage = new Map();
  for (const col of candidates) {
    const words = new Set();
    let synonym = false;
    tokens.forEach((t, i) => {
      const h = hitOf(col, i);
      if (h === 1)
        col.words.forEach(
          (w) =>
            (w === stems[i] ||
              w === stripSuffix(stems[i]) ||
              stripSuffix(w) === stripSuffix(stems[i])) &&
            words.add(w),
        );
      else if (h) synonym = true;
    });
    coverage.set(col.index, words.size ? words.size / col.words.length : synonym ? 0.9 : 0);
  }

  // For every question word keep only the best-covered columns it names: "product" alone could be Product ID or
  // Product Name, but next to "name" it is Product Name; "id" with nothing else names every ID column.
  const picked = new Map(); // col.index → first token that picked it
  tokens.forEach((t, i) => {
    const hits = candidates.filter((col) => hitOf(col, i) > 0);
    if (!hits.length) return;
    const best = Math.max(...hits.map((col) => coverage.get(col.index)));
    for (const col of hits)
      if (coverage.get(col.index) === best && !picked.has(col.index)) picked.set(col.index, i);
  });
  if (!picked.size) return null;
  const chosen = [...picked.entries()].map(([index, at]) => ({
    col: profile.columns[index],
    at,
    cover: coverage.get(index),
  }));

  if (!onlyCue) {
    const otherEntity = tokens.some(
      (t, i) => !mentionTokens.has(i) && (ENTITY.has(t) || ENTITY.has(stemWord(t))),
    );
    // Plain "list cities" / "show all categories" is the distinct-values question, not a projection.
    if (otherEntity || cues.distinct) return null;
    const wholeNames = chosen.every((c) => c.cover >= 1);
    const genericNames = chosen.every(
      (c) =>
        c.col.words.some((w) => GENERIC_COLUMN_WORDS.has(w)) &&
        tokens.some(
          (t) =>
            GENERIC_COLUMN_WORDS.has(stemWord(t)) ||
            GENERIC_COLUMN_WORDS.has(stripSuffix(stemWord(t))),
        ),
    );
    if (!wholeNames && !genericNames) return null;
    if (chosen.length === 1 && chosen[0].col.role === 'category') return null;
  }
  return chosen.sort((a, b) => a.at - b.at || a.col.index - b.col.index).map((c) => c.col);
}

function buildPlan(analysis) {
  const { profile, scores, values, q } = analysis;
  const cols = profile.columns;
  const notes = [];
  const filters = [];

  // ── 1. values found in the data ───────────────────────────────
  const matchedColumn = new Map(); // col.index → [value, ...]
  for (const m of values) {
    markRange(q, m.start, m.len);
    const before = q.tokens[m.start - 1];
    const before2 = q.tokens[m.start - 2];
    const after = q.tokens[m.start + m.len];
    const negatedBefore = before && NEGATION.has(before) && before !== 'illa';
    // "do not belong to TCS", "are not in Chennai": a negation up to 3 words back, with only glue words between.
    let farAt = -1;
    if (!negatedBefore) {
      for (let k = m.start - 1; k >= Math.max(0, m.start - 4); k--) {
        const w = q.tokens[k];
        if (NEGATION.has(w) && w !== 'illa' && w !== 'other') {
          farAt = k;
          break;
        }
        if (!NEG_BRIDGE.has(w)) break;
      }
    }
    const negatedFar = farAt >= 0;
    const negate =
      negatedBefore ||
      negatedFar ||
      (before === 'than' && before2 === 'other') ||
      (after && ['illama', 'illaama', 'illaatha', 'thavira'].includes(after));
    if (negate) {
      if (before === 'other' || before === 'than') q.used[m.start - 1] = true;
      if (negatedBefore) q.used[m.start - 1] = true;
      if (negatedFar) for (let k = farAt; k < m.start; k++) q.used[k] = true;
      if (after && NEGATION.has(after)) q.used[m.start + m.len] = true;
    }
    if (!matchedColumn.has(m.col.index)) matchedColumn.set(m.col.index, []);
    matchedColumn.get(m.col.index).push({ value: m.v.value, negate: !!negate });
  }
  const grounded = [];
  for (const [index, list] of matchedColumn) {
    const col = cols[index];
    const positive = list.filter((x) => !x.negate).map((x) => x.value);
    const negative = list.filter((x) => x.negate).map((x) => x.value);
    if (positive.length === 1) filters.push({ column: col.name, op: 'equals', value: positive[0] });
    else if (positive.length > 1) filters.push({ column: col.name, op: 'in', value: positive });
    for (const value of negative) filters.push({ column: col.name, op: 'not_equals', value });
    grounded.push({ column: col.name, role: col.role, values: list.map((x) => x.value) });
  }
  const hasCategoryFilter = values.some((m) => m.col.role === 'category');
  const hasOnlyNameFilters =
    values.length > 0 && values.every((m) => m.col.role === 'identifier' || m.col.role === 'label');

  // ── 2. column mentions ────────────────────────────────────────
  const mentioned = scores
    .filter((s) => s.score >= 0.5)
    .sort((a, b) => b.score - a.score || a.col.index - b.col.index);
  const mentionTokens = new Set();
  const firstMention = new Map(); // column index → first question token that names it
  for (const { col } of mentioned) {
    const concepts = col.concepts;
    q.tokens.forEach((t, i) => {
      if (q.used[i]) return;
      const stem = stemWord(t);
      let hit = false;
      if (col.words.includes(stem) || col.words.includes(stripSuffix(stem))) hit = true;
      else if (verbStem(stem).length >= 4 && col.words.some((w) => verbStem(w) === verbStem(stem)))
        hit = true;
      else if (concepts.size && [...conceptsOf([t])].some((c) => concepts.has(c))) hit = true;
      if (hit) {
        mentionTokens.add(i);
        if (!firstMention.has(col.index)) firstMention.set(col.index, i);
      }
    });
  }
  const entityIndex = q.tokens.findIndex((t) => ENTITY.has(t) || ENTITY.has(stemWord(t)));
  // "how many companies in employees" → the column is the subject, "employees" only names the sheet.
  const entitySubject = (col) =>
    entityIndex >= 0 && !(firstMention.has(col.index) && firstMention.get(col.index) < entityIndex);
  const measureMention = mentioned.find((s) => s.col.role === 'measure')?.col || null;
  const dateMention = mentioned.find((s) => s.col.role === 'date')?.col || null;

  // ── 3. operation cues ─────────────────────────────────────────
  // "100000 ku athigama" / "50000 ku kammiya" are comparisons, not "highest"/"lowest".
  const comparatorTail =
    /\d\s*(?:k|lakhs?|lacs?|crores?)?\s*(?:ku |kku |um |kum )?(?:athigam|adhigam|adhikam|kammi|kuraiv|mela|keela|kila)/.test(
      q.lower,
    );
  const cues = {
    count: hasAny(q, [
      'how many',
      'number of',
      'count',
      'ethana',
      'ethanai',
      'evlo',
      'evalo',
      'yevlo',
      'எத்தனை',
      'kanakku',
    ]),
    sum: hasAny(q, [
      'total',
      'sum',
      'overall',
      'combined',
      'mothama',
      'motham',
      'mottham',
      'மொத்த',
      'மொத்தம்',
    ]),
    avg: hasAny(q, ['average', 'avg', 'mean', 'saraasari', 'சராசரி']),
    max:
      hasAny(q, [
        'highest',
        'maximum',
        'max',
        'largest',
        'biggest',
        'greatest',
        'most',
        'top',
        'best',
        'costliest',
        'priciest',
      ]) ||
      (!comparatorTail &&
        hasAny(q, ['athigam', 'athigama', 'adhigam', 'adhigama', 'adhikam', 'அதிக'])),
    min:
      hasAny(q, [
        'lowest',
        'minimum',
        'min',
        'smallest',
        'least',
        'cheapest',
        'fewest',
        'worst',
        'bottom',
      ]) ||
      (!comparatorTail && hasAny(q, ['kuraivu', 'kuraivaana', 'kammi', 'kammiya', 'குறைந்த'])),
    distinct: hasAny(q, ['distinct', 'unique', 'different', 'types of', 'kinds of']),
    list: hasAny(q, [
      'list',
      'show',
      'display',
      'give',
      'all',
      'every',
      'kaattu',
      'sollu',
      'kudu',
      'ellam',
      'ellaa',
      'ellaam',
      'which',
      'what are',
      'who all',
      'yaar yaar',
      'names of',
      'name of',
    ]),
    latest: hasAny(q, [
      'latest',
      'newest',
      'recent',
      'recently',
      'last joined',
      'most recent',
      'recently joined',
    ]),
    earliest: hasAny(q, ['oldest', 'earliest', 'first joined', 'first']),
    which: hasAny(q, ['which', 'what', 'enna', 'entha', 'endha', 'evvalavu']),
  };
  markWords(q, OP_WORDS);

  // ── 4. group by ───────────────────────────────────────────────
  let groupBy = null;
  const groupFor = (from, to) => {
    const slice = scoreWindow(profile, q, from, to);
    return slice;
  };
  const tokens = q.tokens;
  for (let i = 0; i < tokens.length && !groupBy; i++) {
    const t = tokens[i];
    let window = null;
    if (t === 'wise' && i > 0) window = [Math.max(0, i - 2), i];
    else if ((t === 'per' || t === 'each') && i + 1 < tokens.length)
      window = [i + 1, Math.min(tokens.length, i + 3)];
    else if (t === 'by' && tokens[i - 1] === 'group')
      window = [i + 1, Math.min(tokens.length, i + 3)];
    else if (
      t === 'by' &&
      !['sort', 'order', 'sorted', 'ordered', 'arrange', 'arranged'].includes(tokens[i - 1]) &&
      (cues.count ||
        cues.sum ||
        cues.avg ||
        cues.max ||
        cues.min ||
        tokens.slice(0, i).some((w) => w === 'group' || w === 'grouped')) &&
      i + 1 < tokens.length
    ) {
      window = [i + 1, Math.min(tokens.length, i + 3)];
    }
    if (!window) continue;
    const found = groupFor(window[0], window[1]);
    if (found) {
      groupBy = found.col;
      markRange(q, i, 1);
      for (let k = window[0]; k < window[1]; k++) {
        const stem = stemWord(tokens[k]);
        if (found.col.words.includes(stem) || conceptsOf([tokens[k]]).size) q.used[k] = true;
      }
    }
  }

  // "which company has the most employees" / "most common city"
  let rank = null; // "top" | "bottom"
  const wantsMost = cues.max;
  const wantsLeast = cues.min;
  const commonCue = hasAny(q, [
    'most common',
    'least common',
    'most frequent',
    'most popular',
    'commonly',
    'frequent',
  ]);
  // "department with the lowest average salary", "city having most employees"
  const withCue =
    /\b(with|having|has|have|had|gets|get|got|paying|pays|pay)\s+(?:the\s+)?(?:highest|lowest|most|least|maximum|minimum|fewest|largest|smallest|biggest|top|best|worst|max|min|more|less)\b/.test(
      q.lower,
    );
  if (!groupBy && (cues.which || commonCue || withCue) && (wantsMost || wantsLeast || commonCue)) {
    const candidate = mentioned.find(
      (s) =>
        (s.col.role === 'category' || s.col.role === 'label') && !matchedColumn.has(s.col.index),
    );
    const measureAgg = cues.avg || cues.sum;
    // "which warehouse has the most stock": quantities add up, so rank the per-group SUM.
    const additive =
      measureMention &&
      (measureMention.concepts.has('quantity') || measureMention.concepts.has('revenue')) &&
      !cues.count;
    if (candidate && (measureAgg || additive || !measureMention || ENTITY_IN(q))) {
      groupBy = candidate.col;
      rank = wantsLeast && !wantsMost ? 'bottom' : 'top';
      if (additive && !measureAgg) cues.sum = true;
    }
  }
  if (groupBy && !rank && (wantsMost || wantsLeast) && (cues.which || withCue))
    rank = wantsLeast && !wantsMost ? 'bottom' : 'top';

  // ── 5. numbers: comparisons, ranges, top-N ────────────────────
  let limit = null;
  const numericFilters = [];
  const dateFilters = [];
  const topMatch =
    q.lower.match(
      /\b(top|bottom|first|last|highest|lowest|best|worst|latest|newest|oldest|recent|earliest)\s+(\d{1,3})\b(?!\s*(?:day|week|month|year))/,
    ) ||
    q.lower.match(
      /\b(\d{1,3})\s+(highest|lowest|top|bottom|best|worst|latest|newest|oldest|recent|earliest)\b/,
    );
  if (topMatch) {
    const n = Number(/^\d/.test(topMatch[1]) ? topMatch[1] : topMatch[2]);
    if (n > 0 && n <= 500) limit = n;
    // "last 3 employees who joined" / "first 5 joiners" → by joining date
    const word = /^\d/.test(topMatch[1]) ? topMatch[2] : topMatch[1];
    if (limit && dateMention && !measureMention) {
      if (['last', 'latest', 'newest', 'recent'].includes(word)) cues.latest = true;
      else if (['first', 'oldest', 'earliest'].includes(word)) cues.earliest = true;
    }
  }
  const dateColumnDefault = dateMention || pickDateColumn(profile, q, scores);
  // "year wise joining count", "monthly visitors", "per month"
  let period = null;
  const periodMatch = q.lower.match(
    /\b(year|month)\s*wise\b|\bper\s+(year|month)\b|\beach\s+(year|month)\b|\bby\s+(year|month)\b|\b(yearly|annual|annually|monthly)\b/,
  );
  if (periodMatch && dateColumnDefault && !groupBy) {
    const unit =
      periodMatch[1] || periodMatch[2] || periodMatch[3] || periodMatch[4] || periodMatch[5];
    period = /^month/.test(unit) ? 'month' : 'year';
    groupBy = dateColumnDefault;
    markWords(q, [
      'year',
      'month',
      'yearly',
      'monthly',
      'annual',
      'annually',
      'wise',
      'per',
      'each',
      'by',
    ]);
  }
  const usedNumberTokens = new Set();
  const markNumber = (text) => {
    for (const piece of String(text)
      .split(/[^0-9.]+/)
      .filter(Boolean))
      usedNumberTokens.add(piece);
  };

  // between A and B
  let m = q.lower.match(new RegExp(`between\\s+${NUM}\\s*(?:and|to|&|-)\\s*${NUM}`));
  if (m) {
    const a = amount(m[1], m[2]);
    const b = amount(m[3], m[4] || m[2]);
    const bothYears = isYear(a) && isYear(b) && !m[2] && !m[4];
    if (bothYears && dateColumnDefault && !measureMention) {
      dateFilters.push({
        column: dateColumnDefault.name,
        op: 'between',
        value: [`${a}-01-01`, `${b}-12-31`],
      });
    } else {
      const col =
        pickColumn(profile, scores, ['measure'], q.lower.slice(0, m.index), q) ||
        measureMention ||
        soleColumn(profile, 'measure');
      if (col)
        numericFilters.push({
          column: col.name,
          op: 'between',
          value: [Math.min(a, b), Math.max(a, b)],
        });
    }
    markNumber(m[0]);
    markWords(q, ['between', 'and', 'to']);
  }

  const comparators = [
    {
      op: 'gt',
      re: new RegExp(
        `(?:above|over|greater than|more than|higher than|exceeding|exceeds|beyond|>|athigam|athigama)\\s*${NUM}`,
      ),
    },
    { op: 'equals', re: new RegExp(`(?:exactly|equal to|equals|equal|(?<![<>!])==?)\\s*${NUM}`) },
    { op: 'gte', re: new RegExp(`(?:at least|minimum of|>=|not less than)\\s*${NUM}`) },
    {
      op: 'lt',
      re: new RegExp(
        `(?:below|under|less than|lesser than|fewer than|lower than|<|kammi|kuraivana)\\s*${NUM}`,
      ),
    },
    {
      op: 'lte',
      re: new RegExp(`(?:at most|upto|up to|maximum of|<=|not more than|within)\\s*${NUM}`),
    },
    {
      op: 'gte',
      re: new RegExp(`${NUM}\\s*(?:and above|or above|or more|and more|plus|\\+|and over)`),
    },
    { op: 'lte', re: new RegExp(`${NUM}\\s*(?:and below|or below|or less|and under)`) },
    {
      op: 'gt',
      re: new RegExp(
        `${NUM}\\s*(?:ku |kku |um |kum )?(?:mela\\w*|mel\\b|melay|athigam\\w*|adhigam\\w*|jasthi|above|over|more)\\b`,
      ),
    },
    {
      op: 'lt',
      re: new RegExp(
        `${NUM}\\s*(?:ku |kku |um |kum )?(?:keela\\w*|kila\\w*|kammi\\w*|kuraivu\\w*|kurai\\w*|below|under|less)\\b`,
      ),
    },
  ];
  const lowerForNumbers = q.lower;
  for (const { op, re } of comparators) {
    const hit = lowerForNumbers.match(re);
    if (!hit) continue;
    const value = amount(hit[1], hit[2]);
    const before = lowerForNumbers.slice(0, hit.index);
    const isDateLike = isYear(value) && !hit[2];
    const col = pickColumn(profile, scores, ['measure'], before, q);
    if (isDateLike && dateColumnDefault && !col && !(measureMention && !dateMention)) {
      dateFilters.push(...dateFilterFor(op, value, dateColumnDefault.name));
    } else {
      const target =
        col || measureMention || soleColumn(profile, 'measure') || rangeFit(profile, value);
      if (target) numericFilters.push({ column: target.name, op, value });
      else if (isDateLike && dateColumnDefault)
        dateFilters.push(...dateFilterFor(op, value, dateColumnDefault.name));
    }
    markNumber(hit[0]);
    markWords(q, [
      'above',
      'over',
      'greater',
      'than',
      'more',
      'higher',
      'exceeding',
      'exceeds',
      'beyond',
      'athigam',
      'athigama',
      'adhigam',
      'adhigama',
      'least',
      'minimum',
      'below',
      'under',
      'less',
      'lesser',
      'fewer',
      'lower',
      'kammi',
      'kammiya',
      'kammiyaa',
      'most',
      'upto',
      'up',
      'maximum',
      'mela',
      'melay',
      'melaa',
      'keela',
      'keelaa',
      'kila',
      'kurai',
      'kuraivana',
      'jasthi',
      'plus',
      'or',
      'and',
      'not',
      'within',
      'of',
      'mel',
      'ku',
      'kku',
      'kum',
      'exactly',
      'equal',
      'equals',
      'to',
    ]);
  }

  // after / since / before / until + year [+ month]
  const dateWord = q.lower.match(
    /\b(after|since|before|until|till|from)\s+(?:(jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*)\s+)?(\d{4})\b/,
  );
  if (dateWord && dateColumnDefault) {
    const year = Number(dateWord[3]);
    const month = monthNumber(dateWord[2]);
    const word = dateWord[1];
    if (isYear(year)) {
      if (month) {
        const iso = `${year}-${pad2(month)}`;
        const end = `${iso}-${pad2(lastDay(year, month))}`;
        if (word === 'after')
          dateFilters.push({ column: dateColumnDefault.name, op: 'gt', value: end });
        else if (word === 'since' || word === 'from')
          dateFilters.push({ column: dateColumnDefault.name, op: 'gte', value: `${iso}-01` });
        else if (word === 'before')
          dateFilters.push({ column: dateColumnDefault.name, op: 'lt', value: `${iso}-01` });
        else dateFilters.push({ column: dateColumnDefault.name, op: 'lte', value: end });
      } else {
        dateFilters.push(
          ...dateFilterFor(
            word === 'after'
              ? 'gt'
              : word === 'before'
                ? 'lt'
                : word === 'since' || word === 'from'
                  ? 'gte'
                  : 'lte',
            year,
            dateColumnDefault.name,
          ),
        );
      }
      markNumber(dateWord[0]);
      markWords(q, ['after', 'since', 'before', 'until', 'till', 'from']);
      if (month) markWords(q, Object.keys(MONTHS));
    }
  }

  // "in 2023", "joined 2023", "2023 la", "march 2024", "2024-03", ISO / dd-mm-yyyy dates
  const isoDay = q.lower.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  const dmy = q.lower.match(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/);
  const monthYear = q.lower.match(
    /\b(jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*)\s+(\d{4})\b/,
  );
  const yearMonth = q.lower.match(/\b(\d{4})-(\d{2})\b(?!-)/);
  const lastN = q.lower.match(/\b(?:last|past|previous)\s+(\d{1,3})\s+(day|week|month|year)s?\b/);
  const relative = q.lower.match(/\b(this|last|previous|current)\s+(year|month)\b/);
  const plainYear = q.lower.match(/\b(?:in|during|of|year|joined|on|for)?\s*((?:19|20)\d{2})\b/);
  const hasDateFilter = () => dateFilters.length > 0;
  if (dateColumnDefault && !hasDateFilter()) {
    if (isoDay) {
      dateFilters.push({ column: dateColumnDefault.name, op: 'equals', value: isoDay[0] });
      markNumber(isoDay[0]);
    } else if (dmy) {
      const iso = `${dmy[3]}-${pad2(Number(dmy[2]))}-${pad2(Number(dmy[1]))}`;
      dateFilters.push({ column: dateColumnDefault.name, op: 'equals', value: iso });
      markNumber(dmy[0]);
    } else if (monthYear && monthNumber(monthYear[1])) {
      dateFilters.push({
        column: dateColumnDefault.name,
        op: 'month',
        value: `${monthYear[2]}-${pad2(monthNumber(monthYear[1]))}`,
      });
      markNumber(monthYear[0]);
      markWords(q, Object.keys(MONTHS));
    } else if (yearMonth && Number(yearMonth[2]) >= 1 && Number(yearMonth[2]) <= 12) {
      dateFilters.push({
        column: dateColumnDefault.name,
        op: 'month',
        value: `${yearMonth[1]}-${yearMonth[2]}`,
      });
      markNumber(yearMonth[0]);
    } else if (lastN) {
      const n = Number(lastN[1]);
      const unit = lastN[2];
      const from = new Date(q.now);
      if (unit === 'day') from.setUTCDate(from.getUTCDate() - n);
      else if (unit === 'week') from.setUTCDate(from.getUTCDate() - 7 * n);
      else if (unit === 'month') from.setUTCMonth(from.getUTCMonth() - n);
      else from.setUTCFullYear(from.getUTCFullYear() - n);
      dateFilters.push({
        column: dateColumnDefault.name,
        op: 'gte',
        value: from.toISOString().slice(0, 10),
      });
      markNumber(lastN[0]);
      markWords(q, [
        'last',
        'past',
        'previous',
        'day',
        'days',
        'week',
        'weeks',
        'month',
        'months',
        'year',
        'years',
      ]);
    } else if (relative) {
      const year = q.now.getUTCFullYear();
      const month = q.now.getUTCMonth() + 1;
      const last = relative[1] === 'last' || relative[1] === 'previous';
      if (relative[2] === 'year')
        dateFilters.push({
          column: dateColumnDefault.name,
          op: 'year',
          value: last ? year - 1 : year,
        });
      else {
        const target = new Date(Date.UTC(year, month - 1 - (last ? 1 : 0), 1));
        dateFilters.push({
          column: dateColumnDefault.name,
          op: 'month',
          value: `${target.getUTCFullYear()}-${pad2(target.getUTCMonth() + 1)}`,
        });
      }
      markWords(q, ['this', 'last', 'previous', 'current', 'year', 'month']);
    } else if (plainYear && !usedNumberTokens.has(plainYear[1])) {
      const before = q.lower.slice(0, plainYear.index);
      const salaryNumber =
        measureMention &&
        new RegExp(`${measureMention.words[0] || '@@'}\\s*(?:is|=|of)?\\s*$`).test(before);
      if (!salaryNumber) {
        dateFilters.push({
          column: dateColumnDefault.name,
          op: 'year',
          value: Number(plainYear[1]),
        });
        markNumber(plainYear[1]);
      }
    }
  }
  filters.push(...dateFilters, ...numericFilters);

  // empty / missing values
  const emptyMatch = q.lower.match(/\b(?:without|missing|blank|empty|no)\s+([a-z ]{3,30})$/);
  if (emptyMatch && /\b(without|missing|blank|empty)\b/.test(q.lower)) {
    const target = mentioned.find((s) => !matchedColumn.has(s.col.index));
    if (target) {
      filters.push({ column: target.col.name, op: 'is_empty', value: '' });
      markWords(q, ['without', 'missing', 'blank', 'empty']);
    }
  }

  // ── 6. target column for aggregates / sorting ─────────────────
  const aggregateColumn = measureMention || null;

  // sort / order requests
  let sortBy = null;
  let sortDir = null;
  const sortExplicit = q.lower.match(
    /\b(?:sort|sorted|order|ordered|arrange)(?:ed)?\s+by\s+([a-z ]+?)(?:\s+(asc|ascending|desc|descending))?\b(?:\s|$)/,
  );
  if (sortExplicit) {
    const col = columnScores(profile, { ...q, tokens: wordsOf(sortExplicit[1]) }, 0, 99)
      .filter((s) => s.score >= 0.5)
      .sort((a, b) => b.score - a.score)[0]?.col;
    if (col) {
      sortBy = col.name;
      sortDir = /^desc/.test(sortExplicit[2] || '') ? 'desc' : 'asc';
      markWords(q, [
        'sort',
        'sorted',
        'order',
        'ordered',
        'arrange',
        'by',
        'asc',
        'ascending',
        'desc',
        'descending',
      ]);
    }
  }

  // ── 7. choose the operation ───────────────────────────────────
  let operation = 'list';
  let column = null;
  let groupOp = null;
  const measureAsked = aggregateColumn && aggregateColumn.role === 'measure';

  if (cues.avg && measureAsked) operation = 'avg';
  else if (cues.sum && measureAsked) operation = 'sum';
  else if (cues.max && measureAsked && !limit && !(cues.which && groupBy && !cues.avg && !cues.sum))
    operation = 'max';
  else if (cues.min && measureAsked && !limit && !(cues.which && groupBy && !cues.avg && !cues.sum))
    operation = 'min';
  else if (cues.count || (cues.sum && !measureAsked)) operation = 'count';

  // "Laptop stock quantity" → quantities add up; the matching rows are shown with the total.
  if (
    operation === 'list' &&
    measureAsked &&
    (aggregateColumn.concepts.has('quantity') || aggregateColumn.concepts.has('revenue')) &&
    filters.length &&
    !cues.list &&
    !limit &&
    !sortBy &&
    !numericFilters.some((f) => f.column === aggregateColumn.name)
  ) {
    operation = 'sum';
  }

  if (operation === 'avg' || operation === 'sum' || operation === 'min' || operation === 'max')
    column = aggregateColumn.name;

  // top N / bottom N / most recent / oldest
  if (limit || cues.latest || cues.earliest) {
    const wantsHigh =
      cues.max || cues.latest || /\b(top|highest|best|latest|newest|recent)\b/.test(q.lower);
    const wantsLow =
      cues.min || cues.earliest || /\b(bottom|lowest|worst|oldest|earliest)\b/.test(q.lower);
    const byDate = (cues.latest || cues.earliest) && dateColumnDefault && !measureAsked;
    if (byDate) {
      sortBy = dateColumnDefault.name;
      sortDir = cues.earliest && !cues.latest ? 'asc' : 'desc';
      limit ||= 5;
      operation = 'list';
      column = null;
    } else if (measureAsked && operation !== 'avg' && operation !== 'sum') {
      sortBy = aggregateColumn.name;
      sortDir = wantsLow && !wantsHigh ? 'asc' : 'desc';
      limit ||= 5;
      operation = 'list';
      column = null;
    }
  }

  let aggregateUnclear = false;
  if (groupBy && operation === 'list' && measureAsked && !limit && !period) {
    // "region wise revenue" → totals; "department wise salary" could be a total or an average → not sure.
    if (aggregateColumn.concepts.has('quantity') || aggregateColumn.concepts.has('revenue'))
      operation = 'sum';
    else aggregateUnclear = true;
    if (operation === 'sum') column = aggregateColumn.name;
  }
  let projectColumns = null;
  if (operation === 'list' && !groupBy && !period && !limit) {
    const found = detectProjection({
      profile,
      q,
      mentioned,
      firstMention,
      matchedColumn,
      mentionTokens,
      sortBy,
      cues,
    });
    if (found?.length) {
      projectColumns = found;
      notes.push(`columns: ${found.map((c) => c.name).join(', ')}`);
      tokens.forEach((t, i) => {
        if (PROJECT_ONLY.has(t) || PROJECT_VERBS.has(t) || PROJECT_NOUNS.has(t)) q.used[i] = true;
      });
    }
  }
  if (groupBy) {
    if (operation === 'avg' || operation === 'sum' || operation === 'min' || operation === 'max')
      groupOp = operation;
    else if (cues.which && rank && measureAsked && (cues.max || cues.min) && !cues.count)
      groupOp = null;
    operation = groupOp || 'group_count';
  } else if (
    operation === 'count' &&
    !filters.length &&
    mentioned.some(
      (s) =>
        (s.col.role === 'category' || s.col.role === 'label') &&
        !matchedColumn.has(s.col.index) &&
        !entitySubject(s.col),
    )
  ) {
    // "how many companies are there" → number of distinct values
    const target = mentioned.find(
      (s) =>
        (s.col.role === 'category' || s.col.role === 'label') &&
        !matchedColumn.has(s.col.index) &&
        !entitySubject(s.col),
    );
    operation = 'distinct_count';
    column = target.col.name;
  } else if (
    !projectColumns &&
    operation === 'list' &&
    !limit &&
    !sortBy &&
    (cues.distinct || cues.list || cues.which)
  ) {
    // "list all cities", "which departments are there", "unique companies"
    const target = mentioned.find(
      (s) =>
        (s.col.role === 'category' || (s.col.role === 'label' && cues.distinct)) &&
        !matchedColumn.has(s.col.index) &&
        !entitySubject(s.col),
    );
    if (target && (cues.distinct || cues.list || cues.which)) {
      groupBy = target.col;
      operation = 'group_count';
      notes.push('distinct values');
    }
  }

  // The column mentioned as the "thing" must not stay unexplained.
  for (const i of mentionTokens) q.used[i] = true;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (
      FILLER.has(t) ||
      ENTITY.has(t) ||
      ENTITY.has(stemWord(t)) ||
      TANGLISH_VERB.test(t) ||
      profile.nameWords?.has(stemWord(t))
    )
      q.used[i] = true;
    else if (t.length >= 6 && nearKnownWord(t)) q.used[i] = true; // "employes", "emplyees"
    const numeric = t.match(/^(\d+)(k|lakhs?|lacs?|crores?|cr|m)?$/);
    if (numeric && (usedNumberTokens.has(numeric[1]) || (limit && String(limit) === numeric[1])))
      q.used[i] = true;
    if (
      [
        'k',
        'lakh',
        'lakhs',
        'lac',
        'lacs',
        'crore',
        'crores',
        'cr',
        'rs',
        'inr',
        'rupees',
        'rupee',
      ].includes(t)
    )
      q.used[i] = true;
    if (['in', 'on', 'of', 'year', 'month', 'day', 'date'].includes(t)) q.used[i] = true;
  }

  const plan = { filters, operation };
  if (column) plan.column = column;
  if (groupBy) plan.groupBy = groupBy.name;
  if (sortBy) {
    plan.sortBy = sortBy;
    plan.sortDir = sortDir || 'asc';
  }
  if (limit) plan.limit = limit;
  if (rank) plan.rank = rank;
  if (period) plan.period = period;
  if (projectColumns) plan.columns = projectColumns.map((c) => c.name);

  // ── 8. classify + confidence ──────────────────────────────────
  const unexplained = tokens.filter((t, i) => !q.used[i] && t.length >= 3);
  const analyticSignal =
    ['count', 'sum', 'avg', 'min', 'max', 'group_count', 'distinct_count'].includes(operation) ||
    !!groupBy ||
    filters.some((f) =>
      ['gt', 'gte', 'lt', 'lte', 'between', 'year', 'month', 'is_empty'].includes(f.op),
    ) ||
    (operation === 'list' && (hasCategoryFilter || (sortBy && limit))) ||
    !!projectColumns;
  let kind = 'unknown';
  if (analyticSignal) kind = 'analytic';
  else if (hasOnlyNameFilters) kind = 'lookup';
  else if (filters.length) kind = 'analytic';
  const hasSubstance =
    filters.length > 0 || operation !== 'list' || !!groupBy || !!sortBy || !!projectColumns;
  const confident =
    kind === 'analytic' && hasSubstance && unexplained.length === 0 && !aggregateUnclear;
  return { kind, confident, plan, unexplained, grounded, cues, notes };
}

function ENTITY_IN(q) {
  return q.tokens.some((t) => ENTITY.has(t) || ENTITY.has(stemWord(t)));
}

function scoreWindow(profile, q, from, to) {
  // "per order" in an Orders sheet means "per row", not a column to group by.
  const words = q.tokens
    .slice(from, to)
    .map(stemWord)
    .filter((w) => !FILLER.has(w));
  const entityOnly =
    words.length > 0 && words.every((w) => ENTITY.has(w) || profile.nameWords?.has(w));
  const best = columnScores(profile, q, from, to)
    .filter(
      (s) =>
        s.score >= (s.col.role === 'date' ? 0.75 : 0.5) &&
        s.col.role !== 'identifier' &&
        s.col.role !== 'measure',
    )
    .sort((a, b) => b.score - a.score || a.col.index - b.col.index)[0];
  if (best && entityOnly && best.score < 1 && best.col.role !== 'category') return null;
  return best || null;
}

function pickDateColumn(profile, q, scores) {
  const dates = profile.columns.filter((c) => c.role === 'date');
  if (!dates.length) return null;
  const ranked = scores.filter((s) => s.col.role === 'date').sort((a, b) => b.score - a.score);
  if (ranked[0]?.score > 0) return ranked[0].col;
  return dates[0];
}

function dateFilterFor(op, year, column) {
  switch (op) {
    case 'gt':
      return [{ column, op: 'gt', value: `${year}-12-31` }];
    case 'gte':
      return [{ column, op: 'gte', value: `${year}-01-01` }];
    case 'lt':
      return [{ column, op: 'lt', value: `${year}-01-01` }];
    case 'lte':
      return [{ column, op: 'lte', value: `${year}-12-31` }];
    default:
      return [{ column, op: 'year', value: year }];
  }
}

// ───────────────────────── repairing a model plan ─────────────────────────
const OPERATION_ALIASES = {
  average: 'avg',
  mean: 'avg',
  total: 'sum',
  maximum: 'max',
  minimum: 'min',
  highest: 'max',
  lowest: 'min',
  group: 'group_count',
  groupcount: 'group_count',
  group_count: 'group_count',
  groupby: 'group_count',
  distinct: 'group_count',
  count_distinct: 'distinct_count',
  distinctcount: 'distinct_count',
  unique_count: 'distinct_count',
  find: 'list',
  filter: 'list',
  select: 'list',
  show: 'list',
  lookup: 'list',
  sort: 'list',
  top: 'list',
  details: 'list',
};
const FILTER_OP_ALIASES = {
  '=': 'equals',
  '==': 'equals',
  is: 'equals',
  eq: 'equals',
  equal: 'equals',
  exact: 'equals',
  match: 'equals',
  '!=': 'not_equals',
  neq: 'not_equals',
  '<>': 'not_equals',
  not: 'not_equals',
  like: 'contains',
  includes: 'contains',
  has: 'contains',
  contain: 'contains',
  substring: 'contains',
  '>': 'gt',
  after: 'gt',
  above: 'gt',
  greater: 'gt',
  '>=': 'gte',
  '<': 'lt',
  before: 'lt',
  below: 'lt',
  less: 'lt',
  '<=': 'lte',
  range: 'between',
  in_range: 'between',
  one_of: 'in',
  any: 'in',
  in_list: 'in',
  empty: 'is_empty',
  blank: 'is_empty',
  null: 'is_empty',
};

/** Index of the real column a model-written name refers to, or -1. */
export function resolveColumnSmart(profile, name) {
  if (name == null || name === '') return -1;
  const cols = profile.columns;
  const norm = wordsOf(String(name)).join('');
  if (!norm) return -1;
  let hit = cols.findIndex((c) => c.normName.replace(/ /g, '') === norm);
  if (hit >= 0) return hit;
  const stems = wordsOf(String(name)).map(stemWord).sort().join(' ');
  hit = cols.findIndex((c) => [...c.words].sort().join(' ') === stems);
  if (hit >= 0) return hit;
  const concepts = conceptsOf(wordsOf(String(name)));
  if (concepts.size) {
    const candidates = cols.filter((c) => [...concepts].some((k) => c.concepts.has(k)));
    if (candidates.length === 1) return candidates[0].index;
    if (candidates.length > 1) {
      const nameStems = wordsOf(String(name)).map(stemWord);
      const exactish = candidates.find((c) => nameStems.some((s) => c.words.includes(s)));
      if (exactish) return exactish.index;
      return candidates[0].index;
    }
  }
  hit = cols.findIndex(
    (c) =>
      c.normName.replace(/ /g, '').includes(norm) || norm.includes(c.normName.replace(/ /g, '')),
  );
  if (hit >= 0 && norm.length >= 3) return hit;
  let bestIndex = -1;
  let bestDistance = 3;
  for (const c of cols) {
    const d = editDistance(c.normName.replace(/ /g, ''), norm, 2);
    if (d < bestDistance) {
      bestDistance = d;
      bestIndex = c.index;
    }
  }
  return bestIndex;
}

/** Closest real cell value of a column for a model-written value (or null). */
export function groundValue(col, value) {
  if (!col?.lookup) return null;
  const vWords = wordsOf(String(value ?? ''));
  if (!vWords.length) return null;
  const norm = vWords.join(' ');
  const stem = vWords.map(stemWord).join(' ');
  if (col.lookup.has(norm)) return col.lookup.get(norm);
  if (col.lookup.has(stem)) return col.lookup.get(stem);
  if (col.lookup.has(stripSuffix(stem))) return col.lookup.get(stripSuffix(stem));
  const limit = norm.length >= 8 ? 2 : norm.length >= 4 ? 1 : 0;
  if (!limit) return null;
  let best = null;
  let bestDistance = limit + 1;
  let ties = 0;
  for (const [key, original] of col.lookup) {
    if (key.includes(' ') !== norm.includes(' ') && Math.abs(key.length - norm.length) > 2)
      continue;
    const d = editDistance(key, norm, limit);
    if (d < bestDistance) {
      bestDistance = d;
      best = original;
      ties = 1;
    } else if (d === bestDistance && original !== best) ties++;
  }
  return best && ties === 1 ? best : null;
}

/**
 * Makes a model-written plan safe and faithful to the data: real column names,
 * real cell values, a recognised operation. Returns {plan, changes}.
 */
export function repairPlan(rawPlan, profile, question, { compiled } = {}) {
  const changes = [];
  const plan = { ...rawPlan };
  const q = prepareQuestion(question);
  const colIndex = (name) => resolveColumnSmart(profile, name);

  let operation = String(plan.operation || 'list')
    .toLowerCase()
    .trim();
  operation = OPERATION_ALIASES[operation] || operation;
  if (
    !['list', 'count', 'sum', 'avg', 'min', 'max', 'group_count', 'distinct_count'].includes(
      operation,
    )
  )
    operation = 'list';

  const fixColumn = (name, label) => {
    if (name == null || name === '') return null;
    const i = colIndex(name);
    if (i < 0) {
      changes.push(`${label} "${name}" is not a column`);
      return null;
    }
    if (profile.columns[i].name !== name)
      changes.push(`${label} "${name}" → "${profile.columns[i].name}"`);
    return profile.columns[i].name;
  };

  const out = { operation, filters: [] };
  const column = fixColumn(plan.column, 'column');
  const groupBy = fixColumn(plan.groupBy, 'groupBy');
  const sortBy = fixColumn(plan.sortBy, 'sortBy');
  if (column) out.column = column;
  if (groupBy) out.groupBy = groupBy;
  if (sortBy) {
    out.sortBy = sortBy;
    out.sortDir = String(plan.sortDir || 'asc')
      .toLowerCase()
      .startsWith('d')
      ? 'desc'
      : 'asc';
  }
  if (Number(plan.limit) > 0) out.limit = Math.min(Math.floor(Number(plan.limit)), 500);
  if (plan.rank === 'top' || plan.rank === 'bottom') out.rank = plan.rank;
  if (Array.isArray(plan.columns) && out.operation === 'list') {
    const kept = [
      ...new Set(plan.columns.map((name) => fixColumn(name, 'columns')).filter(Boolean)),
    ];
    if (kept.length) out.columns = kept;
  }
  if (plan.period === 'year' || plan.period === 'month') out.period = plan.period;

  const questionText = ` ${q.norm} `;
  const questionStems = ` ${q.stems.join(' ')} `;
  const supportedByQuestion = (value) => {
    const n = wordsOf(String(value));
    if (!n.length) return false;
    const joined = n.join(' ');
    return (
      questionText.includes(` ${joined} `) ||
      questionStems.includes(` ${n.map(stemWord).join(' ')} `) ||
      q.stripped.some((w) => w === n.map(stemWord).join(' '))
    );
  };

  for (const raw of Array.isArray(plan.filters) ? plan.filters.slice(0, 8) : []) {
    if (!raw || typeof raw !== 'object') continue;
    let op = String(raw.op || 'contains')
      .toLowerCase()
      .trim();
    op = FILTER_OP_ALIASES[op] || op;
    let value = raw.value;
    let index = colIndex(raw.column);
    const isEmptyOp = op === 'is_empty' || op === 'not_empty';
    if (!isEmptyOp && (value == null || value === '')) continue;
    const list = Array.isArray(value) ? value : [value];

    // Text-like columns: replace the model's spelling with the real cell value.
    const grounded = [];
    let moved = null;
    for (const item of list) {
      const text = String(item);
      const home = index >= 0 ? profile.columns[index] : null;
      const textual = !home || home.type === 'text' || home.role === 'identifier';
      if (!textual || ['gt', 'gte', 'lt', 'lte', 'between', 'year', 'month'].includes(op)) {
        grounded.push(item);
        continue;
      }
      let real = home ? groundValue(home, text) : null;
      if (!real) {
        // The value may live in a different column than the one the model named.
        for (const other of profile.columns) {
          if (other === home || !other.lookup) continue;
          const found = groundValue(other, text);
          if (found && wordsOf(found).join(' ') === wordsOf(text).join(' ')) {
            real = found;
            moved = other.index;
            break;
          }
        }
      }
      if (real) {
        grounded.push(real);
        if (real !== text) changes.push(`value "${text}" → "${real}"`);
      } else if (supportedByQuestion(text)) grounded.push(item);
      else changes.push(`dropped value "${text}" (not in the question or the data)`);
    }
    if (moved != null) {
      changes.push(`filter column → "${profile.columns[moved].name}"`);
      index = moved;
    }
    if (!isEmptyOp && !grounded.length) continue;
    if (index < 0 && !isEmptyOp) {
      // No usable column: let the executor search every column for the value.
      out.filters.push({ op: 'contains', value: grounded.length === 1 ? grounded[0] : grounded });
      continue;
    }
    if (index < 0) continue;
    const home = profile.columns[index];
    let finalOp = op;
    if (
      home.lookup &&
      ['contains', 'equals'].includes(op) &&
      grounded.every((g) => home.counts.has(String(g)))
    ) {
      finalOp = grounded.length > 1 ? 'in' : 'equals';
    }
    if (finalOp === 'in' && grounded.length === 1) finalOp = 'equals';
    out.filters.push({
      column: home.name,
      op: finalOp,
      value: isEmptyOp ? '' : finalOp === 'in' || finalOp === 'between' ? grounded : grounded[0],
    });
  }

  // Values the question mentions that the model forgot (exact data matches only).
  if (compiled?.grounded?.length) {
    for (const g of compiled.grounded) {
      if (g.role === 'identifier' && g.values.length === 0) continue;
      const already = out.filters.some((f) => f.column === g.column);
      if (!already) {
        out.filters.push({
          column: g.column,
          op: g.values.length > 1 ? 'in' : 'equals',
          value: g.values.length > 1 ? g.values : g.values[0],
        });
        changes.push(`added filter ${g.column} = ${g.values.join(', ')} (found in the question)`);
      }
    }
  }

  // Operation sanity from explicit question words.
  const cueOp =
    compiled?.plan && compiled.plan.operation !== 'list' ? compiled.plan.operation : null;
  if (
    cueOp &&
    ['count', 'sum', 'avg', 'min', 'max', 'distinct_count'].includes(cueOp) &&
    out.operation === 'list' &&
    !out.sortBy
  ) {
    changes.push(`operation list → ${cueOp} (question words)`);
    out.operation = cueOp;
    if (compiled.plan.column && !out.column) out.column = compiled.plan.column;
  }
  if (['sum', 'avg', 'min', 'max'].includes(out.operation) && !out.column) {
    const measure = compiled?.plan?.column || soleColumn(profile, 'measure')?.name;
    if (measure) {
      out.column = measure;
      changes.push(`column → "${measure}"`);
    } else out.operation = 'count';
  }
  if (out.operation === 'group_count' && !out.groupBy && out.column) out.groupBy = out.column;
  return { plan: out, changes };
}
