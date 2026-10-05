import { randomUUID, createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { catalog, validateOperation } from './catalog.mjs';
import { root } from './config.mjs';
import { runPowerShell } from './runner.mjs';

export const errorResult = (code, message, extra = {}) => ({ ok: false, error: { code, message, ...extra } });
export const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export class Executor {
  constructor(config, { runner = runPowerShell, audit, journal } = {}) {
    this.config = config;
    this.runner = runner;
    this.plans = new Map();
    this.tail = Promise.resolve();
    this.journal = journal;
    this.writeBlocked = journal?.writesBlocked || false;
    this.audit = audit || (journal ? async event => journal.append(event) : async event => {
      await mkdir(path.join(root, 'var'), { recursive: true });
      await appendFile(path.join(root, 'var', 'audit.jsonl'), JSON.stringify({ time: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
    });
  }
  serialize(task) {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => {});
    return result;
  }
  async dispatch(operation, parameters, signal, mode = 'execute', expectedBefore) {
    const options = { timeout: operation === 'updates.scan' ? 300000 : this.config.toolTimeout, signal };
    const request = { operation, parameters, mode, enableUia: this.config.uia, engine: 'direct', ...(expectedBefore !== undefined ? { expectedBefore } : {}) };
    const direct = await this.runner(request, options);
    // Only known capability absence can select fallback. Never retry a partial write or access denial through UIA.
    if (this.config.uia && catalog[operation]?.uri && !direct.ok && !direct.error?.outcomeUnknown && ['UNSUPPORTED_HARDWARE', 'API_UNAVAILABLE'].includes(direct.error?.code)) {
      return this.runner({ ...request, engine: 'uia' }, options);
    }
    return direct;
  }
  async policyCheck(id, parameters) {
    const policy = JSON.parse(await readFile(path.join(root, 'config', 'policy.json'), 'utf8'));
    if (id.startsWith('registry.')) {
      if (!Object.hasOwn(policy.registry, parameters.target)) throw new Error('Registry target is not allowlisted');
      const target = policy.registry[parameters.target];
      if (id === 'registry.set') {
        if (!target.writable) throw new Error('Registry target is read-only');
        if (target.type === 'DWord' && (!Number.isInteger(parameters.value) || parameters.value < target.min || parameters.value > target.max)) throw new Error('Registry value is outside target bounds');
        if (target.type === 'String' && (typeof parameters.value !== 'string' || !target.values.includes(parameters.value))) throw new Error('Registry value is not allowed for this target');
      }
    }
    if (id === 'service.set' && !policy.services.includes(parameters.name)) throw new Error('Service mutation is not allowlisted');
    if (['policy.get', 'policy.set'].includes(id) && !Object.hasOwn(policy.groupPolicy, parameters.target)) throw new Error('Local GPO target is not allowlisted');
    return { administratorRequired: catalog[id]?.admin || (id === 'registry.set' && policy.registry[parameters.target].path.startsWith('HKLM:')) };
  }
  async policyInfo(category) {
    if (category && !['registry', 'service', 'policy'].includes(category)) return {};
    const policy = JSON.parse(await readFile(path.join(root, 'config', 'policy.json'), 'utf8'));
    return {
      registryTargets: Object.entries(policy.registry).map(([id, target]) => ({ id, type: target.type, writable: target.writable, minimum: target.min, maximum: target.max, allowedValues: target.values, hive: target.path.split(':')[0] })),
      mutableServices: policy.services,
      localGpoTargets: Object.keys(policy.groupPolicy),
      lgpoConfigured: Boolean(policy.lgpo.path && policy.lgpo.sha256)
    };
  }
  async invoke(id, parameters, context) {
    try {
      const definition = validateOperation(id, parameters);
      const policyMetadata = await this.policyCheck(id, parameters);
      if (context.signal?.aborted) return errorResult('CANCELLED', 'Request cancelled');
      if (definition.risk === 'read') return await this.serialize(() => this.dispatch(id, parameters, context.signal));
      if (this.writeBlocked) return errorResult('WRITES_BLOCKED', 'An earlier operation had an unknown outcome. Inspect state and use the local operator recovery command before further changes.');
      if (!context.allowChanges) return errorResult('CHANGES_NOT_AUTHORIZED', 'This request is read-only. The trusted client must set allowChanges:true.');
      if (definition.risk === 'low' && this.config.autoLow) return await this.serialize(() => this.execute(id, parameters, context));
      return await this.serialize(async () => {
        for (const [key, plan] of this.plans) if (plan.expiresAt < Date.now()) this.plans.delete(key);
        if (this.plans.size >= 100) return errorResult('PLAN_LIMIT', 'Too many pending plans');
        const before = await this.dispatch(id, parameters, context.signal, 'preview');
        if (!before.ok) return before;
        const plan = { id: randomUUID(), sessionId: context.sessionId, operation: id, parameters: structuredClone(parameters), before: before.data, beforeHash: digest(before.data), expiresAt: Date.now() + 120000, status: 'pending', description: definition.description, administratorRequired: Boolean(policyMetadata.administratorRequired) };
        this.plans.set(plan.id, plan);
        await this.audit({ event: 'planned', planId: plan.id, sessionId: context.sessionId, operation: id });
        return { ok: true, status: 'approval_required', plan: this.publicPlan(plan) };
      });
    } catch (err) { return errorResult(err.code || 'VALIDATION_FAILED', err.message); }
  }
  publicPlan(plan) {
    const { beforeHash, ...visible } = plan;
    return structuredClone(visible);
  }
  async execute(id, parameters, context, planId, expectedBefore) {
    if (this.writeBlocked) return errorResult('WRITES_BLOCKED', 'Writes are blocked after an unknown outcome');
    const executionId = randomUUID();
    // Fail closed if the intent cannot be durably logged before a mutation.
    await this.audit({ event: 'execute_started', executionId, operation: id, sessionId: context.sessionId, planId, parametersHash: digest(parameters) });
    let result;
    try { result = await this.dispatch(id, parameters, context.signal, 'execute', expectedBefore); }
    catch (error) { this.writeBlocked = true; return errorResult('EXECUTION_INTERRUPTED', error.message, { outcomeUnknown: true, executionId }); }
    if (result.error?.outcomeUnknown) this.writeBlocked = true;
    try { await this.audit({ event: 'execute_finished', executionId, operation: id, sessionId: context.sessionId, planId, ok: result.ok, status: result.status, errorCode: result.error?.code, outcomeUnknown: Boolean(result.error?.outcomeUnknown) }); }
    catch { this.writeBlocked = true; return errorResult('AUDIT_FAILED_AFTER_EXECUTION', 'The operation ran but its completion could not be logged; inspect state before retrying.', { outcomeUnknown: true, operationResult: result }); }
    return result;
  }
  async approve(planId, sessionId, signal) {
    return this.serialize(async () => {
      const plan = this.plans.get(planId);
      if (!plan || plan.sessionId !== sessionId) return errorResult('PLAN_NOT_FOUND', 'Unknown plan');
      if (plan.status !== 'pending') return errorResult('PLAN_CONSUMED', 'This plan was already consumed; inspect state before creating another');
      if (plan.expiresAt < Date.now()) { plan.status = 'expired'; return errorResult('PLAN_EXPIRED', 'Request a fresh plan'); }
      validateOperation(plan.operation, plan.parameters);
      await this.policyCheck(plan.operation, plan.parameters);
      const now = await this.dispatch(plan.operation, plan.parameters, signal, 'preview');
      if (!now.ok) return now;
      if (digest(now.data) !== plan.beforeHash) { plan.status = 'stale'; return errorResult('STATE_CHANGED', 'The relevant state changed after planning. Create a fresh plan.'); }
      plan.status = 'consumed';
      return this.execute(plan.operation, plan.parameters, { sessionId, signal }, plan.id, plan.before);
    });
  }
}
