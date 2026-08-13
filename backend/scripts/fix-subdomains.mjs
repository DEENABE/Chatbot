#!/usr/bin/env node
/**
 * Normalizes `domain` and `subdomain` in storage/repair-sessions.json.
 *
 * Sessions written directly to the file (by the bulk add-*-entries scripts)
 * bypassed RepairLogger.logSession(), which is the only place that calls
 * normalizeSubdomain(). Two problems follow from that:
 *
 *  1. `subdomain` holds free-text labels ("Wi-Fi", "RAM", "Event Viewer")
 *     instead of the canonical slugs in knowledge/subdomains.js — and they
 *     often don't even match the goal text ("windows :: proxy" on a CPU
 *     throttling report). domainLabel() re-normalizes on export, so these are
 *     silently discarded: the stored value claims a specialization the
 *     training prompt never actually receives.
 *
 *  2. `domain` is over-assigned to "windows", the fallback the classifier
 *     uses when nothing else matches. Where the keyword fast-path in
 *     IntentClassifier — the same code that routes a live request — clearly
 *     says otherwise, the stored label disagrees with how the app would
 *     actually handle that exact problem.
 *
 * This rewrites both fields to what the app itself would have produced.
 * Domains are only reassigned away from the "windows" fallback, and only on
 * an unambiguous keyword hit, so a deliberate windows-domain session is
 * never relabelled out from under the user.
 *
 * Usage: node scripts/fix-subdomains.mjs [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUBDOMAINS } from '../src/knowledge/subdomains.js';
import { DOMAINS } from '../src/ai/IntentClassifier.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(root, 'storage', 'repair-sessions.json');
const dryRun = process.argv.includes('--dry-run');

// Mirrors the KEYWORDS map in src/ai/IntentClassifier.js. Duplicated rather
// than imported because that module doesn't export it, and importing the
// module's classifyIntent() would drag in the LLM client for an offline batch job.
const KEYWORDS = {
  bluetooth: [/\bbluetooth\b/i, /\bbt\b/i, /\bairpods?\b/i, /\bearbuds?\b/i, /\bpair(ing|ed)?\b/i],
  network: [/\bwi[\s-]?fi\b/i, /\bnetwork\b/i, /\binternet\b/i, /\bethernet\b/i, /\bdns\b/i, /\bip\b/i, /\brouter\b/i, /\badapter\b/i, /\bvpn\b/i, /\bproxy\b/i],
  performance: [/\bslow\b/i, /\blag(gy|ging)?\b/i, /\bfreez(e|ing)\b/i, /\bcpu\b/i, /\bmemory\b/i, /\bram\b/i, /\bdisk (space|full)\b/i, /\bhang(s|ing)?\b/i, /\bhigh usage\b/i],
  file: [/\bfile\b/i, /\bfolder\b/i, /\bcorrupt(ed)?\b/i, /\bdelete[d]?\b/i, /\brecycle\b/i, /\bpermission\b/i, /\baccess denied\b/i, /\bexplorer\b/i],
  security: [/\bvirus\b/i, /\bmalware\b/i, /\bdefender\b/i, /\bfirewall\b/i, /\bthreat\b/i, /\bantivirus\b/i, /\bquarantine\b/i, /\bsuspicious\b/i],
};

function keywordDomain(goal) {
  const text = String(goal || '');
  for (const domain of DOMAINS) {
    const patterns = KEYWORDS[domain];
    if (patterns && patterns.some((p) => p.test(text))) return domain;
  }
  return null;
}

// Free-text label -> canonical slug. Only unambiguous renames; anything not
// listed falls through to the domain-membership check and becomes null.
const ALIASES = {
  'wi-fi': 'wifi', wifi: 'wifi', dns: 'dns-advanced', ethernet: 'ethernet',
  vpn: 'vpn', proxy: 'proxy', iis: 'iis', cloud: 'cloud',
  loadbalancer: 'loadbalancer', sharing: 'sharing', smb: 'sharing',
  cpu: 'cpu', ram: 'memory', memory: 'memory', gpu: 'gpu',
  'power management': 'power', power: 'power', startup: 'startup',
  boot: 'boot', gaming: 'gaming', thermal: 'thermal',
  disk: 'storage', drive: 'storage', partitions: 'storage',
  storage: 'storage', ntfs: 'storage', raid: 'raid', dfs: 'dfs',
  permissions: 'permissions', corruption: 'corruption', search: 'search',
  sync: 'sync', onedrive: 'sync',
  'event viewer': 'eventlog', eventlog: 'eventlog',
  'error interpretation': 'errorcode', errorcode: 'errorcode',
  drivers: 'driver', driver: 'driver',
  'windows update': 'update', update: 'update',
  'directory services': 'activedirectory', activedirectory: 'activedirectory',
  outlook: 'office', word: 'office', excel: 'office', office: 'office',
  'group policy': 'gpo-advanced', powershell: 'terminal', terminal: 'terminal',
  appx: 'store', 'appx/store': 'store', store: 'store',
  usb: 'hardware', hardware: 'hardware', registry: 'registry',
  service: 'services', services: 'services', printer: 'printer',
  display: 'display', audio: 'audio', shell: 'shell', time: 'time',
  docker: 'docker', hyperv: 'hyperv', wsl: 'wsl', sql: 'sql',
  exchange: 'exchange', vmware: 'vmware', virtualization: 'virtualization',
  bsod: 'bsod', internals: 'internals', dev: 'dev', accessibility: 'accessibility',
  defender: 'defender', bitlocker: 'encryption', encryption: 'encryption',
  certificates: 'certificates', account: 'accounts',
  'account security': 'accounts', accounts: 'accounts', firewall: 'firewall',
  pairing: 'pairing', radio: 'radio', transfer: 'transfer', peripherals: 'peripherals',
};

// Same word, different canonical slug depending on the domain.
const DOMAIN_ALIASES = {
  bluetooth: { audio: 'audio-profile', 'audio-profile': 'audio-profile' },
  network: { firewall: 'firewall-rules', 'firewall-rules': 'firewall-rules' },
};

function canonicalSubdomain(domain, subdomain) {
  if (!subdomain) return null;
  const key = String(subdomain).trim().toLowerCase();
  const mapped = DOMAIN_ALIASES[domain]?.[key] ?? ALIASES[key] ?? key;
  return (SUBDOMAINS[domain] || []).includes(mapped) ? mapped : null;
}

const sessions = JSON.parse(fs.readFileSync(FILE, 'utf8'));

const stats = { domainReassigned: 0, subRecovered: 0, subNulled: 0, subUnchanged: 0 };
const reassigned = new Map();
const dropped = new Map();

for (const session of sessions) {
  // 1. Domain: only rescue records stuck on the "windows" fallback.
  if (session.domain === 'windows') {
    const kw = keywordDomain(session.goal);
    if (kw && kw !== 'windows') {
      const label = `windows -> ${kw}`;
      reassigned.set(label, (reassigned.get(label) || 0) + 1);
      session.domain = kw;
      stats.domainReassigned++;
    }
  }

  // 2. Subdomain: canonicalize against the (possibly updated) domain.
  const before = session.subdomain;
  const after = canonicalSubdomain(session.domain, before);
  if (before === after) {
    stats.subUnchanged++;
  } else if (after === null) {
    stats.subNulled++;
    const label = `${session.domain} :: ${before}`;
    dropped.set(label, (dropped.get(label) || 0) + 1);
  } else {
    stats.subRecovered++;
  }
  session.subdomain = after;
}

console.log(`Sessions:              ${sessions.length}`);
console.log(`Domain reassigned:     ${stats.domainReassigned}`);
console.log(`Subdomain kept as-is:  ${stats.subUnchanged}`);
console.log(`Subdomain recovered:   ${stats.subRecovered}`);
console.log(`Subdomain -> null:     ${stats.subNulled}`);

if (reassigned.size) {
  console.log('\nDomain reassignments:');
  [...reassigned.entries()].sort((a, b) => b[1] - a[1])
    .forEach(([label, count]) => console.log(`  x${count}\t${label}`));
}

if (dropped.size) {
  console.log('\nSubdomains dropped (no canonical slug for that domain):');
  [...dropped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
    .forEach(([label, count]) => console.log(`  x${count}\t${label}`));
  if (dropped.size > 15) console.log(`  ... and ${dropped.size - 15} more distinct labels`);
}

if (dryRun) {
  console.log('\n--dry-run: no changes written.');
} else {
  fs.copyFileSync(FILE, `${FILE}.bak`);
  fs.writeFileSync(FILE, JSON.stringify(sessions, null, 2), 'utf8');
  console.log(`\nWrote ${FILE}`);
  console.log(`Backup at ${FILE}.bak`);
}
