// Analytical questions over spreadsheets ("how many employees in Chennai?",
// "list people who joined after 2023", "company wise count", "average salary per
// department") cannot be answered from 5 retrieved chunks — the answer depends on
// ALL rows. So the question is turned into a small JSON plan that is executed over
// every row in plain JS (no SQL generation, nothing injectable), and the exact
// result is handed back.
//
// Who writes the plan (accuracy matters most here):
//   1. questionCompiler.js — rules + the table's real cell values. Deterministic,
//      instant, no model. Used when every word of the question is explained.
//   2. the local LLM — only for questions the rules cannot fully explain. Its plan
//      is then repaired against the real columns/values (repairPlan) before running.
import { config } from '../config.js';
import { fetchInference } from '../services/inferenceTransport.js';
import { toNumber, toDate, normalizeName } from './valueUtils.js';
import { compileQuestion, profileTable, repairPlan, normText } from './questionCompiler.js';

export { toNumber, toDate };

const ANALYTIC_PATTERN =
  /\b(how many|count|number of|total|sum|average|avg|mean|maximum|max|minimum|min|highest|lowest|largest|smallest|top \d+|bottom \d+|list (all|every|the|of)|all (the )?(employees|people|persons|rows|records|members|students|customers)|show all|who all|between|greater than|less than|more than|above|below|under|after|before|since|group|wise|each|per (company|city|department|location|category|status)|distinct|unique|sort|order by|oldest|newest|latest|earliest|which|who|ethana|ethanai|evlo|evalo|evvalavu|mothama|motham|saraasari|sambalam|ellarum|ellaarum|yaar yaar|list pannu|list kudu|list sollu|list|lists|listing|display|show|ellam|ellaa|ellaam|ellathaiyum|sollu|kaattu|kattu|kudu|mela|keela|kammi|athigam)\b|எத்தனை|மொத்த|பட்டியல்|சராசரி|சம்பளம்/i;

export function isAnalyticalQuestion(text) {
  return ANALYTIC_PATTERN.test(String(text || ''));
}

export function resolveColumn(columns, name) {
  if (name == null || name === '') return -1;
  const target = normalizeName(name);
  let index = columns.findIndex((c) => normalizeName(c) === target);
  if (index >= 0) return index;
  index = columns.findIndex(
    (c) => normalizeName(c).includes(target) || target.includes(normalizeName(c)),
  );
  return index;
}

function compare(cell, value) {
  const a = toNumber(cell);
  const b = toNumber(value);
  if (a != null && b != null) return a - b;
  const da = toDate(cell);
  const db = toDate(value);
  if (da != null && db != null) return da - db;
  return String(cell).localeCompare(String(value), undefined, { sensitivity: 'base' });
}

function matches(cell, op, value) {
  const text = String(cell ?? '');
  const lower = text.toLowerCase();
  const values = Array.isArray(value) ? value : [value];
  switch (op) {
    case 'equals':
    case 'eq':
      return values.some((v) => {
        if (
          lower.trim() ===
          String(v ?? '')
            .toLowerCase()
            .trim()
        )
          return true;
        const a = toNumber(text);
        const b = toNumber(v);
        return a != null && b != null && a === b;
      });
    case 'not_equals':
    case 'neq':
      return !matches(cell, 'equals', value);
    case 'contains':
      return values.some((v) => lower.includes(String(v ?? '').toLowerCase()));
    case 'not_contains':
      return !matches(cell, 'contains', value);
    case 'starts_with':
      return values.some((v) => lower.startsWith(String(v ?? '').toLowerCase()));
    case 'in':
      return values.some(
        (v) =>
          lower.trim() ===
          String(v ?? '')
            .toLowerCase()
            .trim(),
      );
    case 'gt':
      return text !== '' && compare(text, value) > 0;
    case 'gte':
      return text !== '' && compare(text, value) >= 0;
    case 'lt':
      return text !== '' && compare(text, value) < 0;
    case 'lte':
      return text !== '' && compare(text, value) <= 0;
    case 'between': {
      if (!Array.isArray(value) || value.length < 2 || text === '') return false;
      return compare(text, value[0]) >= 0 && compare(text, value[1]) <= 0;
    }
    case 'year': {
      const time = toDate(text);
      if (time != null) return new Date(time).getUTCFullYear() === Number(value);
      return text.includes(String(value));
    }
    case 'month': {
      // value: "2024-03" or 3
      const time = toDate(text);
      if (time == null) return false;
      const date = new Date(time);
      const v = String(value);
      const m = v.match(/^(\d{4})-(\d{1,2})$/);
      if (m) return date.getUTCFullYear() === +m[1] && date.getUTCMonth() + 1 === +m[2];
      return date.getUTCMonth() + 1 === Number(v);
    }
    case 'is_empty':
      return text.trim() === '';
    case 'not_empty':
      return text.trim() !== '';
    default:
      return lower.includes(String(value ?? '').toLowerCase());
  }
}

// ---------- plan execution ----------
const MAX_LIST_ROWS = 40;
const MAX_PROJECTED_ROWS = 200; // a one- or two-column list is narrow, so it can be much longer
const MAX_GROUPS = 100;

/** Indexes of columns that hold at least one value (hides blank spare columns). */
export function populatedColumns(columns, rows) {
  const keep = [];
  for (let i = 0; i < columns.length; i++) {
    if (rows.some((row) => String(row[i] ?? '') !== '')) keep.push(i);
  }
  return keep.length ? keep : columns.map((_, i) => i);
}

const OP_TEXT = {
  equals: '=',
  eq: '=',
  not_equals: '≠',
  neq: '≠',
  contains: 'contains',
  not_contains: 'does not contain',
  starts_with: 'starts with',
  in: 'is one of',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  between: 'between',
  year: 'year =',
  month: 'month =',
  is_empty: 'is empty',
  not_empty: 'is not empty',
};

/** 1234567.5 → "12,34,567.5" (Indian grouping; plain digits if Intl is unavailable). */
export function formatNumber(value) {
  if (value == null || !Number.isFinite(Number(value))) return String(value ?? '');
  try {
    return Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  } catch {
    return String(value);
  }
}

/** Human-readable filter for the answer shown to the user. */
function describeFilter(columnName, op, value) {
  const word = OP_TEXT[op] || op;
  if (op === 'is_empty' || op === 'not_empty') return `${columnName} ${word}`;
  const show = (v) => (typeof v === 'number' ? formatNumber(v) : String(v ?? ''));
  if (op === 'between' && Array.isArray(value))
    return `${columnName} between ${show(value[0])} and ${show(value[1])}`;
  const shown = Array.isArray(value) ? value.map(show).join(', ') : show(value);
  return `${columnName} ${word} ${shown}`;
}

function markdownTable(columns, rows) {
  const esc = (v) =>
    String(v ?? '')
      .replace(/\|/g, '/')
      .slice(0, 120);
  return [
    `| ${columns.map(esc).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`),
  ].join('\n');
}

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
const AGGREGATES = ['sum', 'avg', 'min', 'max'];
const AGG_LABEL = { sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX' };
// Lines of `info` that are shown to the user in bold as the headline answer.
const HEADLINE = /^(SUM|AVG|AVERAGE|MIN|MAX|Distinct|Highest|Lowest|Most|Fewest|Groups)/i;

function reduceNumbers(operation, numbers) {
  if (!numbers.length) return null;
  let value;
  if (operation === 'sum') value = numbers.reduce((a, b) => a + b, 0);
  else if (operation === 'avg') value = numbers.reduce((a, b) => a + b, 0) / numbers.length;
  else if (operation === 'min') value = Math.min(...numbers);
  else value = Math.max(...numbers);
  return Math.round(value * 100) / 100;
}

function sortRows(list, column, dir) {
  const sign = dir === -1 ? -1 : 1;
  list.sort((a, b) => {
    const x = a.row[column] ?? '';
    const y = b.row[column] ?? '';
    if (x === '' && y === '') return 0;
    if (x === '') return 1; // blanks always last
    if (y === '') return -1;
    return sign * compare(x, y);
  });
}

function editDistance(a, b, limit = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/** When nothing matched: how many rows each filter matches alone (+ "did you mean"). */
function explainEmptyResult(filters, columns, rows) {
  const lines = [];
  for (const filter of filters) {
    if (!filter || typeof filter !== 'object') continue;
    const op = String(filter.op || 'contains').toLowerCase();
    const column = resolveColumn(columns, filter.column);
    if (column < 0) continue;
    const alone = rows.filter((row) => matches(row[column], op, filter.value)).length;
    let line = `${describeFilter(columns[column], op, filter.value)} → ${alone} row${alone === 1 ? '' : 's'} on its own`;
    if (!alone && ['equals', 'in', 'contains'].includes(op) && typeof filter.value === 'string') {
      const wanted = normText(filter.value);
      const near = [...new Set(rows.map((r) => String(r[column] ?? '').trim()).filter(Boolean))]
        .map((v) => ({ v, d: editDistance(normText(v), wanted, 2) }))
        .filter((x) => x.d <= 2)
        .sort((a, b) => a.d - b.d)
        .slice(0, 3)
        .map((x) => x.v);
      if (near.length) line += ` (did you mean ${near.join(' / ')}?)`;
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Executes a validated plan over a table's rows.
 * @returns {{ text: string, answer: string, matched: number, value?: number }}
 */
export function executePlan(plan, table, rows) {
  const { columns } = table;
  const filters = Array.isArray(plan.filters) ? plan.filters.slice(0, 8) : [];
  const described = [];
  const describedForUser = [];
  let result = rows.map((row, index) => ({ row, index }));

  for (const filter of filters) {
    if (!filter || typeof filter !== 'object') continue;
    const op = String(filter.op || 'contains').toLowerCase();
    const column = resolveColumn(columns, filter.column);
    if (column >= 0) {
      result = result.filter(({ row }) => matches(row[column], op, filter.value));
      described.push(`${columns[column]} ${op} ${JSON.stringify(filter.value ?? '')}`);
      describedForUser.push(describeFilter(columns[column], op, filter.value));
    } else if (filter.value != null && filter.value !== '') {
      // Unknown column → search the value anywhere in the row.
      result = result.filter(({ row }) =>
        row.some((cell) => matches(cell, 'contains', filter.value)),
      );
      described.push(`any column contains ${JSON.stringify(filter.value)}`);
      describedForUser.push(
        `any column contains ${Array.isArray(filter.value) ? filter.value.join(', ') : filter.value}`,
      );
    }
  }

  let operation = String(plan.operation || 'list')
    .toLowerCase()
    .trim();
  operation = OPERATION_ALIASES[operation] || operation;
  const target = resolveColumn(columns, plan.column);
  const groupColumn = resolveColumn(columns, plan.groupBy);
  const rank = plan.rank === 'bottom' || plan.rank === 'top' ? plan.rank : null;
  // group a date column by year or month ("year wise joining count")
  const period = plan.period === 'year' || plan.period === 'month' ? plan.period : null;
  const groupKeyOf = (row, col) => {
    const raw = String(row[col] ?? '').trim();
    if (!raw) return '(blank)';
    if (!period) return raw;
    const time = toDate(raw);
    if (time == null) return raw;
    const d = new Date(time);
    return period === 'year'
      ? String(d.getUTCFullYear())
      : `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };
  // `info` = short facts, `blocks` = tables / notes. `text` is the context
  // sent to the LLM; `answer` is the same result formatted to show the user
  // directly (so big lists never wait on the model to retype them).
  const info = [
    `Filters: ${described.length ? described.join(' AND ') : 'none'}`,
    `Matching rows: ${result.length}`,
  ];
  const blocks = [];
  if (!result.length && filters.length) {
    const hints = explainEmptyResult(filters, columns, rows);
    if (hints.length)
      blocks.push(`No row matches all the filters.\n${hints.map((h) => `- ${h}`).join('\n')}`);
  }
  let headline = null; // replaces "N matching rows" when the answer is a top-N list
  const finish = (extra = {}) => ({
    text: [
      `COMPUTED RESULT — exact, calculated by the app over all ${rows.length} rows of "${table.filename}" › sheet "${table.sheet}".`,
      ...info,
      ...blocks,
    ].join('\n'),
    answer: [
      `**${table.filename} › ${table.sheet}**`,
      [
        describedForUser.length ? `Filter: ${describedForUser.join(' AND ')}` : '',
        info.some((line) => line.startsWith('COUNT ='))
          ? `**${info.find((line) => line.startsWith('COUNT ='))}** out of ${rows.length} rows`
          : headline ||
            (info.some((line) => HEADLINE.test(line)) && !filters.length
              ? ''
              : `**${formatNumber(result.length)} matching row${result.length === 1 ? '' : 's'}** out of ${formatNumber(rows.length)}`),
        ...info.filter((line) => HEADLINE.test(line)).map((line) => `**${line}**`),
      ]
        .filter(Boolean)
        .join('  \n'),
      ...blocks,
    ].join('\n\n'),
    matched: result.length,
    indexes: result.map((r) => r.index),
    ...extra,
  });

  // sum / avg / min / max PER GROUP ("average salary per company")
  if (AGGREGATES.includes(operation) && target >= 0 && groupColumn >= 0) {
    const groups = new Map();
    for (const { row } of result) {
      const key = groupKeyOf(row, groupColumn);
      const group = groups.get(key) || { rows: 0, numbers: [] };
      group.rows++;
      const n = toNumber(row[target]);
      if (n != null) group.numbers.push(n);
      groups.set(key, group);
    }
    const list = [...groups]
      .map(([key, g]) => ({
        key,
        rows: g.rows,
        count: g.numbers.length,
        value: reduceNumbers(operation, g.numbers),
      }))
      .filter((g) => g.value != null);
    const ascending = rank === 'bottom' || String(plan.sortDir || '').toLowerCase() === 'asc';
    if (period && !rank) list.sort((a, b) => a.key.localeCompare(b.key));
    else
      list.sort(
        (a, b) => (ascending ? a.value - b.value : b.value - a.value) || a.key.localeCompare(b.key),
      );
    const label = `${AGG_LABEL[operation]} of "${columns[target]}"`;
    info.push(
      `${label} per "${columns[groupColumn]}" — ${list.length} group${list.length === 1 ? '' : 's'}`,
    );
    if (list.length && rank) {
      const best = list[0];
      const tied = list.filter((g) => g.value === best.value);
      info.push(
        `${rank === 'bottom' ? 'Lowest' : 'Highest'} ${AGG_LABEL[operation]} of "${columns[target]}": ${tied.map((g) => g.key).join(', ')} (${formatNumber(best.value)})`,
      );
    }
    const limit = Number(plan.limit) > 0 ? Math.floor(Number(plan.limit)) : MAX_GROUPS;
    blocks.push(
      markdownTable(
        [columns[groupColumn], 'Rows', label],
        list
          .slice(0, Math.min(limit, MAX_GROUPS))
          .map((g) => [g.key, formatNumber(g.rows), formatNumber(g.value)]),
      ),
    );
    if (list.length > Math.min(limit, MAX_GROUPS))
      blocks.push(`(${list.length - Math.min(limit, MAX_GROUPS)} more groups not shown)`);
    return finish({ value: list[0]?.value ?? null, groups: list });
  }

  if (AGGREGATES.includes(operation) && target >= 0) {
    const numbers = result.map(({ row }) => toNumber(row[target])).filter((n) => n != null);
    const value = reduceNumbers(operation, numbers);
    info.push(
      `${AGG_LABEL[operation]} of "${columns[target]}" = ${value == null ? 'n/a (no numeric values)' : formatNumber(value)} (from ${formatNumber(numbers.length)} numeric values)`,
    );
    if ((operation === 'sum' || operation === 'avg') && result.length > 0 && result.length <= 12) {
      blocks.push('Rows used in the calculation:');
      const cols = populatedColumns(
        columns,
        result.map((r) => r.row),
      );
      blocks.push(
        markdownTable(
          cols.map((i) => columns[i]),
          result.map((r) => cols.map((i) => r.row[i])),
        ),
      );
    }
    if (operation === 'min' || operation === 'max') {
      const best = result.filter(({ row }) => toNumber(row[target]) === value).slice(0, 5);
      if (best.length) {
        blocks.push('Row(s) with that value:');
        const cols = populatedColumns(
          columns,
          best.map((b) => b.row),
        );
        blocks.push(
          markdownTable(
            cols.map((i) => columns[i]),
            best.map((b) => cols.map((i) => b.row[i])),
          ),
        );
      }
    }
    return finish({ value });
  }

  if (operation === 'distinct_count') {
    const col = groupColumn >= 0 ? groupColumn : target;
    if (col >= 0) {
      const counts = new Map();
      for (const { row } of result) {
        const key = String(row[col] ?? '').trim();
        if (key) counts.set(key, (counts.get(key) || 0) + 1);
      }
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      info.push(`Distinct "${columns[col]}" values: ${sorted.length}`);
      blocks.push(
        markdownTable(
          [columns[col], 'Rows'],
          sorted.slice(0, MAX_GROUPS).map(([k, v]) => [k, formatNumber(v)]),
        ),
      );
      if (sorted.length > MAX_GROUPS)
        blocks.push(`(${sorted.length - MAX_GROUPS} more values not shown)`);
      return finish({ value: sorted.length });
    }
  }

  if (['group_count', 'group', 'distinct'].includes(operation)) {
    const groupBy = groupColumn >= 0 ? groupColumn : resolveColumn(columns, plan.column);
    if (groupBy >= 0) {
      const counts = new Map();
      for (const { row } of result) {
        const key = groupKeyOf(row, groupBy);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const ascending = rank === 'bottom' || String(plan.sortDir || '').toLowerCase() === 'asc';
      const sorted = [...counts.entries()].sort((a, b) =>
        period && !rank
          ? a[0].localeCompare(b[0])
          : (ascending ? a[1] - b[1] : b[1] - a[1]) || a[0].localeCompare(b[0]),
      );
      info.push(`Distinct "${columns[groupBy]}" values: ${sorted.length}`);
      if (sorted.length && rank) {
        const tied = sorted.filter(([, n]) => n === sorted[0][1]);
        info.push(
          `${rank === 'bottom' ? 'Fewest' : 'Most'} rows: ${tied.map(([k]) => k).join(', ')} (${formatNumber(sorted[0][1])}${tied.length > 1 ? ' each' : ''})`,
        );
      }
      const limit = Number(plan.limit) > 0 ? Math.floor(Number(plan.limit)) : MAX_GROUPS;
      const shownGroups = sorted.slice(0, Math.min(limit, MAX_GROUPS));
      blocks.push(
        markdownTable(
          [columns[groupBy], 'Count'],
          shownGroups.map(([k, v]) => [k, formatNumber(v)]),
        ),
      );
      if (sorted.length > shownGroups.length)
        blocks.push(`(${sorted.length - shownGroups.length} more groups not shown)`);
      return finish({ groups: sorted });
    }
  }

  if (operation === 'count') info.push(`COUNT = ${formatNumber(result.length)}`);

  // list (also shown for count, so the model can name a few)
  const sortColumn = resolveColumn(columns, plan.sortBy);
  if (sortColumn >= 0)
    sortRows(
      result,
      sortColumn,
      String(plan.sortDir || 'asc')
        .toLowerCase()
        .startsWith('d')
        ? -1
        : 1,
    );
  // "show only id" → just those columns of every matching row
  const projected =
    operation === 'list' && Array.isArray(plan.columns)
      ? [...new Set(plan.columns.map((name) => resolveColumn(columns, name)).filter((i) => i >= 0))]
      : [];
  const rowCap = projected.length ? MAX_PROJECTED_ROWS : MAX_LIST_ROWS;
  const requested = Number(plan.limit) > 0 ? Math.floor(Number(plan.limit)) : rowCap;
  const shown = result.slice(0, Math.min(requested, operation === 'count' ? 15 : rowCap));
  if (projected.length && !headline)
    headline = `**${projected.map((i) => columns[i]).join(', ')}** · ${formatNumber(result.length)} row${result.length === 1 ? '' : 's'}${filters.length ? ` of ${formatNumber(rows.length)}` : ''}`;
  if (sortColumn >= 0 && Number(plan.limit) > 0 && operation !== 'count' && shown.length) {
    const descending = String(plan.sortDir || 'asc')
      .toLowerCase()
      .startsWith('d');
    const isDate =
      toDate(shown[0].row[sortColumn]) != null && toNumber(shown[0].row[sortColumn]) == null;
    const order = isDate
      ? descending
        ? 'latest first'
        : 'oldest first'
      : descending
        ? 'highest first'
        : 'lowest first';
    headline = `**Top ${shown.length} by ${columns[sortColumn]} (${order})** · ${formatNumber(result.length)} row${result.length === 1 ? '' : 's'} considered of ${formatNumber(rows.length)}`;
  }
  if (shown.length) {
    // Keep the table readable: at most 10 columns, always including used ones.
    let keep = projected.length ? projected : populatedColumns(columns, rows);
    if (!projected.length && keep.length > 10) {
      const used = new Set(
        [...filters.map((f) => resolveColumn(columns, f?.column)), sortColumn, target].filter(
          (i) => i >= 0,
        ),
      );
      keep = [...new Set([...keep.slice(0, 10 - Math.min(used.size, 5)), ...used])]
        .sort((a, b) => a - b)
        .slice(0, 12);
    }
    blocks.push(
      markdownTable(
        ['#', ...keep.map((i) => columns[i])],
        shown.map(({ row, index }) => [index + 1, ...keep.map((i) => row[i])]),
      ),
    );
    if (result.length > shown.length)
      blocks.push(
        sortColumn >= 0 && Number(plan.limit) > 0
          ? `Showing the ${sortColumn >= 0 && plan.sortDir === 'desc' ? 'top' : 'first'} ${shown.length} of ${formatNumber(result.length)} matching rows.`
          : `Showing the first ${shown.length} of ${formatNumber(result.length)} matching rows — ask for a narrower filter to see the rest.`,
      );
  }
  return finish();
}

// ---------- LLM planning (only when the rules cannot explain the question) ----------
const SCHEMA_CHARS = 6500;

function schemaFor(candidates, profiles, maxValues) {
  return candidates.map(({ table }, i) => ({
    id: `T${i + 1}`,
    file: table.filename,
    sheet: table.sheet,
    rows: profiles[i].rowCount,
    columns: profiles[i].columns.slice(0, 40).map((col) => {
      const entry = { name: col.name, type: col.type };
      if (col.type === 'number' && col.min != null) entry.range = [col.min, col.max];
      else if (col.type === 'date' && col.dmin != null) {
        entry.range = [
          new Date(col.dmin).toISOString().slice(0, 10),
          new Date(col.dmax).toISOString().slice(0, 10),
        ];
      } else if (col.role === 'category' && maxValues > 0) {
        // Every distinct value (with spelling!) so the model never invents "Chenai".
        entry.values = [...col.counts.keys()].slice(0, maxValues).map((v) => v.slice(0, 28));
        if (col.distinct > maxValues) entry.distinct = col.distinct;
      } else {
        entry.examples = (col.examples || []).slice(0, 3).map((v) => v.slice(0, 28));
      }
      return entry;
    }),
  }));
}

function buildSchema(candidates, profiles) {
  for (const maxValues of [40, 20, 10, 5, 0]) {
    const schema = schemaFor(candidates, profiles, maxValues);
    const json = JSON.stringify(schema);
    if (json.length <= SCHEMA_CHARS || maxValues === 0) return json;
  }
  return '[]';
}

const PLAN_INSTRUCTIONS = `You convert a user's question about spreadsheet data into ONE JSON query plan.
Return ONLY JSON with this shape:
{"table":"T1","filters":[{"column":"<exact column name>","op":"<op>","value":<value>}],"operation":"<operation>","column":"<column for sum/avg/min/max>","groupBy":"<column to group by>","sortBy":"<column or null>","sortDir":"asc|desc","limit":<number or null>,"rank":"top|bottom|null"}
ops: equals, not_equals, contains, in (value = array), gt, gte, lt, lte, between (value = [low, high]), year (value = 2023), month (value = "2024-03"), is_empty, not_empty
operations: list, count, sum, avg, min, max, group_count, distinct_count
Rules:
- Copy column names and category values EXACTLY as written in the schema (same spelling). Never invent a value.
- Put every condition of the question in "filters": each place, company, status, number limit and date limit is its own filter.
- Text/category values => "equals". Names typed partially => "contains". Dates as "YYYY-MM-DD". "after 2021" => gt "2021-12-31"; "in 2021" => year 2021.
- "how many / ethana / evlo" => count (keep the filters). "how many different X" => distinct_count with column X.
- "total / sum / mothama" => sum, "average / mean / saraasari" => avg, "highest / maximum" => max, "lowest / minimum" => min, each with "column" = the numeric column.
- "X wise / per X / each X / by X": set "groupBy" = X. With count use group_count; with sum/avg/min/max keep that operation plus "column".
- "which X has the most / least / highest average ...": groupBy = X, rank "top" (or "bottom"); use group_count for most rows, or avg/sum + column for amounts.
- "top N / highest N / latest N": operation list, sortBy + sortDir "desc" + limit N ("oldest / lowest N" => "asc").
- "list the cities / unique companies" with no other filter => group_count with groupBy = that column.
- The question may be in English, Tamil or Tanglish (sambalam = salary, ooru = city, ethana = how many, mela = above, keela = below).
- If no table can answer, return {"table":null}.
Examples:
Q: how many people are in Chennai => {"table":"T1","filters":[{"column":"City","op":"equals","value":"Chennai"}],"operation":"count"}
Q: average salary per department => {"table":"T1","filters":[],"operation":"avg","column":"Salary","groupBy":"Department"}
Q: Chennai la 2021 ku aprm join aanavanga => {"table":"T1","filters":[{"column":"City","op":"equals","value":"Chennai"},{"column":"Joining Date","op":"gt","value":"2021-12-31"}],"operation":"list"}
Q: top 5 highest salary => {"table":"T1","filters":[],"operation":"list","sortBy":"Salary","sortDir":"desc","limit":5}
Q: which company has the most employees => {"table":"T1","filters":[],"operation":"group_count","groupBy":"Company","rank":"top"}`;

async function ollamaJson({ model, system, user, signal, numCtx, keepAlive }) {
  // CPU-only laptops need more than 45s for a cold 9B model; a slow plan is
  // still far better than falling back to the LLM retyping a whole sheet.
  const seconds = Number(process.env.DOCQA_PLANNER_TIMEOUT_SECONDS || 90);
  const timeout = AbortSignal.timeout(seconds * 1000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const request = (withThinkOff) =>
    fetchInference(`${config.ollamaUrl}/api/chat`, {
      redirect: 'error',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: combined,
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        // Qwen3 "thinking" would generate hundreds of hidden tokens first —
        // minutes on CPU — for a task that only needs a 60-token JSON plan.
        ...(withThinkOff ? { think: false } : {}),
        // Match the chat call's num_ctx/keep_alive when given: a different num_ctx makes Ollama reload the model.
        keep_alive: keepAlive || config.ollamaKeepAlive,
        options: { temperature: 0, num_ctx: numCtx || 4096, num_predict: 512 },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
  // Every thinking model (Qwen3, Gemma 4, DeepSeek-R1, ...) otherwise spends the whole num_predict budget on hidden
  // reasoning and returns an empty message. Models without a thinking mode reject `think` with 400: retry without it.
  let response = await request(true);
  if (!response.ok && response.status === 400) response = await request(false);
  if (!response.ok) throw new Error(`Ollama ${response.status}`);
  const data = await response.json();
  const content = String(data?.message?.content || '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim();
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start)
    throw new Error(content ? 'planner reply was not JSON' : 'planner reply was empty');
  return JSON.parse(content.slice(start, end + 1));
}

function hintsFor(compiled) {
  const lines = [];
  if (compiled?.grounded?.length) {
    lines.push(
      `Values found in the question (exact cell values): ${compiled.grounded
        .map((g) => `${g.column} = ${g.values.join(' / ')}`)
        .join('; ')}`,
    );
  }
  const asked = [];
  const c = compiled?.cues || {};
  if (c.count) asked.push('count');
  if (c.sum) asked.push('sum');
  if (c.avg) asked.push('average');
  if (c.max) asked.push('highest');
  if (c.min) asked.push('lowest');
  if (asked.length) lines.push(`The question wording suggests: ${asked.join(', ')}`);
  return lines.length ? `\n\nDETECTED:\n${lines.join('\n')}` : '';
}

// Profiling a sheet (distinct values per column…) is the costly part of the rules; keep recent ones.
const PROFILE_CACHE = new Map();
function cachedProfile(table, rows) {
  const key = `${table.id}:${rows.length}:${table.columns.join('|')}`;
  if (PROFILE_CACHE.has(key)) {
    const hit = PROFILE_CACHE.get(key);
    PROFILE_CACHE.delete(key);
    PROFILE_CACHE.set(key, hit); // most recently used last
    return hit;
  }
  const profile = profileTable(table, rows);
  if (rows.length <= 400_000) {
    PROFILE_CACHE.set(key, profile);
    while (PROFILE_CACHE.size > 16) PROFILE_CACHE.delete(PROFILE_CACHE.keys().next().value);
  }
  return profile;
}

/**
 * Plans + executes a question over the attached spreadsheets.
 * @param {{question:string, tables:Array<{id,filename,sheet,columns,rowCount}>, loadRows:(id)=>string[][], model:string, signal?:AbortSignal, numCtx?:number, keepAlive?:string, useModel?:boolean}} args
 * @returns {Promise<null | {table, text, answer, plan, source: "rules"|"llm"|"rules-fallback", changes?: string[]}>}
 */
export async function answerWithPlanner({
  question,
  tables,
  loadRows,
  model,
  signal,
  numCtx,
  keepAlive,
  useModel = true,
  now,
}) {
  if (!tables.length) return null;
  const candidates = tables.slice(0, 8).map((table) => ({ table }));
  for (const candidate of candidates) {
    candidate.rows = loadRows(candidate.table.id);
    candidate.profile = cachedProfile(candidate.table, candidate.rows);
  }

  // 1) rules: the question compiled against the real cell values
  let compiled = null;
  try {
    compiled = compileQuestion(question, candidates, { now });
  } catch (error) {
    console.error('[docqa] question compiler failed:', error.message);
  }
  const run = (plan, tableIndex) => {
    const { table, rows } = candidates[tableIndex];
    return { table, ...executePlan(plan, table, rows) };
  };

  if (compiled?.kind === 'lookup' && !isAnalyticalQuestion(question)) return null; // "Ravi details" → row lookup
  if (compiled?.kind === 'analytic' && compiled.confident) {
    const done = run(compiled.plan, compiled.tableIndex ?? 0);
    return { ...done, plan: compiled.plan, source: 'rules', changes: [] };
  }

  // 2) the model, only when the rules are unsure and the question looks analytical
  if (!useModel || !(isAnalyticalQuestion(question) || compiled?.kind === 'analytic')) return null;
  // A word the rules could not place that is written with a capital letter is probably a name that
  // is missing from the data ("Rajesh Subramanian"): never answer around it.
  const capitalised = (word) =>
    new RegExp(`(^|[^\\p{L}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'iu').test(
      question,
    ) &&
    [...String(question).matchAll(/\p{Lu}[\p{L}\p{N}]+/gu)].some(
      (m) => m[0].toLowerCase() === word,
    );
  const usableFallback =
    compiled?.kind === 'analytic' &&
    compiled.plan?.filters?.length > 0 &&
    (compiled.unexplained?.length ?? 9) <= 1 &&
    !(compiled.unexplained || []).some(capitalised);
  try {
    const profiles = candidates.map((c) => c.profile);
    const rawPlan = await ollamaJson({
      model,
      signal,
      numCtx,
      keepAlive,
      system: PLAN_INSTRUCTIONS,
      user: `SCHEMA:\n${buildSchema(candidates, profiles)}\n\nQUESTION: ${question}${hintsFor(compiled)}\n\nJSON plan:`,
    });
    if (!rawPlan || !rawPlan.table) {
      if (usableFallback) {
        const done = run(compiled.plan, compiled.tableIndex ?? 0);
        return {
          ...done,
          plan: compiled.plan,
          source: 'rules-fallback',
          changes: ['model gave no plan'],
        };
      }
      return null;
    }
    let index = candidates.length === 1 ? 0 : Number(String(rawPlan.table).replace(/\D/g, '')) - 1;
    if (!(index >= 0 && index < candidates.length)) index = compiled?.tableIndex ?? 0;
    // A table that actually contains the values named in the question beats the model's guess.
    if (
      candidates.length > 1 &&
      compiled?.grounded?.length &&
      compiled.tableIndex != null &&
      !compiled.tie
    )
      index = compiled.tableIndex;
    const { plan, changes } = repairPlan(rawPlan, profiles[index], question, {
      compiled: compiled?.tableIndex === index ? compiled : null,
    });
    const done = run(plan, index);
    return { ...done, plan, source: 'llm', changes };
  } catch (error) {
    if (signal?.aborted) throw error;
    console.error('[docqa] model planner failed:', error.message);
    if (usableFallback) {
      const done = run(compiled.plan, compiled.tableIndex ?? 0);
      return {
        ...done,
        plan: compiled.plan,
        source: 'rules-fallback',
        changes: [`model failed: ${error.message}`],
      };
    }
    return null;
  }
}
