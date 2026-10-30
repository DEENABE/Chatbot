/** Text reconstruction from stored chunks and regex extractors (no model involved). */

/** Rebuild document text from overlapping index chunks; PDF page tags become headings. */
export function joinChunks(chunks) {
  let out = '';
  let lastPage = null;
  let previous = '';
  for (const raw of chunks) {
    let text = String(raw || '');
    const page = text.match(/^\[Page (\d+)\]\s*/);
    if (page) {
      text = text.slice(page[0].length);
      if (page[1] !== lastPage) {
        out += `${out ? '\n\n' : ''}--- Page ${page[1]} ---\n\n`;
        lastPage = page[1];
        previous = '';
      }
    }
    // chunkText() carries up to ~140 characters of the previous chunk forward.
    let overlap = 0;
    const max = Math.min(previous.length, text.length, 400);
    for (let n = max; n >= 20; n--) {
      if (previous.endsWith(text.slice(0, n))) {
        overlap = n;
        break;
      }
    }
    const piece = text.slice(overlap).replace(/^\s+/, overlap ? ' ' : '');
    out += out && !out.endsWith('\n') && !overlap ? `\n\n${piece}` : piece;
    previous = text;
  }
  return out.trim() + '\n';
}

const PATTERNS = {
  emails: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/gi,
  urls: /\bhttps?:\/\/[^\s<>"')\]]+|\bwww\.[^\s<>"')\]]+/gi,
  phones:
    /(?:\+?\d{1,3}[\s-]?)?(?:\(?\d{2,5}\)?[\s-]?)?\d{3,5}[\s-]?\d{3,5}\b|\b[6-9]\d{9}\b/g,
  dates:
    /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s+\d{4}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/gi,
  amounts:
    /(?:₹|rs\.?\s?|inr\s?|\$|usd\s?|€|£)\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:lakh|lakhs|crore|crores|cr|k|m|million|billion))?|\b\d[\d,]*(?:\.\d+)?\s?(?:rupees|lakh|lakhs|crore|crores|inr|usd|dollars)\b/gi,
};

const LABELS = {
  emails: 'Email',
  urls: 'URL',
  phones: 'Phone',
  dates: 'Date',
  amounts: 'Amount',
};

function validPhone(value) {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 13) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  // Skip things that are really dates or years glued together.
  if (/^\d{4}[-/.]\d{2}[-/.]\d{2}$/.test(value.trim())) return false;
  return true;
}

/**
 * @param {{name: string, text: string}[]} docs
 * @param {string[]} targets subset of emails|urls|phones|dates|amounts
 * @returns {{name, columns, rows}} one table: Type, Value, File, Context
 */
export function extractEntities(docs, targets) {
  const rows = [];
  const seen = new Set();
  for (const doc of docs) {
    for (const target of targets) {
      const re = PATTERNS[target];
      if (!re) continue;
      re.lastIndex = 0;
      for (const match of doc.text.matchAll(re)) {
        let value = match[0].trim().replace(/[.,;:]+$/, '');
        if (target === 'phones' && !validPhone(value)) continue;
        if (target === 'emails') value = value.toLowerCase();
        const key = `${target}|${value.toLowerCase()}|${doc.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const start = Math.max(0, match.index - 50);
        const context = doc.text
          .slice(start, match.index + match[0].length + 50)
          .replace(/\s+/g, ' ')
          .trim();
        rows.push([LABELS[target], value, doc.name, context]);
        if (rows.length >= 50_000) break;
      }
    }
  }
  return { name: 'Extracted', columns: ['Type', 'Value', 'File', 'Context'], rows };
}

export const ENTITY_TARGETS = Object.keys(PATTERNS);
