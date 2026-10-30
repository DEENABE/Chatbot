/**
 * Whole-document summary (map → reduce). Unlike chat retrieval, every part of the
 * document is read. Long documents are split into parts; each part becomes
 * notes, and the notes become the final summary streamed to the user.
 */

const TAMIL = /[஀-௿]/g;
const MAX_PARTS = 16;

export function languageOf(request, sample) {
  const req = String(request || '');
  if ((req.match(TAMIL) || []).length > 3) return 'Tamil';
  if (req.trim() && !/^summari[sz]e the attached documents\.?$/i.test(req.trim())) return null; // follow the request
  const tamil = (String(sample || '').slice(0, 4000).match(TAMIL) || []).length;
  return tamil > 400 ? 'Tamil' : null;
}

/** Split text into parts near `size` characters, on paragraph/sentence boundaries. */
export function splitParts(text, size) {
  const parts = [];
  let current = '';
  for (const para of String(text).split(/\n{2,}/)) {
    if (current.length + para.length + 2 <= size) {
      current += (current ? '\n\n' : '') + para;
      continue;
    }
    if (current) parts.push(current);
    if (para.length <= size) {
      current = para;
      continue;
    }
    current = '';
    for (const sentence of para.match(/[^.!?।]+[.!?।]+|[^.!?।]+$/g) || [para]) {
      let s = sentence;
      // A single run-on "sentence" longer than size is cut hard.
      while (s.length > size) {
        if (current) parts.push(current);
        current = '';
        parts.push(s.slice(0, size));
        s = s.slice(size);
      }
      if (current.length + s.length > size && current) {
        parts.push(current);
        current = '';
      }
      current += s;
    }
  }
  if (current.trim()) parts.push(current);
  return parts.filter((p) => p.trim());
}

export function planParts(text) {
  const tamilShare = (String(text).slice(0, 20000).match(TAMIL) || []).length / Math.max(1, Math.min(text.length, 20000));
  // Tamil uses many more tokens per character; keep each part inside an 8k context.
  const size = tamilShare > 0.3 ? 3500 : 9000;
  const parts = splitParts(text, size);
  if (parts.length <= MAX_PARTS) return { parts, sampled: false, total: parts.length };
  const picked = [];
  for (let i = 0; i < MAX_PARTS; i++) picked.push(parts[Math.floor((i * parts.length) / MAX_PARTS)]);
  return { parts: picked, sampled: true, total: parts.length };
}

/**
 * @param {object} o
 * @param {string} o.name file name
 * @param {string} o.text whole document text
 * @param {string} o.request the user's message
 * @param {(messages, {onToken}) => Promise<string>} o.chat model call
 * @param {(text: string) => void} o.emit streams text to the user
 * @param {(text: string) => void} [o.status]
 */
export async function summarizeDocument({ name, text, request, chat, emit, status, signal }) {
  const language = languageOf(request, text);
  const langRule = language ? ` Write in ${language}.` : ' Write in the same language as the user request.';
  const { parts, sampled, total } = planParts(text);
  let material;
  if (parts.length === 1) {
    material = parts[0];
  } else {
    const notes = [];
    for (let i = 0; i < parts.length; i++) {
      signal?.throwIfAborted();
      status?.(`Reading ${name}: part ${i + 1} of ${parts.length}`);
      const note = await chat(
        [
          {
            role: 'system',
            content:
              'You take notes for a document summary. List the key facts, figures, names, dates, decisions and conclusions in this part as short bullet points. Use only information in the text. No introduction.',
          },
          { role: 'user', content: `Document: ${name} (part ${i + 1} of ${parts.length})\n\n${parts[i]}` },
        ],
        {},
      );
      notes.push(`Part ${i + 1}:\n${note.trim()}`);
    }
    material = notes.join('\n\n');
  }
  status?.(`Writing the summary of ${name}`);
  const instructions =
    'Summarize the document for the user. Start with a 2–3 sentence overview, then "**Key points**" as 5–12 bullets, then "**Numbers & dates**" if the document has important figures, then "**Conclusions / actions**" if any. Only use facts from the material; do not invent anything.' +
    langRule;
  const answer = await chat(
    [
      { role: 'system', content: instructions },
      {
        role: 'user',
        content: `User request: ${request || 'Summarize the document.'}\n\nDocument: ${name}\n${parts.length > 1 ? `Notes from ${parts.length} parts of the document:\n` : 'Text:\n'}\n${material}`,
      },
    ],
    { onToken: emit },
  );
  const note = sampled
    ? `\n\n_This is a long document (${total} parts); the summary is based on ${parts.length} evenly spaced parts._`
    : '';
  if (note) emit(note);
  return answer + note;
}
