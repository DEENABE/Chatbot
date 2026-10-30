import { normText } from './operations.js';
import { normKey } from './values.js';

/**
 * DocumentTaskRouter: deterministic parsing of a request (English, Tamil and
 * Tanglish) into a structured task. It reads IDs, numeric/date ranges, column
 * mentions, aggregations, output formats and target files with regular
 * expressions and the real column names of the attached tables — no model.
 * When something required is missing or ambiguous it returns a clarifying
 * question instead of guessing. It never changes the requested range.
 *
 * Context: { documents: [{ id, name, kind, tables: [{ name, columns, types }], pages? }] }
 */

// ---------------------------------------------------------------- lexicon

const FORMAT_WORDS = [
  ['xlsx', /\b(?:excel|xlsx|spreadsheet|workbook)\b|எக்செல்/i],
  ['docx', /\b(?:ms[ -]?word|word|docx)\b|வேர்ட்/i],
  ['pdf', /\bpdf\b/i],
  ['csv', /\bcsv\b/i],
  ['json', /\bjson\b/i],
  ['txt', /\b(?:txt|plain text|text file|notepad)\b/i],
  ['html', /\bhtml?\b/i],
  ['md', /\bmarkdown\b/i],
];

const AGG = [
  ['AVERAGE', /\b(?:average|avg|mean|sarasari|saraasari)\b|சராசரி/i],
  ['MEDIAN', /\bmedian\b/i],
  ['COUNTBLANK', /\bcount ?blanks?\b|\bhow many (?:blank|empty)\b/i],
  ['COUNTA', /\bcounta\b|\bcount (?:of )?(?:non[- ]?empty|filled)\b/i],
  ['MIN', /\b(?:min(?:imum)?|lowest|smallest|least|kuraindha|kammiyana)\b|குறைந்த/i],
  [
    'MAX',
    /\b(?:max(?:imum)?|highest|largest|biggest|greatest|adhigamana|athigamana|perusu)\b|அதிகபட்ச/i,
  ],
  [
    'COUNT',
    /\b(?:count|how many|number of|no\.? of|ethana|ethanai|evlo per|evvalavu per|mothamaa ethana)\b|எத்தனை/i,
  ],
  [
    'SUM',
    /\b(?:sum|total|add up|grand total|mothama?|mottham|kootu|kootal|koottu)\b|மொத்த|கூட்டு/i,
  ],
];

const EXPLICIT_IF = /\b(sumif|countif|averageif)\b/i;
const SUMMARY =
  /\b(?:summar(?:y|ies|ise|ize|ised|ized)|tl;?dr|gist|overview|key points|surukkam|surukkama|surukki)\b|சுருக்க/i;
const EXPLAIN =
  /\b(?:explain|explanation|vilakku|vilakkam|vilakki|puriya vai|what does .* mean)\b|விளக்க|விளக்கு/i;
const SECTIONWISE =
  /\b(?:section[- ]?(?:by[- ]?section|wise)|each section|page[- ]?(?:by[- ]?page|wise)|ovvoru section)\b|பகுதி வாரியாக/i;
const COMPARE =
  /\b(?:compare|comparison|difference|differences|diff|vithyasam|vidhyasam|vs\.?|versus)\b|வித்தியாச|ஒப்பிடு/i;
const CONVERT =
  /\b(?:convert|conversion|export|save|turn|change|transform|maathu|maattru|mathu|maathi)\b|மாற்று|மாற்றி/i;
const GENERATE =
  /\b(?:create|generate|make|prepare|build|produce|draft|write|ready pannu|uruvaakku|uruvakku|ezhuthu)\b|உருவாக்கு|தயார் செய்/i;
const REPORT = /\b(?:report|document|doc|summary sheet|statement|template)\b|அறிக்கை|ரிப்போர்ட்/i;
const EDIT =
  /\b(?:replace|edit|modify|update|rename (?:the )?column|insert|add (?:a )?(?:total|column|row)|change .* to)\b|திருத்து/i;
const SHOW =
  /\b(?:list|show|display|get|give|fetch|find|kaattu|kaatu|kattu|edu|eduthu|venum|list ?out|print)\b|காட்டு|பட்டியல்/i;
const SEARCH =
  /\b(?:search|find|look for|where is|mention(?:ed|s)?|occurrences? of|enga irukku|engae)\b|தேடு/i;
const DUPLICATE =
  /\b(?:duplicates?|duplicated|repeated|repeat(?:ing)?|same (?:entries|rows|values)|nakal)\b|நகல்/i;
const GROUP =
  /\b(?:group(?:ed)? by|by each|per|wise|breakdown|break[- ]?up|vaariyaga|vaariyaa)\b|வாரியாக/i;
const SORT =
  /\b(?:sort(?:ed)?|order(?:ed)? by|arrange|rank|top|bottom|highest first|lowest first|ascending|descending)\b|வரிசைப்படுத்து/i;
const INSPECT =
  /\b(?:what(?:'s| is) in|describe|columns|sheets|metadata|structure|details of (?:this|the) file|file info)\b/i;
const TAMIL_OUT =
  /\b(?:in tamil|tamil(?:-| )?(?:la|il|le|language)|thamizh(?:-| )?la)\b|தமிழில்|தமிழ்/i;
const MONTHLY = /\b(?:monthly|month[- ]?wise|per month|each month|maadha|maadhaandhira)\b|மாத/i;

const ID_TOKEN = String.raw`[A-Za-z][A-Za-z]{0,9}[-_/]?\d{1,12}`;
const RANGE_SEP = String.raw`\s*(?:to|till|until|through|thru|upto|up to|-|–|—|~|\.\.|varai|vara|muthal|mudhal|la irundhu|il irundhu|irundhu)\s*`;
const DATE_TOKEN = String.raw`\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}[\s-](?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*[\s,-]+\d{2,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}`;
const NUM = String.raw`[-+]?(?:₹|rs\.?\s*)?\d[\d,]*(?:\.\d+)?%?`;

const OPS = [
  // order matters: longer phrases first
  ['gte', /(?:>=|≥|at least|minimum of|or more|and above|or above|kku mela or equal)/i],
  ['lte', /(?:<=|≤|at most|maximum of|or less|and below|or below|not more than)/i],
  ['ne', /(?:!=|≠|<>|is not|isn't|not equal(?: to)?|other than|except)/i],
  [
    'gt',
    /(?:>|greater than|more than|above|over|higher than|exceeds?|exceeding|mela|melae|adhigam|athigam|adhigama|athigama|க்கு மேல்|மேல்)/i,
  ],
  [
    'lt',
    /(?:<|less than|lower than|below|under|fewer than|kammi|kammiya|kuraiva|kuraivaa|kuraivu|keezha|keezhe|kizha|க்கு கீழ்|கீழ்|குறைவ)/i,
  ],
  [
    'contains',
    /(?:contains?|containing|including|includes|with the word|has the word|irukura|irukkira)/i,
  ],
  ['starts', /(?:starts? with|starting with|begins? with)/i],
  ['ends', /(?:ends? with|ending with)/i],
  ['eq', /(?:=|==|equals?|equal to|is|are|was|of|as|:)/i],
];

// --------------------------------------------------------------- helpers

export function wantedFormat(text) {
  // "convert this PDF to Word": the target is the format after to/into/as.
  const after =
    String(text).match(
      /\b(?:to|into|as|in|la|le|aaga|aaka|ஆக)\s+(?:an?\s+)?(?:ms[ -]?)?([a-z]{3,11})\b/gi,
    ) || [];
  for (const piece of after.reverse()) {
    for (const [f, re] of FORMAT_WORDS) if (re.test(piece)) return f;
  }
  const found = FORMAT_WORDS.filter(([, re]) => re.test(text)).map(([f]) => f);
  return found.at(-1) || null;
}

function sourceFormatWord(text) {
  const m = String(text).match(
    /\b(pdf|word|docx?|excel|xlsx|xls|csv|json|txt|text)\b\s*(?:file\s*)?(?:to|into|->|→|la irundhu)/i,
  );
  return m ? m[1].toLowerCase() : null;
}

const FORMAT_NAME = String.raw`(?:excel|xlsx|spreadsheet|workbook|ms[ -]?word|word|docx|pdf|csv|json|txt|text file|html|markdown)`;

/**
 * Output format the user asks for on a retrieval/report task (not the format
 * of the source file): "export to Excel", "as PDF", "... in Excel." at the end,
 * Tanglish "Excel-aa kudu". "Excel-la total SUM pannu" names the source, so it
 * is not an output request.
 */
export function requestedOutput(text) {
  const t = String(text);
  const pick = (m) => (m ? wantedFormat(m[0]) : null);
  return (
    pick(
      t.match(
        new RegExp(
          `\\b(?:export|download|save|generate|create|make|prepare|produce|build|write)\\b[\\s\\S]{0,50}?\\b${FORMAT_NAME}\\b`,
          'i',
        ),
      ),
    ) ||
    pick(
      t.match(new RegExp(`\\b(?:as|to|into)\\s+(?:an?\\s+)?(?:new\\s+)?${FORMAT_NAME}\\b`, 'i')),
    ) ||
    pick(
      t.match(
        new RegExp(
          `\\bin\\s+(?:an?\\s+)?(?:new\\s+)?${FORMAT_NAME}(?:\\s+(?:file|format|sheet))?\\s*[.!?]?\\s*$`,
          'i',
        ),
      ),
    ) ||
    pick(
      t.match(
        new RegExp(
          `\\b${FORMAT_NAME}[\\s-]*(?:file\\s*)?(?:aa|aaga|ah|a)\\s+(?:kudu|venum|tha|thaa|podu|pannu|maathu)\\b`,
          'i',
        ),
      ),
    ) ||
    null
  );
}

/** Kind of source document named in the request ("this PDF", "the Word document", "Excel-la"). */
export function sourceKindHint(text) {
  const t = String(text);
  const first = t
    .match(/\b(pdf|word|docx|doc|excel|xlsx|xls|csv|sheet|spreadsheet|json|text file|txt)\b/i)?.[1]
    ?.toLowerCase();
  if (!first) return null;
  if (first === 'pdf') return 'pdf';
  if (['word', 'docx', 'doc'].includes(first)) return 'word';
  if (['json'].includes(first)) return 'json';
  if (['txt', 'text file'].includes(first)) return 'text';
  return 'spreadsheet';
}

function stripFileNames(text, documents) {
  let t = String(text);
  for (const d of documents) {
    const re = new RegExp(d.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    t = t.replace(re, ' the file ');
  }
  return t.replace(/\b[\w-]+\.(?:pdf|docx?|xlsx|xlsm|xls|csv|tsv|json|txt|md)\b/gi, ' the file ');
}

/** Column mentions with their position, longest names first, non-overlapping. */
export function findColumnMentions(text, columns) {
  const lower = ` ${normText(text)} `;
  const found = [];
  const taken = [];
  const cands = columns
    .map((c, i) => ({ c, i, n: normText(c) }))
    .filter((x) => x.n.length >= 2)
    .sort((a, b) => b.n.length - a.n.length);
  for (const { c, i, n } of cands) {
    const variants = new Set([n, n.replace(/ /g, ''), `${n}s`, n.replace(/s$/, '')]);
    for (const v of variants) {
      if (v.length < 2) continue;
      const re = new RegExp(`(?<=\\s)${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s)`, 'g');
      let m;
      while ((m = re.exec(lower))) {
        const start = m.index;
        const end = start + v.length;
        if (taken.some(([a, b]) => start < b && end > a)) continue;
        taken.push([start, end]);
        found.push({ column: c, index: i, start, end });
      }
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

function normalizedMessage(text) {
  return ` ${normText(text)} `;
}

/** Parses "X to Y" ID ranges, including Tanglish "P110 muthal P115 varai". */
export function parseIdRange(text) {
  const t = String(text);
  const between = t.match(
    new RegExp(`\\bbetween\\s+(${ID_TOKEN})\\s+(?:and|&|to)\\s+(${ID_TOKEN}|\\d{1,12})\\b`, 'i'),
  );
  if (between) return { from: between[1], to: between[2] };
  const range = t.match(
    new RegExp(
      `(?:^|[^A-Za-z0-9])(${ID_TOKEN})${RANGE_SEP}(${ID_TOKEN}|\\d{1,12})(?![A-Za-z0-9])`,
      'i',
    ),
  );
  if (!range) return null;
  const a = range[1];
  const b = range[2];
  // "page 2 to 5" / "row 3 to 9" / dates are not ID ranges.
  if (
    /^(?:page|pages|pg|row|rows|line|lines|sheet|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|q|fy)\d/i.test(
      a.replace(/[-_/]/g, ''),
    )
  )
    return null;
  if (/^[A-Za-z]{2,}\d{4}$/.test(a) && /^(?:19|20)\d\d$/.test(a.replace(/\D/g, ''))) return null;
  return { from: a, to: b };
}

/** "P110, P112 and P118" → explicit lookup list (≥ 2 IDs sharing a prefix). */
export function parseIdList(text) {
  const ids = [
    ...String(text).matchAll(new RegExp(`(?:^|[^A-Za-z0-9])(${ID_TOKEN})(?![A-Za-z0-9])`, 'g')),
  ].map((m) => m[1]);
  if (ids.length < 1) return null;
  const prefix = (s) => s.replace(/[-_/]?\d+$/, '').toLowerCase();
  const p = prefix(ids[0]);
  if (!ids.every((x) => prefix(x) === p)) return null;
  if (/^(?:page|row|sheet|q|fy)$/i.test(p)) return null;
  return [...new Set(ids)];
}

function parsePageRange(text) {
  const m = String(text).match(
    /\bpages?\s*(\d{1,5})(?:\s*(?:to|-|–|through|till|varai|and)\s*(\d{1,5}))?/i,
  );
  return m ? { from: Number(m[1]), to: Number(m[2] || m[1]) } : null;
}

function parseDates(text) {
  return [...String(text).matchAll(new RegExp(`(?:${DATE_TOKEN})`, 'gi'))].map((m) => ({
    value: m[0],
    index: m.index,
  }));
}

function cleanValue(v) {
  return String(v ?? '')
    .trim()
    .replace(/^["'“”‘’]|["'“”‘’]$/g, '')
    .replace(
      /\s+(?:only|mattum|ah|aa|a|la|le|nu|irukura|irukkira|rows?|records?|entries|items|products?)$/i,
      '',
    )
    .replace(/[?.!,;]+$/g, '')
    .trim();
}

/**
 * Conditions after column mentions: "<column> <op> <value>" and Tanglish
 * "<column> <value> <op>" ("stock 20 ku keezha"). Ranges: "between A and B".
 */
export function parseConditions(text, columns, types = []) {
  const raw = String(text);
  const lowerRaw = raw.toLowerCase();
  const mentions = findColumnMentions(raw, columns);
  const conditions = [];
  const used = [];
  const norm = normalizedMessage(raw);
  // map normalized offsets back to raw text by searching the column words in raw (case-insensitive)
  for (const m of mentions) {
    const type = types[m.index];
    // tail after the column mention in the *normalized* message is enough for words;
    // numbers/dates are re-read from the raw text after the column name.
    const colWords = normText(m.column).split(' ');
    const rawPos = locate(lowerRaw, colWords, m);
    if (rawPos === null) continue;
    const tail = raw.slice(rawPos.end, rawPos.end + 90);
    const dates = parseDates(tail);
    // date ranges
    let r = tail.match(
      new RegExp(
        `^\\s*(?:is|are|was|=|:|from|between|on)?\\s*(?:between|from)?\\s*(${DATE_TOKEN})\\s*(?:to|and|till|until|-|–|varai|muthal)\\s*(${DATE_TOKEN})`,
        'i',
      ),
    );
    if (r) {
      conditions.push({ column: m.column, op: 'date_between', value: r[1], value2: r[2] });
      used.push(m.column);
      continue;
    }
    r = tail.match(
      new RegExp(
        `^\\s*(?:is|was|=|:)?\\s*(before|after|on|since|from|till|until|upto|up to)\\s+(${DATE_TOKEN})`,
        'i',
      ),
    );
    if (r) {
      const word = r[1].toLowerCase();
      const op = /before|till|until|upto|up to/.test(word)
        ? 'date_before'
        : word === 'on'
          ? 'date_on'
          : 'date_after';
      conditions.push({
        column: m.column,
        op,
        value: r[2],
        ...(/since|from|till|until|upto|up to/.test(word) ? { inclusive: true } : {}),
      });
      used.push(m.column);
      continue;
    }
    // numeric between
    r = tail.match(
      new RegExp(
        `^\\s*(?:is|are|=|:|values?)?\\s*(?:between|from)\\s+(${NUM})\\s*(?:and|to|-|–|&|varai)\\s*(${NUM})`,
        'i',
      ),
    );
    if (r) {
      conditions.push({ column: m.column, op: 'between', value: r[1], value2: r[2] });
      used.push(m.column);
      continue;
    }
    // "<op> <value>"
    let matched = false;
    for (const [op, re] of OPS) {
      const rr = tail.match(
        new RegExp(
          `^\\s*(?:is|are|was|value|values|should be)?\\s*(?:${re.source})\\s+(?:than\\s+|to\\s+)?(${DATE_TOKEN}|${NUM}|"[^"]+"|'[^']+'|[\\p{L}\\p{N}][\\p{L}\\p{N}&@.' -]{0,40})`,
          'iu',
        ),
      );
      if (!rr) continue;
      let value = cleanValue(rr[1]);
      if (!value) continue;
      if (
        op === 'eq' &&
        /^(?:the|a|an|this|that|which|what|in|by|for|and|or|wise|per)$/i.test(value.split(' ')[0])
      )
        continue;
      if (op === 'eq' && type === 'number' && !/^[-+(₹$\d]/.test(value)) continue;
      value = trimAtStopWords(value, columns);
      if (!value) continue;
      const dateLike = parseDates(value).length && ['gt', 'gte', 'lt', 'lte'].includes(op);
      conditions.push({
        column: m.column,
        op: dateLike ? (op.startsWith('g') ? 'date_after' : 'date_before') : op,
        value,
        ...(dateLike && op.endsWith('e') ? { inclusive: true } : {}),
      });
      used.push(m.column);
      matched = true;
      break;
    }
    if (matched) continue;
    // Tanglish: "<value> <op>" e.g. "stock 20 ku keezha", "price 500 ku mela"
    r = tail.match(
      new RegExp(
        `^\\s*(${NUM})\\s*(?:ku|kku|க்கு|than|vida|vida)?\\s*(mela|melae|adhigam(?:a)?|athigam(?:a)?|keezha|keezhe|kizha|kammi(?:ya)?|kuraiva|kuraivaa|kuraivu|or more|or less|and above|and below|above|below|மேல்|கீழ்|குறைவ)`,
        'iu',
      ),
    );
    if (r) {
      const word = r[2].toLowerCase();
      const op = /or more|and above/.test(word)
        ? 'gte'
        : /or less|and below/.test(word)
          ? 'lte'
          : /mela|melae|adhigam|athigam|above|மேல்/.test(word)
            ? 'gt'
            : 'lt';
      conditions.push({ column: m.column, op, value: r[1] });
      used.push(m.column);
      continue;
    }
    // "empty / blank" checks
    r = tail.match(/^\s*(?:is|are)?\s*(not empty|non[- ]?empty|filled|empty|blank|missing)\b/i);
    if (r) {
      conditions.push({
        column: m.column,
        op: /not|non|filled/i.test(r[1]) ? 'not_empty' : 'empty',
      });
      used.push(m.column);
    }
    void dates;
    void norm;
  }
  return conditions;
}

function trimAtStopWords(value, columns) {
  const stops =
    /\s+(?:and|or|sorted|sort|order|group|grouped|in excel|in pdf|in word|to excel|to pdf|as excel|as pdf|with|by|then|where|having|show|list|from sheet|in sheet|la|le|ah)\b[\s\S]*$/i;
  let v = value.replace(stops, '').trim();
  // A value must not swallow another column's name ("Chennai and stock below")
  for (const c of columns) {
    const i = v.toLowerCase().indexOf(` ${c.toLowerCase()}`);
    if (i > 0) v = v.slice(0, i).trim();
  }
  return cleanValue(v);
}

function locate(lowerRaw, colWords, mention) {
  const pattern = colWords
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s_\\-./()]*');
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${pattern}s?(?![\\p{L}\\p{N}])`, 'giu');
  const all = [...lowerRaw.matchAll(re)];
  if (!all.length) return null;
  // the n-th occurrence consistent with mention order
  const m = all.find((x) => x.index >= Math.max(0, mention.start - 20)) || all[0];
  return { start: m.index, end: m.index + m[0].length };
}

function pickTargetDocument(text, documents) {
  if (documents.length <= 1) return documents[0] || null;
  const lower = String(text).toLowerCase();
  const named = documents.filter((d) => {
    const base = d.name.toLowerCase();
    const stem = base.replace(/\.[^.]+$/, '');
    return lower.includes(base) || (stem.length >= 3 && lower.includes(stem));
  });
  return named.length === 1 ? named[0] : null;
}

function pickSheet(text, tables) {
  const m = String(text).match(
    /\bsheet\s*["'“]?([\p{L}\p{N} _-]{1,40}?)["'”]?(?:\s|$|,|\.|-la|la\b)/iu,
  );
  if (!m) return null;
  const want = normKey(m[1]);
  return (
    tables.find((t) => normKey(t.name) === want || normKey(t.name) === normKey(`sheet${m[1]}`)) ||
    null
  );
}

function sortSpec(text, columns) {
  const t = String(text);
  const mentions = findColumnMentions(t, columns);
  const m = t.match(
    /\b(?:sort(?:ed)?|order(?:ed)?|arrange[d]?|rank(?:ed)?)\s+(?:it\s+|them\s+|rows\s+)?(?:by|on|using)\s+([\p{L}\p{N} _-]{1,40}?)(?:\s+(asc(?:ending)?|desc(?:ending)?|high(?:est)? to low(?:est)?|low(?:est)? to high(?:est)?|a ?- ?z|z ?- ?a))?(?:$|[,.;]|\s+(?:and|then|in|to|as|with)\b)/iu,
  );
  let column = null;
  let direction = 'asc';
  if (m) {
    const inner = findColumnMentions(m[1], columns);
    column = inner[0]?.column || null;
    if (m[2]) direction = /desc|high(?:est)? to|z ?- ?a/i.test(m[2]) ? 'desc' : 'asc';
  }
  if (
    /\b(?:descending|desc|high(?:est)? to low|highest first|largest first|newest first|latest first|z ?- ?a)\b/i.test(
      t,
    )
  )
    direction = 'desc';
  const top = t.match(/\b(top|bottom|first|last)\s+(\d{1,4})\b/i);
  if (!column && top) {
    const by = t.match(/\b(?:by|on|in)\s+([\p{L}\p{N} _-]{1,40})/iu);
    column =
      (by && findColumnMentions(by[1], columns)[0]?.column) || mentions.at(-1)?.column || null;
    direction = /top|first/i.test(top[1]) ? 'desc' : 'asc';
  }
  if (!column) return null;
  return { sort: [{ column, direction }], limit: top ? Number(top[2]) : null };
}

function groupSpec(text, columns, types) {
  const t = String(text);
  let m = t.match(
    /\b(?:group(?:ed)?\s+by|by each|for each|per|break(?:down|[- ]?up)\s+by)\s+([\p{L}\p{N} _-]{1,40})/iu,
  );
  let column = m ? findColumnMentions(m[1], columns)[0]?.column : null;
  if (!column) {
    // "region wise", "region-wise total", "Region vaariyaga"
    m = t.match(/([\p{L}\p{N} _-]{1,40}?)[\s-]*(?:wise|vaariyaga|vaariyaa|வாரியாக)/iu);
    if (m) column = findColumnMentions(m[1], columns).at(-1)?.column || null;
  }
  if (!column) {
    // "total sales by region"
    m = t.match(
      /\b(?:sum|total|count|average|avg|mothama)\b[\s\S]{0,40}?\bby\s+([\p{L}\p{N} _-]{1,40})/iu,
    );
    if (m) column = findColumnMentions(m[1], columns)[0]?.column || null;
  }
  if (!column) return null;
  const idx = columns.indexOf(column);
  if (types[idx] === 'number') return null;
  return column;
}

function aggregateFn(text) {
  const explicit = String(text).match(EXPLICIT_IF);
  if (explicit) return explicit[1].toUpperCase();
  for (const [fn, re] of AGG) if (re.test(text)) return fn;
  return null;
}

const question = (text, options = []) => ({ action: 'clarify', question: text, options });

// ------------------------------------------------------------------ main

/**
 * @param {string} message
 * @param {{ documents: Array<{id,name,kind,tables:Array<{name,columns,types}>, pages?:number}> }} context
 * @returns {object|null} task, a clarification, or null when this is not a document task
 */
export function routeDocumentTask(message, context = {}) {
  const original = String(message || '').trim();
  const documents = context.documents || [];
  if (!original || !documents.length) return null;
  // File names ("policy.pdf") must not be read as format requests or IDs.
  const text = stripFileNames(original, documents);
  const output = requestedOutput(text);
  const language = TAMIL_OUT.test(text) ? 'ta' : 'en';
  const hint = sourceKindHint(text);
  const byKind = hint ? documents.filter((d) => d.kind === hint) : [];
  const target =
    pickTargetDocument(original, documents) || (byKind.length === 1 ? byKind[0] : null);
  const tabular = documents.filter((d) => d.tables?.length);
  const textual = documents.filter((d) => ['pdf', 'word', 'text', 'json'].includes(d.kind));

  // ---- comparisons (two or more documents) ----
  if (
    COMPARE.test(text) &&
    documents.length >= 2 &&
    !/\bcompare (?:with|against) (?:last|previous)\b/i.test(text)
  ) {
    return {
      action: 'compare',
      documents: documents.slice(0, 2).map((d) => d.id),
      output,
      language,
    };
  }

  // ---- conversions ----
  const convertTo = wantedFormat(text);
  const looksConvert =
    CONVERT.test(text) &&
    convertTo &&
    (/\b(?:to|into|as|aaga|aaka)\b|ஆக/i.test(text) || sourceFormatWord(text));
  const convertDocs = target ? [target] : documents;
  const EXT_OF = {
    xlsx: ['.xlsx', '.xlsm'],
    csv: ['.csv'],
    docx: ['.docx'],
    pdf: ['.pdf'],
    json: ['.json'],
    txt: ['.txt'],
    md: ['.md'],
    html: ['.html'],
  };
  const alreadyThatFormat =
    convertDocs.length &&
    convertDocs.every((d) =>
      (EXT_OF[convertTo] || []).includes(
        String(d.name)
          .toLowerCase()
          .match(/\.[^.]+$/)?.[0],
      ),
    );
  // "show rows where stock < 20 and export to Excel" is a result with an output file, not a file conversion.
  const selectsRows =
    (SHOW.test(text) || /\b(?:filter|sort|rows?|records?|entries)\b/i.test(text)) &&
    /\b(?:where|which|whose|with|below|above|under|over|less|more|greater|between|only|filter|sort(?:ed)?|top|bottom|mela|keezha|kammi)\b/i.test(
      text,
    );
  if (
    looksConvert &&
    !alreadyThatFormat &&
    !selectsRows &&
    !aggregateFn(text) &&
    !EDIT.test(text) &&
    !(SHOW.test(text) && parseIdRange(text)) &&
    !(GENERATE.test(text) && REPORT.test(text))
  ) {
    const docs = target ? [target] : documents;
    return { action: 'convert', documents: docs.map((d) => d.id), output: convertTo, language };
  }

  // ---- new reports / documents from the attached data ----
  if (GENERATE.test(text) && REPORT.test(text) && !EDIT.test(text)) {
    return {
      action: 'generate',
      output: output || wantedFormat(text) || 'docx',
      documents: (target ? [target] : documents).map((d) => d.id),
      monthly: MONTHLY.test(text),
      language,
    };
  }

  // ---- top / bottom N ----
  const topN = text.match(/\b(top|bottom|first|last)\s+(\d{1,4})\b/i);

  // ---- PDF page extraction ----
  const pages = parsePageRange(text);
  if (pages && textual.some((d) => d.kind === 'pdf')) {
    const doc = target?.kind === 'pdf' ? target : textual.find((d) => d.kind === 'pdf');
    const act = SUMMARY.test(text) ? 'summarize' : EXPLAIN.test(text) ? 'explain' : 'pages';
    return { action: act, documents: [doc.id], pages, output, language };
  }

  // ---- tabular work ----
  const tableDoc = target?.tables?.length ? target : tabular.length === 1 ? tabular[0] : null;
  const allTables = (tableDoc ? [tableDoc] : tabular).flatMap((d) =>
    d.tables.map((t) => ({ ...t, documentId: d.id, documentName: d.name })),
  );
  const sheet = pickSheet(text, allTables);

  const idRange = parseIdRange(text);
  if (idRange && allTables.length) {
    return {
      action: 'range',
      ids: idRange,
      documents: tableDoc ? [tableDoc.id] : tabular.map((d) => d.id),
      sheet: sheet?.name || null,
      output,
      language,
      ...extraFilters(text, allTables, sheet),
    };
  }

  const fn = topN ? null : aggregateFn(text);
  const isDup = DUPLICATE.test(text);
  if (
    allTables.length &&
    (fn ||
      isDup ||
      topN ||
      parseIdList(text)?.length >= 2 ||
      /\b(?:details?|info|record)\b/i.test(text) ||
      SORT.test(text) ||
      GROUP.test(text) ||
      SHOW.test(text) ||
      /\b(?:where|which|whose|rows? (?:with|where)|records? (?:with|where)|filter|only)\b/i.test(
        text,
      ) ||
      EDIT.test(text) ||
      MONTHLY.test(text))
  ) {
    // Choose the table: named sheet, else the one whose columns are mentioned, else the only one.
    let table = sheet;
    if (!table) {
      const scored = allTables
        .map((t) => ({ t, hits: findColumnMentions(text, t.columns).length }))
        .sort((a, b) => b.hits - a.hits);
      if (scored.length === 1 || (scored[0]?.hits && scored[0].hits > (scored[1]?.hits || 0)))
        table = scored[0].t;
      else if (
        scored.length > 1 &&
        scored[0].hits === 0 &&
        !(
          fn === 'COUNT' &&
          !findColumnMentions(text, allTables[0].columns).length &&
          allTables.length === 1
        )
      )
        return question(
          `Which sheet or table should I use? ${allTables.map((t) => `"${t.name}"${tabular.length > 1 ? ` (${t.documentName})` : ''}`).join(', ')}.`,
          allTables.map((t) => t.name),
        );
      else if (scored.length > 1 && scored[0].hits === scored[1].hits)
        return question(
          `Both ${scored
            .slice(0, 2)
            .map((s) => `"${s.t.name}"`)
            .join(' and ')} have those columns. Which one should I use?`,
          scored.map((s) => s.t.name),
        );
      else table = allTables[0];
    }
    const columns = table.columns;
    const types = table.types || [];
    const conditions = parseConditions(text, columns, types);
    const listIds = !conditions.length ? parseIdList(text) : null;
    const base = { documents: [table.documentId], sheet: table.name, output, language };

    // Edits to spreadsheets produce a new file (the original is never modified).
    if (
      EDIT.test(text) &&
      /\b(?:add|insert)\b/i.test(text) &&
      /\b(?:total|sum)\s+row\b|\btotals?\b/i.test(text) &&
      !fn?.endsWith('IF')
    ) {
      const col = findColumnMentions(text, columns)
        .filter((m) => types[m.index] === 'number')
        .map((m) => m.column);
      return { action: 'edit', edit: { kind: 'total_row', columns: col }, ...base };
    }
    const formulaCol = text.match(
      /\badd\s+(?:a\s+)?(?:new\s+)?column\s+["']?([\p{L}\p{N} _-]{1,40}?)["']?\s*(?:=|as|equal to|with)\s*([\p{L}\p{N} _-]+?)\s*([*x×+\-/÷])\s*([\p{L}\p{N} _-]+?)\s*(?:$|[,.;]|\s+(?:in|to|and)\b)/iu,
    );
    if (formulaCol) {
      const left = findColumnMentions(formulaCol[2], columns)[0]?.column;
      const right = findColumnMentions(formulaCol[4], columns)[0]?.column;
      if (!left || !right)
        return question(
          `Which columns should the new "${formulaCol[1].trim()}" column use? Available: ${columns.join(', ')}.`,
          columns,
        );
      const op = { x: '*', '×': '*', '÷': '/' }[formulaCol[3]] || formulaCol[3];
      return {
        action: 'edit',
        edit: { kind: 'formula_column', name: formulaCol[1].trim(), left, op, right },
        ...base,
      };
    }

    if (isDup) {
      const cols = findColumnMentions(text, columns).map((m) => m.column);
      return { action: 'duplicates', columns: cols, conditions, ...base };
    }

    if (fn) {
      const mentions = findColumnMentions(text, columns);
      const conditionCols = new Set(conditions.map((c) => c.column));
      const groupBy = groupSpec(text, columns, types);
      const monthly = MONTHLY.test(text);
      let measure = mentions
        .map((m) => m.column)
        .filter((c) => !conditionCols.has(c) && c !== groupBy);
      const numericMeasure = measure.filter(
        (c) => types[columns.indexOf(c)] === 'number' || types[columns.indexOf(c)] === 'mixed',
      );
      if (numericMeasure.length) measure = numericMeasure;
      let finalFn = fn;
      if (conditions.length && ['SUM', 'AVERAGE', 'COUNT'].includes(fn))
        finalFn = fn === 'SUM' ? 'SUMIF' : fn === 'AVERAGE' ? 'AVERAGEIF' : 'COUNTIF';
      const needsColumn =
        !['COUNTIF', 'COUNT'].includes(finalFn) || (finalFn === 'COUNT' && measure.length);
      if (finalFn === 'COUNT' && !measure.length)
        finalFn = conditions.length ? 'COUNTIF' : 'COUNTROWS';
      let column = measure[0] || null;
      const assumptions = [];
      if (!column && needsColumn && finalFn !== 'COUNTROWS') {
        const numeric = columns.filter((_, i) => types[i] === 'number');
        if (numeric.length === 1) {
          column = numeric[0];
          assumptions.push(`No column was named, so the only numeric column "${column}" was used.`);
        } else
          return question(
            numeric.length
              ? `Which column should I ${finalFn.replace(/IF$/, '').toLowerCase()}? Numeric columns: ${numeric.join(', ')}.`
              : `Which column should I use? Columns: ${columns.join(', ')}.`,
            numeric.length ? numeric : columns,
          );
      }
      if (measure.length > 1 && !groupBy)
        assumptions.push(
          `Several columns were mentioned; "${column}" was used for the calculation.`,
        );
      if (groupBy || monthly) {
        let monthColumn = null;
        if (monthly && !groupBy) {
          const dates = columns.filter((_, i) => types[i] === 'date');
          if (dates.length === 1) monthColumn = dates[0];
          else
            return question(
              `Which date column decides the month? ${dates.length ? dates.join(', ') : 'No date column was detected.'}`,
              dates,
            );
        }
        return {
          action: 'group',
          by: groupBy ? [groupBy] : [],
          monthColumn,
          aggregates: [
            {
              fn: finalFn.replace(/IF$/, '').replace('COUNTROWS', 'COUNTA'),
              column: finalFn === 'COUNTROWS' ? null : column,
            },
          ],
          conditions,
          assumptions,
          ...base,
          ...(sortSpec(text, columns) || {}),
        };
      }
      return { action: 'aggregate', fn: finalFn, column, conditions, assumptions, ...base };
    }

    const groupBy = GROUP.test(text) ? groupSpec(text, columns, types) : null;
    if (groupBy)
      return {
        action: 'group',
        by: [groupBy],
        aggregates: [{ fn: 'COUNTA', column: null }],
        conditions,
        ...base,
      };

    const sorting = SORT.test(text) ? sortSpec(text, columns) : null;
    if (listIds && listIds.length && !sorting)
      return { action: 'lookup', values: listIds, ...base };
    if (conditions.length || sorting)
      return { action: 'filter', conditions, ...(sorting || {}), ...base };
    // "show rows with Chennai" → search
    const quoted = text.match(/["“']([^"”']{2,60})["”']/);
    if (SEARCH.test(text) && quoted) return { action: 'search', query: quoted[1], ...base };
    if (/\bbetween two dates\b|\bdate range\b/i.test(text)) {
      const dates = columns.filter((_, i) => types[i] === 'date');
      return question(
        `Which dates? For example: "${dates[0] || 'Date'} between 01/01/2024 and 31/03/2024".`,
        dates,
      );
    }
    return null;
  }

  // ---- text documents ----
  const textDoc =
    target && ['pdf', 'word', 'text', 'json'].includes(target.kind)
      ? target
      : textual.length === 1
        ? textual[0]
        : null;
  if (SUMMARY.test(text) || EXPLAIN.test(text)) {
    const docs = target ? [target] : documents;
    return {
      action:
        SUMMARY.test(text) && !(EXPLAIN.test(text) && SECTIONWISE.test(text))
          ? 'summarize'
          : 'explain',
      documents: docs.map((d) => d.id),
      sectionWise: SECTIONWISE.test(text),
      output:
        output && GENERATE.test(text)
          ? output
          : output && /\b(?:as|in|to)\s+(?:a\s+)?(?:pdf|word|docx|excel)\b/i.test(text)
            ? output
            : null,
      language,
    };
  }
  if (SEARCH.test(text)) {
    const q =
      text.match(/["“']([^"”']{2,80})["”']/)?.[1] ||
      text.match(
        /\b(?:search(?: for)?|find|look for|occurrences? of|where is)\s+(?:the\s+)?(?:word\s+|phrase\s+|term\s+)?(.{2,60}?)(?:\s+(?:in|inside|within) (?:this|the|that)\b|[?.!]?$)/i,
      )?.[1];
    if (q && (textDoc || documents.length))
      return {
        action: 'search',
        query: q.trim(),
        documents: (textDoc ? [textDoc] : documents).map((d) => d.id),
        language,
      };
  }
  if (GENERATE.test(text) && (REPORT.test(text) || output)) {
    return {
      action: 'generate',
      output: output || 'docx',
      documents: documents.map((d) => d.id),
      monthly: MONTHLY.test(text),
      language,
    };
  }
  if (INSPECT.test(text))
    return { action: 'inspect', documents: (target ? [target] : documents).map((d) => d.id) };
  return null;
}

/** For ranges: extra filters ("P110 to P115 where stock below 20") and sorting. */
function extraFilters(text, tables, sheet) {
  const t = sheet || tables[0];
  if (!t) return {};
  const conditions = parseConditions(
    text.replace(new RegExp(`${ID_TOKEN}${RANGE_SEP}(?:${ID_TOKEN}|\\d+)`, 'i'), ' '),
    t.columns,
    t.types || [],
  ).filter((c) => c.op !== 'eq' || !/^[A-Za-z]{1,10}[-_/]?\d+$/.test(String(c.value)));
  return conditions.length ? { conditions } : {};
}

/** Context documents for the router from parsed documents. */
export function routerContext(parsedDocs, columnTypes) {
  return {
    documents: parsedDocs.map((d) => ({
      id: d.id,
      name: d.name,
      kind: d.kind,
      pages: d.pages?.length,
      tables: d.tables.map((t) => ({ name: t.name, columns: t.columns, types: columnTypes(t) })),
    })),
  };
}

/** Plain-language request is a "global" generate with no attachments (e.g. "create a leave letter in Word"). */
export function routeGenerateWithoutDocuments(message) {
  const text = String(message || '');
  if (!GENERATE.test(text)) return null;
  const output = wantedFormat(text);
  if (!output || !['docx', 'pdf', 'xlsx'].includes(output)) return null;
  if (
    !/\b(?:file|document|doc|report|letter|sheet|workbook|spreadsheet|pdf|word|excel|template|table)\b/i.test(
      text,
    )
  )
    return null;
  return {
    action: 'generate',
    output,
    documents: [],
    language: TAMIL_OUT.test(text) ? 'ta' : 'en',
  };
}
