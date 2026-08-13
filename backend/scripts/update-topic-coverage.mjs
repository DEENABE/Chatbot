#!/usr/bin/env node
/**
 * Regenerates storage/topic-coverage-report.json from the Unified Session DB
 * (repair-sessions.json + automation-sessions.json, merged).
 *
 * The report is a derived artifact — it answers "which repair topics does the
 * dataset actually cover, and how good is that coverage?" so gaps can be
 * filled deliberately rather than guessed at. Because it is derived, it goes
 * stale the moment sessions are added or normalized; regenerate rather than
 * hand-edit.
 *
 * Usage: node scripts/update-topic-coverage.mjs [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUBDOMAINS } from '../src/knowledge/subdomains.js';
import { DOMAINS } from '../src/ai/IntentClassifier.js';
import { getSessions } from '../src/ai/RepairLogger.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = path.join(root, 'storage', 'topic-coverage-report.json');
const dryRun = process.argv.includes('--dry-run');

const sessions = getSessions();

const round2 = (n) => Math.round(n * 100) / 100;

function qualityOf(records) {
  const withCommandOutput = records.filter((s) =>
    s.steps.some((step) => step.stdout && step.stdout.trim())
  ).length;
  const withFailingStep = records.filter((s) =>
    s.steps.some((step) => step.exitCode !== 0 && step.exitCode !== null)
  ).length;
  const unresolved = records.filter((s) => !s.resolved).length;
  const totalSteps = records.reduce((sum, s) => sum + s.steps.length, 0);
  const totalSummary = records.reduce((sum, s) => sum + (s.summary || '').length, 0);
  return {
    records: records.length,
    withCommandOutput,
    withFailingStep,
    unresolved,
    avgSteps: records.length ? round2(totalSteps / records.length) : 0,
    avgSummaryChars: records.length ? Math.round(totalSummary / records.length) : 0,
  };
}

// coverageBreakdown: domain -> subdomain -> count. Sessions whose subdomain
// was nulled during normalization are counted under "(unclassified)" so the
// totals still reconcile against totalRecordsAnalyzed.
const coverageBreakdown = {};
const subdomainTotals = new Map();
for (const session of sessions) {
  const domain = session.domain;
  const sub = session.subdomain || '(unclassified)';
  coverageBreakdown[domain] = coverageBreakdown[domain] || {};
  coverageBreakdown[domain][sub] = (coverageBreakdown[domain][sub] || 0) + 1;
  subdomainTotals.set(sub, (subdomainTotals.get(sub) || 0) + 1);
}
// Sort each domain's subdomains by frequency for readability.
for (const domain of Object.keys(coverageBreakdown)) {
  coverageBreakdown[domain] = Object.fromEntries(
    Object.entries(coverageBreakdown[domain]).sort((a, b) => b[1] - a[1])
  );
}

// DOMAINS covers the 6 IntentClassifier routes a live chat message can land
// on; Object.keys(SUBDOMAINS) additionally includes 'automation' (offline
// session data only, not live-routed — see knowledge/subdomains.js). Union
// them so this report doesn't silently drop non-routed domains.
const reportedDomains = [...new Set([...DOMAINS, ...Object.keys(SUBDOMAINS)])];

const qualityByDomain = {};
for (const domain of reportedDomains) {
  const records = sessions.filter((s) => s.domain === domain);
  if (records.length) qualityByDomain[domain] = qualityOf(records);
}

// thinCoverage: known subdomains with very few (or zero) examples — the
// actionable part of the report, since these are what to generate next.
const thinCoverage = [];
for (const domain of reportedDomains) {
  for (const sub of SUBDOMAINS[domain] || []) {
    const count = coverageBreakdown[domain]?.[sub] || 0;
    if (count <= 3) thinCoverage.push({ domain, subdomain: sub, records: count });
  }
}
thinCoverage.sort((a, b) => a.records - b.records || a.domain.localeCompare(b.domain));

const topSubdomains = [...subdomainTotals.entries()]
  .filter(([sub]) => sub !== '(unclassified)')
  .sort((a, b) => b[1] - a[1])
  .slice(0, 25)
  .map(([subdomain, records]) => ({ subdomain, records }));

const classified = sessions.filter((s) => s.subdomain).length;

const report = {
  updatedAt: new Date().toISOString(),
  totalRecordsAnalyzed: sessions.length,
  taxonomy: {
    domains: Object.keys(coverageBreakdown).length,
    subdomains: subdomainTotals.size - (subdomainTotals.has('(unclassified)') ? 1 : 0),
    classifiedRecords: classified,
    unclassifiedRecords: sessions.length - classified,
    canonicalSubdomainsAvailable: reportedDomains.reduce((n, d) => n + (SUBDOMAINS[d] || []).length, 0),
  },
  coverageBreakdown,
  qualityByDomain,
  overallQuality: qualityOf(sessions),
  thinCoverage,
  topSubdomains,
};

if (dryRun) {
  console.log(JSON.stringify(report, null, 2).slice(0, 1200) + '\n...');
  console.log('\n--dry-run: not written.');
  process.exit(0);
}

fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n', 'utf8');

console.log(`Wrote ${REPORT}`);
console.log(`  records analyzed:  ${report.totalRecordsAnalyzed}`);
console.log(`  domains covered:   ${report.taxonomy.domains}`);
console.log(`  subdomains seen:   ${report.taxonomy.subdomains} / ${report.taxonomy.canonicalSubdomainsAvailable} canonical`);
console.log(`  classified:        ${report.taxonomy.classifiedRecords}`);
console.log(`  unclassified:      ${report.taxonomy.unclassifiedRecords}`);
console.log(`  thin/absent topics:${report.thinCoverage.length}`);
