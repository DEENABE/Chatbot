// The upload endpoint tolerates a mixed batch (any real folder has some):
// it indexes what it can and reports the rest in `skipped` rather than
// failing the whole request. Without this, a folder upload where every file
// happens to be an unsupported type (or fails to parse) looks like nothing
// happened at all, with no indication why.
export function warnAboutSkippedUploads(result) {
  const skipped = result?.skipped;
  if (!skipped?.length) return;

  const lines = skipped
    .slice(0, 10)
    .map((item) => `- ${item.name}: ${item.reason}`)
    .join('\n');
  const more = skipped.length > 10 ? `\n…and ${skipped.length - 10} more` : '';

  const indexedCount = result?.documents?.length || 0;
  const heading = indexedCount
    ? `${indexedCount} file(s) indexed. ${skipped.length} file(s) were skipped:`
    : `No files were indexed. ${skipped.length} file(s) were skipped:`;

  alert(`${heading}\n${lines}${more}`);
}
