/**
 * @module ai/IntentClassifier
 * @description Decides which domain a user's problem belongs to, so the
 * orchestrator can route it to the right specialized agent. Uses a fast
 * keyword pass first, then falls back to the LLM for ambiguous cases.
 */

import { completeJSON, DEFAULT_MODEL } from './llmClient.js';

/** Known domains, each backed by a specialized agent. */
export const DOMAINS = ['automation', 'bluetooth', 'network', 'performance', 'file', 'security', 'windows'];

// 'automation' is checked first: a request like "schedule a Wi-Fi check every
// night" is about setting up automation, not about Wi-Fi — the scheduling
// intent should win over the topic keyword it happens to mention.
const KEYWORDS = {
  automation: [
    /\bschedule[ds]?\b/i, /\bscheduled task\b/i, /\btask scheduler\b/i,
    /\bevery (day|night|morning|evening|week|sunday|monday|tuesday|wednesday|thursday|friday|saturday|hour)\b/i,
    /\bautomatically\b/i, /\bbackup\b/i, /\breminder\b/i, /\bremind me\b/i,
    /\bstart[- ]?up\b/i, /\bmonitor\b/i, /\bwatch (a |my )?folder\b/i,
    /\bcron\b/i, /\bmaintenance window\b/i, /\bkeep .* in sync\b/i
  ],
  bluetooth: [/\bbluetooth\b/i, /\bbt\b/i, /\bairpods?\b/i, /\bearbuds?\b/i, /\bpair(ing|ed)?\b/i],
  network: [/\bwi[\s-]?fi\b/i, /\bnetwork\b/i, /\binternet\b/i, /\bethernet\b/i, /\bdns\b/i, /\bip\b/i, /\brouter\b/i, /\badapter\b/i, /\bvpn\b/i, /\bproxy\b/i],
  performance: [/\bslow\b/i, /\blag(gy|ging)?\b/i, /\bfreez(e|ing)\b/i, /\bcpu\b/i, /\bmemory\b/i, /\bram\b/i, /\bdisk (space|full)\b/i, /\bhang(s|ing)?\b/i, /\bhigh usage\b/i],
  file: [/\bfile\b/i, /\bfolder\b/i, /\bcorrupt(ed)?\b/i, /\bdelete[d]?\b/i, /\brecycle\b/i, /\bpermission\b/i, /\baccess denied\b/i, /\bexplorer\b/i],
  security: [/\bvirus\b/i, /\bmalware\b/i, /\bdefender\b/i, /\bfirewall\b/i, /\bthreat\b/i, /\bantivirus\b/i, /\bquarantine\b/i, /\bsuspicious\b/i]
};

function keywordDomain(goal) {
  const text = String(goal || '');
  for (const domain of DOMAINS) {
    const patterns = KEYWORDS[domain];
    if (patterns && patterns.some((p) => p.test(text))) return domain;
  }
  return null;
}

const SYSTEM = `You are an intent classifier for a Windows self-repair assistant. Classify the user's problem into exactly ONE domain.
Domains:
- automation: setting up a recurring/scheduled action — backups, file sync, running a script on a timer, launching an app at logon, cleanup jobs, service start/stop windows, startup-app management, reminders, periodic diagnostics, disk/folder monitoring. If the request is "make X happen automatically/on a schedule", this is it, even if X sounds like another domain's topic.
- bluetooth: Bluetooth radios, pairing, wireless audio devices.
- network: Wi-Fi, Ethernet, internet, DNS, IP, adapters, VPN, proxy.
- performance: slowness, high CPU/RAM/disk, freezing, startup bloat, disk space.
- file: files/folders, corruption, permissions, access-denied, Explorer.
- security: viruses, malware, Windows Defender, firewall, threats.
- windows: anything else / general Windows issues (updates, services, drivers, audio, display, printers).
Reply with JSON only: {"domain": "<one domain>", "confidence": 0.0-1.0, "reason": "<short>"}`;

/**
 * Classify a problem into a repair domain.
 *
 * @param {string} goal - The user's problem statement.
 * @param {Object} [opts]
 * @param {string} [opts.model]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ domain: string, confidence: number, reason: string, via: 'keyword'|'llm' }>}
 */
export async function classifyIntent(goal, { model = DEFAULT_MODEL, signal } = {}) {
  const quick = keywordDomain(goal);
  if (quick) {
    return { domain: quick, confidence: 0.9, reason: 'Matched domain keywords.', via: 'keyword' };
  }

  try {
    const result = await completeJSON({
      system: SYSTEM,
      prompt: `USER PROBLEM:\n${goal}\n\nClassify it.`,
      model,
      signal
    });
    const domain = DOMAINS.includes(result.domain) ? result.domain : 'windows';
    return {
      domain,
      confidence: typeof result.confidence === 'number' ? result.confidence : 0.5,
      reason: result.reason || '',
      via: 'llm'
    };
  } catch {
    // If the model is unreachable, degrade gracefully to the general agent.
    return { domain: 'windows', confidence: 0.3, reason: 'Fell back to general repair.', via: 'keyword' };
  }
}
