import {
  PROVIDER_ID,
  deepFreeze,
  error,
  sanitizeSoftwareQuery,
  validateInstallerPlan,
} from './contracts.js';
import {
  validateProviderDescriptor,
  providerFromDescriptor,
} from './providers/MetadataProvider.js';

/** Only backend code can register adapters; operator-authorized descriptors are data, never imported code. */
export class ProviderRegistry {
  constructor(options = {}) {
    this.providers = new Map();
    this.options = options;
  }

  register(provider, authorization = {}) {
    if (authorization.trusted !== true)
      throw error(
        'PROVIDER_NOT_AUTHORIZED',
        'Executable provider adapters must be registered by trusted backend code.',
      );
    if (
      !provider ||
      !PROVIDER_ID.test(provider.id) ||
      ['isAvailable', 'search', 'resolve'].some((method) => typeof provider[method] !== 'function')
    )
      throw error(
        'INVALID_PROVIDER',
        'A provider requires an identity, availability probe, search, and resolver.',
      );
    if (
      !provider.capabilities ||
      typeof provider.capabilities.offline !== 'boolean' ||
      typeof provider.capabilities.network !== 'boolean' ||
      !provider.descriptor
    )
      throw error(
        'INVALID_PROVIDER',
        'A provider must declare source evidence and offline/network capabilities.',
      );
    if (this.providers.has(provider.id))
      throw error('DUPLICATE_PROVIDER', 'The provider identity is already registered.');
    if (this.providers.size >= 32)
      throw error('PROVIDER_LIMIT', 'At most 32 validated sources may be registered.');
    this.providers.set(provider.id, provider);
    return provider;
  }

  registerDescriptor(descriptor, authorization = {}) {
    if (authorization.approved !== true || authorization.approvedBy !== 'operator')
      throw error(
        'SOURCE_APPROVAL_REQUIRED',
        'Only an explicit operator source approval may register repositories.',
      );
    const validated = validateProviderDescriptor(descriptor);
    const provider = providerFromDescriptor(validated, this.options);
    return this.register(provider, { trusted: true });
  }

  get(id) {
    return this.providers.get(id);
  }
  list() {
    return [...this.providers.values()].map((provider) => ({
      id: provider.id,
      name: provider.descriptor.name || provider.id,
      kind: provider.descriptor.kind,
      capabilities: { ...provider.capabilities },
      origin: provider.descriptor.origin,
      trust: provider.descriptor.trust || 'approved',
    }));
  }

  async searchAll(rawQuery, { networkAllowed = false, signal, scope } = {}) {
    const query = sanitizeSoftwareQuery(rawQuery),
      candidates = [],
      failures = [];
    let requiresOnline = false;
    const eligible = [...this.providers.values()].filter(
      (p) => !query.sourceProviderId || p.id === query.sourceProviderId,
    );
    if (query.sourceProviderId && !eligible.length)
      failures.push({
        providerId: query.sourceProviderId,
        status: 'PROVIDER_NOT_FOUND',
        message: 'The selected provider is not registered. Choose an available source.',
      });
    const results = [],
      search = async (provider) => {
        signal?.throwIfAborted();
        if (provider.capabilities.network && !networkAllowed) {
          requiresOnline = true;
          return [];
        }
        if (!(await provider.isAvailable()))
          throw error(
            'PROVIDER_UNAVAILABLE',
            'This source is unavailable. Check its manager or approved repository configuration.',
          );
        signal?.throwIfAborted();
        const found = await provider.search(query, { signal, scope });
        if (!Array.isArray(found) || found.length > 100)
          throw error(
            'INVALID_PROVIDER_RESULTS',
            'The source did not return a bounded candidate list.',
          );
        return found.map((candidate) => {
          if (
            !candidate ||
            candidate.providerId !== provider.id ||
            typeof candidate.id !== 'string' ||
            typeof candidate.name !== 'string'
          )
            throw error(
              'INVALID_PROVIDER_RESULTS',
              'The source returned an invalid product identity.',
            );
          const normalized = {
            ...candidate,
            query,
            ...(candidate.resolvedPlan
              ? { resolvedPlan: validateInstallerPlan(candidate.resolvedPlan) }
              : {}),
          };
          if (normalized.resolvedPlan && normalized.resolvedPlan.source.providerId !== provider.id)
            throw error(
              'INVALID_PROVIDER_RESULTS',
              'The resolved plan belongs to a different provider.',
            );
          return deepFreeze(structuredClone(normalized));
        });
      };
    for (let start = 0; start < eligible.length; start += 3)
      results.push(...(await Promise.allSettled(eligible.slice(start, start + 3).map(search))));
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (result.status === 'fulfilled') candidates.push(...result.value);
      else {
        if (signal?.aborted || result.reason?.name === 'AbortError') throw result.reason;
        failures.push({
          providerId: eligible[index].id,
          status: result.reason?.code || 'SOURCE_FAILED',
          message: String(result.reason?.message || 'The source lookup failed.').slice(0, 500),
        });
      }
    }
    signal?.throwIfAborted();
    return { candidates, failures, requiresOnline };
  }

  async resolveCandidate(candidate, rawQuery = candidate?.query) {
    const provider = this.get(candidate?.providerId);
    if (!provider) throw error('PROVIDER_NOT_FOUND', 'The source is no longer registered.');
    const query = sanitizeSoftwareQuery(rawQuery);
    // Discovery approval covers manifest lookup. Resolve must never silently start another online request.
    if (provider.capabilities.network && !candidate.resolvedPlan)
      throw error(
        'ONLINE_RESOLUTION_REQUIRED',
        "Approve a new online discovery to obtain this source's verified metadata.",
      );
    const plan = validateInstallerPlan(
      candidate.resolvedPlan || (await provider.resolve({ ...candidate, query })),
    );
    if (
      plan.source.providerId !== provider.id ||
      plan.product.id !== candidate.id ||
      plan.operation !== query.operation
    )
      throw error(
        'PLAN_IDENTITY_MISMATCH',
        'The plan does not match the selected product and action.',
      );
    return plan;
  }
}
