// Cell-value helpers shared by the query planner and the question compiler.

export function toNumber(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value)
    .replace(/[₹$€£,%\s]/g, '')
    .replace(/^rs\.?/i, '');
  return /^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(cleaned) ? Number(cleaned) : null;
}

export function toDate(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  // Indian style: day first (dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy)
  m = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return Date.UTC(year, +m[2] - 1, +m[1]);
  }
  m = text.match(/^(\d{4})$/);
  if (m) return Date.UTC(+m[1], 0, 1);
  // Free-text dates only when a real month name is present ("12 Mar 2024"); V8 would also "parse" ids like ORD-5000.
  if (
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.test(text) &&
    /\d{4}/.test(text)
  ) {
    const parsed = Date.parse(text);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

export const normalizeName = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
