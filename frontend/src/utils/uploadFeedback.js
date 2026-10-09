// The upload endpoint tolerates a mixed batch (any real folder has some):
// it indexes what it can and reports the rest in `skipped` rather than
// failing the whole request. Without this, a folder upload where every file
// happens to be an unsupported type (or fails to parse) looks like nothing
// happened at all, with no indication why.
export function warnAboutSkippedUploads(result) {
  const skipped = result?.skipped || [];
  const warnings = result?.warnings || [];
  if (!skipped.length && !warnings.length) return;

  const indexedCount = result?.documents?.length || 0;
  const parts = [];

  if (skipped.length) {
    const lines = skipped
      .slice(0, 10)
      .map((item) => `- ${item.name}: ${item.reason}`)
      .join('\n');
    const more = skipped.length > 10 ? `\n…and ${skipped.length - 10} more` : '';
    parts.push(
      `${indexedCount ? `${indexedCount} file(s) indexed. ` : 'No files were indexed. '}${skipped.length} file(s) were skipped:\n${lines}${more}`,
    );
  }
  if (warnings.length) {
    const lines = warnings
      .slice(0, 5)
      .map((item) => `- ${item.name}: ${item.message}`)
      .join('\n');
    parts.push(
      `${skipped.length ? 'Note — ' : `${indexedCount} file(s) indexed. Note — `}${warnings.length} file(s):\n${lines}`,
    );
  }
  alert(parts.join('\n\n'));
}
