/**
 * @module knowledge/subdomains
 * @description The granular labels that live *inside* each of the six
 * canonical domains the IntentClassifier routes to.
 *
 * Routing stays on the six domains (one agent + one guide each). The subdomain
 * is a finer label carried on a logged session: it selects a playbook section
 * inside the domain guide and is folded into the training prompt
 * ("windows (audio)") so a fine-tuned model learns the narrower specialization
 * without the app needing a separate agent per topic.
 *
 * Adding a new subdomain is intentionally cheap — add it here, and ideally add
 * a matching `### <name>` playbook to the domain's guide.
 */

/** Known subdomains per canonical domain. */
export const SUBDOMAINS = {
  network: [
    'dns-advanced', 'vpn', 'proxy', 'iis', 'cloud', 'loadbalancer',
    'wifi', 'ethernet', 'firewall-rules', 'sharing',
  ],
  bluetooth: [
    'pairing', 'audio-profile', 'radio', 'transfer', 'peripherals',
  ],
  performance: [
    'cpu', 'gpu', 'memory', 'boot', 'power', 'gaming', 'thermal', 'startup',
  ],
  file: [
    'storage', 'raid', 'dfs', 'permissions', 'corruption', 'search', 'sync',
  ],
  security: [
    'certificates', 'security-incident', 'defender', 'firewall', 'accounts',
    'encryption', 'updates-security',
  ],
  windows: [
    'eventlog', 'errorcode', 'driver', 'audio', 'printer', 'display',
    'registry', 'services', 'update', 'activedirectory', 'office', 'hardware',
    'dev', 'internals', 'docker', 'hyperv', 'exchange', 'virtualization',
    'wsl', 'accessibility', 'sql', 'sccm', 'azuread', 'cluster', 'bsod',
    'wsus', 'gpo-advanced', 'terminal', 'vmware', 'shell', 'time', 'store',
  ],
};

/** Every known subdomain, flattened. */
export const ALL_SUBDOMAINS = Object.values(SUBDOMAINS).flat();

/**
 * Check whether a subdomain is known for a domain.
 *
 * @param {string} domain - A canonical domain.
 * @param {string} subdomain
 * @returns {boolean}
 */
export function isKnownSubdomain(domain, subdomain) {
  if (!subdomain) return false;
  const list = SUBDOMAINS[domain];
  return Array.isArray(list) && list.includes(String(subdomain).toLowerCase());
}

/**
 * Normalize a subdomain for storage: lowercase, trimmed, and only kept when it
 * belongs to the domain. Unknown labels are dropped rather than stored, so the
 * training prompt never carries a stray value.
 *
 * @param {string} domain
 * @param {string} [subdomain]
 * @returns {string|null}
 */
export function normalizeSubdomain(domain, subdomain) {
  if (!subdomain) return null;
  const clean = String(subdomain).trim().toLowerCase();
  return isKnownSubdomain(domain, clean) ? clean : null;
}

/**
 * The label used in a training system prompt: "windows (audio)" when a
 * subdomain is present, otherwise just the domain.
 *
 * @param {string} domain
 * @param {string} [subdomain]
 * @returns {string}
 */
export function domainLabel(domain, subdomain) {
  const sub = normalizeSubdomain(domain, subdomain);
  return sub ? `${domain} (${sub})` : domain;
}
