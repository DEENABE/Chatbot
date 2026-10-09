const normalize = (s) =>
  String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[&.…]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return d[a.length][b.length];
}
// Resolve semantic proposals only against the current bounded snapshot.
export function resolveElement(target, snapshot) {
  if (!target || !(target.name || target.automationId)) return null;
  const name = normalize(target.name),
    rank = [];
  for (const e of snapshot.elements || []) {
    if (!e.enabled || (target.controlType && normalize(e.role) !== normalize(target.controlType)))
      continue;
    if (target.automationId && target.automationId !== e.automationId) continue;
    const parent = snapshot.elements.find((p) => p.elementId === e.parentId);
    if (target.parentName && normalize(parent?.label) !== normalize(target.parentName)) continue;
    const label = normalize(e.label),
      score = target.automationId
        ? 1
        : label === name
          ? 1
          : label.split(' ').sort().join(' ') === name.split(' ').sort().join(' ')
            ? 0.97
            : 1 - distance(name, label) / Math.max(1, name.length, label.length);
    if (score >= 0.85) rank.push({ e, score });
  }
  rank.sort((a, b) => b.score - a.score);
  return rank.length && (!rank[1] || rank[0].score - rank[1].score >= 0.08) ? rank[0].e : null;
}
