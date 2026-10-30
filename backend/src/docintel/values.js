/**
 * Strict value interpretation for exact operations. Nothing here guesses:
 * a cell is a number, a date, blank, or invalid — and callers report each
 * category separately instead of silently treating bad cells as zero.
 */

export const isBlank = (v) =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

const CURRENCY = /(?:₹|rs\.?|inr|\$|€|£|usd|eur|gbp)/gi;

/** Number or null. Accepts 1,23,456.50 / (1,200) / ₹500 / 12% (=0.12) / -3.5e2. */
export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean' || v instanceof Date || v === null || v === undefined) return null;
  let s = String(v).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(CURRENCY, '').replace(/[\s,]/g, '');
  if (/^-.+/.test(s) && negative) return null;
  let percent = false;
  if (s.endsWith('%')) {
    percent = true;
    s = s.slice(0, -1);
  }
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(s)) return null;
  let n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (percent) n /= 100;
  return negative ? -n : n;
}

/** { kind: 'number', value } | { kind: 'blank' } | { kind: 'invalid', raw } */
export function classifyNumeric(v) {
  if (isBlank(v)) return { kind: 'blank' };
  const n = toNumber(v);
  return n === null ? { kind: 'invalid', raw: v } : { kind: 'number', value: n };
}

const MONTHS = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

const validDate = (y, m, d) => {
  if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const t = Date.UTC(y, m - 1, d);
  const check = new Date(t);
  return check.getUTCMonth() === m - 1 && check.getUTCDate() === d ? t : null;
};

/**
 * Epoch milliseconds (UTC midnight for date-only values) or null.
 * Numeric day-first order (dd/mm/yyyy) is the default, as used in India;
 * a first part above 12 or a second part above 12 settles the order.
 */
export function toDate(v, { dayFirst = true } = {}) {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const base = validDate(+m[1], +m[2], +m[3]);
    if (base === null) return null;
    return m[4] ? base + ((+m[4] * 60 + +m[5]) * 60 + +(m[6] || 0)) * 1000 : base;
  }
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    let a = +m[1];
    let b = +m[2];
    let y = +m[3];
    if (y < 100) y += 2000;
    let day = dayFirst ? a : b;
    let month = dayFirst ? b : a;
    if (a > 12 && b <= 12) [day, month] = [a, b];
    else if (b > 12 && a <= 12) [day, month] = [b, a];
    return validDate(y, month, day);
  }
  m = s.match(/^(\d{1,2})[\s-]+([a-z]{3,9})[\s,-]+(\d{2,4})$/i); // 05-Mar-2024, 5 March 2024
  if (m && MONTHS[m[2].toLowerCase()]) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return validDate(y, MONTHS[m[2].toLowerCase()], +m[1]);
  }
  m = s.match(/^([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/i); // Mar 5, 2024
  if (m && MONTHS[m[1].toLowerCase()]) return validDate(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  return null;
}

export const isoDate = (t) =>
  t === null || t === undefined ? '' : new Date(t).toISOString().slice(0, 10);

/** Display value for tables and documents. */
export function display(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    if (!Number.isFinite(v.getTime())) return '';
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
  }
  if (typeof v === 'number')
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e9) / 1e9);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

/** Exact decimal-safe sum: adds scaled integers when every value has ≤ 9 decimals. */
export function exactSum(numbers) {
  let scale = 0;
  for (const n of numbers) {
    const text = String(n);
    if (/e/i.test(text)) return numbers.reduce((s, x) => s + x, 0);
    const decimals = (text.split('.')[1] || '').length;
    if (decimals > scale) scale = decimals;
    if (scale > 9) return numbers.reduce((s, x) => s + x, 0);
  }
  const factor = 10 ** scale;
  let total = 0n;
  for (const n of numbers) total += BigInt(Math.round(n * factor));
  return Number(total) / factor;
}

export const normKey = (v) =>
  String(v ?? '')
    .toLowerCase()
    .replace(/[\s_\-./()]+/g, '');

/** Splits an ID like "P110" / "EMP-0042" / "INV/2024/007" into prefix, number and width. */
export function splitId(value) {
  const m = String(value ?? '')
    .trim()
    .match(/^(.*?)(\d+)$/);
  if (!m) return null;
  return { prefix: m[1], number: Number(m[2]), width: m[2].length, text: String(value).trim() };
}
