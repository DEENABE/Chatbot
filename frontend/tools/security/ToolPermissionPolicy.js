import { validateRequest, validateParameters } from './ToolRequestValidator.js';
import { modelPolicy, isAllowedLegacyProcess } from '../repair/contract.js';
const messages = {
  APPROVAL_REQUIRED: 'This action changes current system state. Review it and allow it once.',
  CRITICAL_OPERATION: 'This critical operation is blocked.',
  AUTH_CONTEXT_REQUIRED: 'An authenticated execution context is required.',
  SENSITIVE_READ: 'Access to credential or secret locations is blocked.',
  DISALLOWED_PATH: 'This location is outside the approved document scope.',
  MCP_WRITE_NOT_ALLOWED: 'MCP only permits read-only tools.',
};
export class ToolPermissionPolicy {
  constructor({ registry, paths, available }) {
    this.registry = registry;
    this.paths = paths;
    this.available = available;
  }
  evaluate(request, context) {
    let definition;
    const result = (decision, reasonCode) => ({
      decision,
      risk: reasonCode === 'CRITICAL_OPERATION' ? 'CRITICAL' : (definition?.risk ?? null),
      reasonCode,
      userMessage: messages[reasonCode] || reasonCode,
      auditMetadata: { tool: definition?.name ?? null },
    });
    try {
      if (!validateRequest(request)) return result('DENY', 'INVALID_PARAMS');
      definition = this.registry.get(`${request.tool}.${request.action}`);
      if (!definition) return result('DENY', 'UNKNOWN_TOOL');
      if (context?.transport === 'MCP' || definition.transport === 'MCP') {
        if (definition.risk !== 'READ') return result('DENY', 'MCP_WRITE_NOT_ALLOWED');
        if (!definition.mcpExposed) return result('DENY', 'TOOL_BLOCKED');
      }
      if (definition.risk === 'CRITICAL') return result('DENY', 'CRITICAL_OPERATION');
      if (definition.transport === 'BLOCKED') return result('DENY', 'TOOL_BLOCKED');
      if (
        context?.authenticated !== true ||
        !/^(backend|renderer):[A-Za-z0-9-]{1,100}$/.test(context.scope || '') ||
        !context.taskId
      )
        return result('DENY', 'AUTH_CONTEXT_REQUIRED');
      if (!definition.allowedScopes.includes(context.scope.split(':')[0]))
        return result('DENY', 'AUTH_CONTEXT_REQUIRED');
      if (!validateParameters(definition, request.params ?? {}))
        return result('DENY', 'INVALID_PARAMS');
      if (context.origin === 'model' && context.modelRoute !== 'windows')
        return result('DENY', 'MODEL_ROUTE_DENIED');
      const p = request.params ?? {};
      if (request.tool === 'file') this.paths.validateParameters(definition.name, p);
      if (
        request.tool === 'services' &&
        definition.risk !== 'READ' &&
        /^(windefend|mpssvc|sense|wscsvc|securityhealthservice|wuauserv|eventlog)$/i.test(p.name)
      )
        return result('DENY', 'CRITICAL_OPERATION');
      // Generic registry manipulation is restricted to an app-owned subtree.
      if (
        request.tool === 'registry' &&
        !/^HKCU\\Software\\Chanakya(?:\\[A-Za-z0-9 _.-]+)*$/i.test(p.keyPath)
      )
        return result('DENY', definition.risk === 'READ' ? 'SENSITIVE_READ' : 'CRITICAL_OPERATION');
      if (
        request.tool === 'registry' &&
        !['Theme', 'Language', 'WindowState'].includes(p.valueName) &&
        p.valueName !== undefined
      )
        return result('DENY', 'INVALID_TARGET');
      if (
        request.tool === 'process' &&
        request.action === 'startProcess' &&
        !isAllowedLegacyProcess(p)
      )
        return result('DENY', 'INVALID_TARGET');
      if (context.origin === 'model' && modelPolicy(request.tool, request.action, p))
        return result('DENY', 'MODEL_CAPABILITY_DENIED');
      if (!this.available(request.tool, request.action))
        return result('DENY', 'CAPABILITY_NOT_AVAILABLE');
      return definition.risk === 'DANGEROUS'
        ? result('REQUIRE_APPROVAL', 'APPROVAL_REQUIRED')
        : result('ALLOW', 'POLICY_ALLOWED');
    } catch (error) {
      return result(
        'DENY',
        ['DISALLOWED_PATH', 'SENSITIVE_READ', 'INVALID_TARGET', 'CRITICAL_OPERATION'].includes(
          error.code,
        )
          ? error.code
          : 'POLICY_ERROR',
      );
    }
  }
}
