/**
 * Decides whether a chat message is a file-agent job. Deterministic on purpose:
 * ordinary questions about attachments ("what is the Q3 total?") stay with the
 * existing docqa pipeline; only action requests (summarize, convert, extract,
 * clean/merge tables, organize/rename a folder) are handled here.
 */

const FORMATS = [
  ['pdf', /\bpdf\b/i],
  ['docx', /\b(?:ms[ -]?word|word(?: file| document| doc)?|docx)\b|வேர்ட்/i],
  ['xlsx', /\b(?:excel|xlsx|spreadsheet|workbook)\b|எக்செல்/i],
  ['csv', /\bcsv\b/i],
  ['md', /\b(?:markdown|md)\b/i],
  ['txt', /\b(?:text|txt|plain text|notepad)\b|உரை/i],
  ['json', /\bjson\b/i],
];

const SUMMARY =
  /\b(?:summar(?:y|ies|ise|ize|ised|ized)|key points|main points|overview|tl;?dr|gist|highlights|brief me)\b|சுருக்க|முக்கிய (?:அம்சங்கள்|குறிப்புகள்)/i;
const CONVERT =
  /\b(?:convert|export|save|turn|change|download)\b[\s\S]{0,60}\b(?:to|as|into|in)\b[\s\S]{0,20}\b(?:excel|xlsx|csv|markdown|md|text|txt|json|spreadsheet|pdf|word|docx)\b|(?:pdf|word|excel|csv|text|markdown)\s*(?:ஆக|ஆ|-ஆ)?\s*மாற்று|மாற்றி/i;
const REPORT =
  /\b(?:create|make|generate|prepare|build|write|produce|give me|export)\b[\s\S]{0,60}\b(?:report|document|pdf|word|docx|excel|xlsx|spreadsheet|workbook)\b|அறிக்கை|ரிப்போர்ட்/i;
const EXTRACT = /\b(?:extract|pull out|get all|list all|find all|collect)\b|பிரித்தெடு|எடுத்து/i;
const EXTRACT_TARGETS = [
  ['tables', /\btables?\b|அட்டவணை/i],
  ['emails', /\be-?mails?\b|மின்னஞ்சல்/i],
  ['phones', /\b(?:phone|mobile|contact) ?(?:numbers?|nos?)?\b|தொலைபேசி|மொபைல்/i],
  ['urls', /\b(?:urls?|links?|websites?)\b/i],
  ['dates', /\bdates?\b|தேதி/i],
  ['amounts', /\b(?:amounts?|prices?|money|currency|rupees?|totals?)\b|தொகை|விலை/i],
  ['text', /\b(?:text|content|words)\b|உரை/i],
];
const TABLE_ACTION =
  /\b(?:clean(?:\s*up)?|remove duplicates?|delete duplicates?|dedupe|de-?duplicate|drop duplicates?|merge|combine|append|join (?:the|these|all)|fill (?:empty|blank|missing)|(?:remove|delete|drop) (?:empty|blank) (?:rows?|columns?)|trim)\b|நகல்(?:களை)? நீக்கு|இணை|சுத்தம்/i;
const TABLE_SHAPING = /\b(?:filter|sort|order by|group by|pivot|total by|sum by|count by|keep only|only keep|select columns?|remove columns?|rename columns?)\b|வரிசைப்படுத்து|வடிகட்டு/i;
const OUTPUT_WORDS =
  /\b(?:file|sheet|excel|xlsx|csv|download|export|save|new (?:sheet|file|table)|create|make|generate|give me)\b|கோப்பு|உருவாக்கு/i;
const ORGANIZE =
  /\b(?:organi[sz]e|tidy(?:\s*up)?|arrange|sort out|clean ?up|declutter|group)\b[\s\S]{0,60}\b(?:folder|folders|files|directory|downloads|desktop|documents|pictures|photos)\b|(?:folder|files|கோப்புகள்|கோப்புறை)[\s\S]{0,40}(?:ஒழுங்குபடுத்து|அடுக்கு)|ஒழுங்குபடுத்து/i;
const RENAME = /\brename\b[\s\S]{0,60}\b(?:files|all|folder|them|these|everything)\b|பெயர் மாற்று/i;
const DUPLICATE_FILES = /\b(?:duplicate|same) (?:files|photos|images|documents)\b/i;
const WINDOWS_PATH = /[a-z]:\\[^\n"'<>|?*]*/i;
const QUOTED_PATH = /["'“”]([a-z]:\\[^"'“”\n<>|?*]*)["'“”]/i;

/** Folder path written in the message; trailing words ("by type", "folder") are not part of it. */
export function messagePath(text) {
  const quoted = String(text).match(QUOTED_PATH);
  if (quoted) return quoted[1].replace(/[\\\s]+$/, '') || null;
  const m = String(text).match(WINDOWS_PATH);
  if (!m) return null;
  // Only the last segment can carry trailing words; earlier segments are real folders.
  const lastSlash = m[0].lastIndexOf('\\');
  const head = m[0].slice(0, lastSlash + 1);
  const cut = head + m[0].slice(lastSlash + 1)
    .replace(/\s+(?:by|into|in to|and|with|using|according|based|per|folder|directory|files?|according|as|to|ஐ|இல்|ல)\b[\s\S]*$/i, '')
    .replace(/\s+[^\x00-\x7f][\s\S]*$/, '')
    .replace(/[\s.,;:!]+$/, '');
  return cut.length > 2 ? cut : `${cut}\\`;
}

export function wantedFormat(message) {
  const found = FORMATS.filter(([, re]) => re.test(message)).map(([f]) => f);
  return found[0] || null;
}

export function extractTargets(message) {
  return EXTRACT_TARGETS.filter(([, re]) => re.test(message)).map(([t]) => t);
}

export function organizeMode(message) {
  const m = String(message || '');
  if (/\brename\b|பெயர் மாற்று/i.test(m)) {
    if (/\bdate|day|month|year|தேதி/i.test(m)) return 'rename-date';
    return 'rename-clean';
  }
  if (DUPLICATE_FILES.test(m) || /\bduplicates?\b|நகல்/i.test(m)) return 'duplicates';
  if (/\b(?:by|per|into) (?:date|month|year)|\bmonthly\b|\byearly\b|தேதி|மாதம்|வருடம்/i.test(m))
    return 'date';
  if (/\bextensions?\b/i.test(m)) return 'extension';
  return 'type';
}

/**
 * @returns {null | {kind: 'auto'|'summarize'|'convert'|'extract'|'table'|'organize', format?, targets?, mode?, recursive?}}
 */
export function detectFileTask(
  message,
  { hasTextAttachments = false, hasTables = false, attachmentsOnly = false } = {},
) {
  const text = String(message || '').trim();

  // Folder work does not need attachments.
  if ((ORGANIZE.test(text) || RENAME.test(text) || DUPLICATE_FILES.test(text)) && !hasTables) {
    return {
      kind: 'organize',
      mode: organizeMode(text),
      recursive: /\b(?:sub-?folders?|recursive(?:ly)?|all folders|inside folders)\b|உள் கோப்புறை/i.test(text),
      path: messagePath(text),
    };
  }

  if (!hasTextAttachments) return null;
  if (attachmentsOnly || !text) return { kind: 'auto' };

  const format = wantedFormat(text);
  if (hasTables && (TABLE_ACTION.test(text) || (TABLE_SHAPING.test(text) && OUTPUT_WORDS.test(text))))
    return { kind: 'table', format: format || 'xlsx' };
  if (EXTRACT.test(text)) {
    const targets = extractTargets(text);
    if (targets.length) return { kind: 'extract', targets, format };
  }
  if (SUMMARY.test(text)) return { kind: 'summarize', format: ['pdf', 'docx', 'md', 'txt'].includes(format) ? format : null };
  if (CONVERT.test(text) && format) return { kind: 'convert', format };
  if (REPORT.test(text))
    return { kind: 'report', format: format || (/\breport\b|அறிக்கை|ரிப்போர்ட்/i.test(text) ? 'pdf' : 'docx') };
  return null;
}
