// Optimal-string-alignment Damerau-Levenshtein: insertion, deletion,
// substitution, and adjacent transposition all cost one.
export function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) d[i][0] = i;
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}
export function jaroWinkler(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1),
    aa = Array(a.length).fill(false),
    bb = Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++)
    for (let j = Math.max(0, i - window); j < Math.min(b.length, i + window + 1); j++)
      if (!bb[j] && a[i] === b[j]) {
        aa[i] = true;
        bb[j] = true;
        matches++;
        break;
      }
  if (!matches) return 0;
  const am = a.split('').filter((_, i) => aa[i]),
    bm = b.split('').filter((_, i) => bb[i]);
  let transpositions = 0;
  for (let i = 0; i < am.length; i++) if (am[i] !== bm[i]) transpositions++;
  const jaro =
    (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  return jaro > 0.7 ? jaro + prefix * 0.1 * (1 - jaro) : jaro;
}
function tokenSimilarity(q, n) {
  const left = q.split(' '),
    right = n.split(' '),
    pairs = [];
  for (let i = 0; i < left.length; i++)
    for (let j = 0; j < right.length; j++)
      pairs.push({
        i,
        j,
        score: 1 - editDistance(left[i], right[j]) / Math.max(left[i].length, right[j].length),
      });
  pairs.sort((a, b) => b.score - a.score);
  const usedL = new Set(),
    usedR = new Set();
  let score = 0;
  for (const p of pairs)
    if (!usedL.has(p.i) && !usedR.has(p.j)) {
      usedL.add(p.i);
      usedR.add(p.j);
      score += p.score;
    }
  return score / Math.max(left.length, right.length);
}
export function scoreSearchName(q, name) {
  const n = name.value,
    kind = name.kind;
  if (q === n)
    return {
      score: kind === 'NAME' ? 1 : kind === 'EXECUTABLE' ? 0.985 : 0.99,
      matchType: kind === 'NAME' ? 'EXACT' : kind === 'EXECUTABLE' ? 'EXECUTABLE' : 'ALIAS',
      auto: true,
      exact: true,
    };
  // Identity-bearing symbols must never be removed by fuzzy correction.
  if ((q.match(/[+#]/g) || []).join('') !== (n.match(/[+#]/g) || []).join(''))
    return { score: 0, auto: false };
  const a = q.replaceAll(' ', ''),
    b = n.replaceAll(' ', '');
  if (a === b) return { score: 0.98, matchType: 'SPACING', auto: true };
  const sorted = (s) => s.split(' ').sort().join(' ');
  if (sorted(q) === sorted(n)) return { score: 0.97, matchType: 'TOKEN', auto: true };
  const distance = editDistance(a, b),
    length = Math.max(a.length, b.length),
    edit = 1 - distance / Math.max(1, length),
    jaro = jaroWinkler(a, b),
    token = tokenSimilarity(q, n);
  let prefix = 0;
  while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  const substring = b.includes(a) ? a.length / b.length : 0;
  const components = {
    editDistance: distance,
    normalizedEdit: edit,
    jaroWinkler: jaro,
    tokenSimilarity: token,
    prefixSimilarity: prefix / Math.max(1, length),
    substringSimilarity: substring,
  };
  const partial =
    q.split(' ').every((t) => n.split(' ').some((w) => w.startsWith(t))) && a.length < b.length;
  // Short names need a much larger winner margin; long names tolerate multiple edits.
  const short = Math.min(a.length, b.length) <= 3;
  const limit = length >= 10 ? Math.min(3, Math.floor(length * 0.2)) : length >= 6 ? 2 : 1;
  const plausible =
    Math.min(a.length, b.length) >= 3 &&
    distance <= limit &&
    edit >= (short ? 0.6 : 0.66) &&
    jaro >= 0.7;
  let score =
    0.48 * edit +
    0.27 * jaro +
    0.2 * token +
    0.05 * Math.max(components.prefixSimilarity, substring);
  if (plausible) score = Math.max(score, (short ? 0.835 : 0.89) + 0.065 * edit + 0.02 * jaro);
  const incomplete = partial && a.length / b.length < 0.8;
  if (incomplete) score = Math.max(0.8, Math.min(0.86, score));
  return {
    score: Math.min(0.965, Math.max(0, score)),
    auto: plausible && !incomplete,
    partial: incomplete,
    matchType: incomplete ? 'PARTIAL' : 'FUZZY',
    components,
  };
}
