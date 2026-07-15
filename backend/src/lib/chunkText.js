export function chunkText(text, { size = 900, overlap = 140 } = {}) {
  const clean = text
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')            
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!clean) return [];

  const paragraphs = clean.split(/\n\n+/);
  const chunks = [];
  let current = '';

  const flush = () => {
    if (!current.trim()) return;
    chunks.push(current.trim());
    current = current.slice(Math.max(0, current.length - overlap));
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > size) {
      const sentences = paragraph.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [paragraph];
      for (const sentence of sentences) {
        if (current.length + sentence.length > size) flush();
        current += `${current ? ' ' : ''}${sentence.trim()}`;
      }
    } else {
      if (current.length + paragraph.length + 2 > size) flush();
      current += `${current ? '\n\n' : ''}${paragraph}`;
    }
  }
  if (current.trim() && chunks.at(-1) !== current.trim()) chunks.push(current.trim());
  return chunks.filter((chunk, index) => index === 0 || chunk !== chunks[index - 1]);
}
