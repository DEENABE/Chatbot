import { normalizeIdentity, sanitizeSoftwareQuery } from './contracts.js';

const tokens = (value) => normalizeIdentity(value).split(' ').filter(Boolean);
export function identityScore(query, candidate) {
  const target = normalizeIdentity(query.product),
    names = [candidate.name, candidate.id, ...(candidate.aliases || [])].map(normalizeIdentity);
  if (names.includes(target)) return 100;
  const wanted = tokens(target);
  return Math.max(
    0,
    ...names.map((name) => {
      const have = tokens(name),
        overlap = wanted.filter((token) => have.includes(token)).length;
      if (overlap === wanted.length && overlap)
        return Math.max(55, 85 - (have.length - overlap) * 4);
      // Typo tolerance is only candidate ranking; it never makes a different publisher unambiguous.
      if (
        wanted.length === 1 &&
        have.some((word) => distance(word, wanted[0]) <= 1 && word.length >= 4)
      )
        return 50;
      return overlap ? Math.round((45 * overlap) / wanted.length) : 0;
    }),
  );
}

function distance(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/** Generic identity/constraint ranking. A name match alone cannot authorize a publisher or source. */
export class SoftwareResolver {
  constructor({
    architecture = process.arch === 'ia32' ? 'x86' : process.arch === 'arm64' ? 'arm64' : 'x64',
  } = {}) {
    this.architecture = architecture;
  }
  rank(rawQuery, candidates) {
    const query = sanitizeSoftwareQuery(rawQuery),
      arch = query.architecture === 'auto' ? this.architecture : query.architecture;
    const ranked = candidates
      .filter((candidate) => {
        if (!candidate || !['approved', 'official', 'local-selection'].includes(candidate.trust))
          return false;
        if (query.sourceProviderId && candidate.providerId !== query.sourceProviderId) return false;
        if (
          query.publisher &&
          normalizeIdentity(candidate.publisher) !== normalizeIdentity(query.publisher)
        )
          return false;
        if (query.version && candidate.version !== query.version && !candidate.handoff)
          return false;
        if (
          query.edition &&
          normalizeIdentity(candidate.edition) !== normalizeIdentity(query.edition) &&
          !candidate.handoff
        )
          return false;
        if (
          candidate.architecture &&
          candidate.architecture !== 'any' &&
          candidate.architecture !== arch &&
          !(arch === 'x64' && candidate.architecture === 'x86')
        )
          return false;
        return identityScore(query, candidate) >= 45;
      })
      .map((candidate) => ({
        ...candidate,
        score:
          identityScore(query, candidate) +
          (candidate.identityVerified === false || candidate.handoff ? -40 : 15) +
          (candidate.architecture === arch ? 5 : 0),
      }));
    ranked.sort(
      (a, b) =>
        b.score - a.score ||
        compareVersions(b.version, a.version) ||
        a.providerId.localeCompare(b.providerId),
    );
    const deduplicated = [],
      keys = new Set();
    for (const candidate of ranked) {
      const key = [
        normalizeIdentity(candidate.name),
        normalizeIdentity(candidate.publisher),
        candidate.version,
        normalizeIdentity(candidate.edition),
        candidate.architecture,
        candidate.handoff ? candidate.providerId : 'installer',
      ].join('|');
      if (!keys.has(key)) {
        keys.add(key);
        deduplicated.push(candidate);
      }
    }
    const first = deduplicated[0];
    const plausible = first
      ? deduplicated.filter(
          (candidate) => candidate.score >= first.score - 20 && !candidate.handoff,
        )
      : [];
    const identities = new Set(
      plausible.map((candidate) =>
        [
          normalizeIdentity(candidate.name),
          normalizeIdentity(candidate.publisher),
          normalizeIdentity(candidate.edition),
        ].join('|'),
      ),
    );
    const requiresChoice =
      identities.size > 1 || (!!first && identityScore(query, first) < 85 && !first.handoff);
    return {
      candidates: deduplicated,
      requiresChoice,
      ...(!requiresChoice && first ? { selectedCandidate: first } : {}),
    };
  }
}
export const rankCandidates = (query, candidates, options) =>
  new SoftwareResolver(options).rank(query, candidates);
function compareVersions(a = '', b = '') {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}
