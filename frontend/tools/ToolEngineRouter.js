import path from 'node:path';
import { desktopCapabilityDiagnostics, isDesktopTool } from './DesktopCapabilityDiagnostics.js';
import { AppInspectorService } from './services/AppInspectorService.js';
import { GenericDesktopService } from './services/GenericDesktopService.js';
import { BrowserAutomationService } from './services/BrowserAutomationService.js';
/**
 * @module ToolEngineRouter
 * @description Central dispatcher for the Tool Engine.
 * Routes incoming `{ tool, action, params }` requests to the appropriate
 * service, handles the confirmation flow for destructive actions, and
 * exposes an introspection API for listing all available tools and actions.
 */

import { ConfirmationGate } from './ConfirmationGate.js';
import { executionContext, checkCancellation } from './ExecutionContext.js';
import { modelPolicy } from './repair/contract.js';
import { WindowsRepairService } from './services/WindowsRepairService.js';
import { UIAutomationService } from './services/UIAutomationService.js';
import { AppService } from './services/AppService.js';
import { WingetService } from './services/WingetService.js';
import { WebInstallService } from './services/WebInstallService.js';
import { SoftwareService } from './services/SoftwareService.js';
import { SystemSettingsService } from './services/SystemSettingsService.js';
import { SettingsWorker } from './services/SettingsWorker.js';
import { SettingsElevator } from './services/SettingsElevator.js';
import { PendingAppChoiceStore } from './apps/PendingAppChoiceStore.js';
import { createToolRegistry } from './security/ToolRegistry.js';
import { PathPolicy } from './security/PathPolicy.js';
import { ToolPermissionPolicy } from './security/ToolPermissionPolicy.js';
import { ToolExecutionGuard } from './security/ToolExecutionGuard.js';
import { SecurityAudit } from './security/SecurityAudit.js';
import { validateRequest, plain } from './security/ToolRequestValidator.js';

// ─── Service imports (will be implemented in separate files) ──────────
import { FileService } from './services/FileService.js';
import { PowerShellService } from './services/PowerShellService.js';
import { CmdService } from './services/CmdService.js';
import { WinServicesService } from './services/WinServicesService.js';
import { RegistryService } from './services/RegistryService.js';
import { HardwareService } from './services/HardwareService.js';
import { ProcessService } from './services/ProcessService.js';
import { NetworkService } from './services/NetworkService.js';
import { ExplorerToolService } from './fileexplorer/ExplorerToolService.js';

/**
 * @typedef {Object} ToolRequest
 * @property {string} tool - The tool name (e.g., 'file', 'powershell') or '_system' for internal commands.
 * @property {string} action - The action to perform (e.g., 'read', 'confirm').
 * @property {Object} params - Parameters for the action.
 */

/**
 * @typedef {Object} ToolResponse
 * @property {boolean} success - Whether the operation succeeded.
 * @property {*} [data] - Response payload (on success).
 * @property {boolean} [needsConfirmation] - True if the action is awaiting user confirmation.
 * @property {string} [confirmationId] - The confirmation ID (when needsConfirmation is true).
 * @property {string} [message] - Human-readable message (confirmation prompt or info).
 * @property {{code: string, message: string}} [error] - Error details (on failure).
 */

/**
 * Service registry entry — maps a tool name to its constructor.
 * @type {Array<[string, typeof import('./BaseToolService.js').BaseToolService]>}
 */
const SERVICE_REGISTRY = [
  ['file', FileService],
  ['powershell', PowerShellService],
  ['cmd', CmdService],
  ['services', WinServicesService],
  ['registry', RegistryService],
  ['hardware', HardwareService],
  ['process', ProcessService],
  ['network', NetworkService],
  ['app', AppService],
];

export class ToolEngineRouter {
  /**
   * Create a new ToolEngineRouter.
   * Instantiates a shared {@link ConfirmationGate} and all 8 tool services.
   */
  constructor({
    confirmationDirectory,
    repairOptions,
    pathOptions,
    auditDirectory,
    appOptions,
    desktopRuntime,
    appChoices,
    desktopOptions,
    softwareOptions,
    explorerOptions,
  } = {}) {
    /** @type {ConfirmationGate} */
    this.gate = new ConfirmationGate({ directory: confirmationDirectory });
    /** Application choices waiting for the user (see _offerAppChoice / _handleAppChoice). */
    this.appChoices = new PendingAppChoiceStore(appChoices);

    /** @type {Map<string, import('./BaseToolService.js').BaseToolService>} */
    this.services = new Map();

    for (const [name, ServiceClass] of SERVICE_REGISTRY) {
      this.services.set(name, new ServiceClass(this.gate));
    }
    if (appOptions) {
      const appService = new AppService(this.gate, {
        ...appOptions,
        processService: this.services.get('process'),
      });
      this.services.set('app', appService);
      appService.registry
        .initialize()
        .catch((error) => console.warn('[AppRegistry] Refresh failed:', error.message));
    }
    if (repairOptions)
      this.services.set('windowsRepair', new WindowsRepairService(this.gate, repairOptions));
    this.services.set('uiAutomation', new UIAutomationService(this.gate, this.services.get('app')));
    this.services.get('app').uiService = this.services.get('uiAutomation');
    this.services.get('app').uiFallback ||= async ({ app, target }) => {
      if (app.source === 'windows_system' || !app.executablePath)
        return {
          success: false,
          status: 'APP_CAPABILITY_UNSUPPORTED',
          message: 'No safe target-opening profile for this interface.',
        };
      try {
        await this.services.get('process').launchApp(app);
        const evidence = await this.services
          .get('uiAutomation')
          .run({ executablePath: app.executablePath, target }, 'OpenTargetUI.ps1');
        return {
          ...evidence,
          status: 'APP_TARGET_OPENED',
          app: { id: app.id, name: app.name },
          target,
          strategy: 'UI_AUTOMATION',
          message: `${target.path} is open in ${app.name}.`,
        };
      } catch (error) {
        return {
          success: false,
          status: 'UI_FALLBACK_FAILED',
          message: error.message,
        };
      }
    };
    this.services.set(
      'browser',
      new BrowserAutomationService(this.gate, this.services.get('app'), {
        directory: appOptions?.directory ? path.join(appOptions.directory, 'browser') : undefined,
      }),
    );
    this.services.set(
      'inspector',
      new AppInspectorService(
        this.gate,
        this.services.get('app'),
        this.services.get('uiAutomation'),
      ),
    );
    this.services.set(
      'desktop',
      new GenericDesktopService(
        this.gate,
        this.services.get('app'),
        this.services.get('uiAutomation'),
        desktopOptions,
      ),
    );
    // Simple natural-language launches also bind/read the verified window through the existing inspector.
    this.services.get('app').launchObserver = (params) =>
      this.services.get('desktop').observe(params, false);
    this.services.set(
      'systemSettings',
      new SystemSettingsService(this.gate, this.services.get('uiAutomation'), {
        worker: new SettingsWorker(),
        elevator: new SettingsElevator(),
      }),
    );
    // Drives, folder listing/sizes (read-only, per-location approval) and opening folder windows.
    this.services.set('explorer', new ExplorerToolService(this.gate, explorerOptions));
    this.services.set(
      'winget',
      new WingetService(this.gate, { appService: this.services.get('app') }),
    );
    this.services.set(
      'webInstall',
      new WebInstallService(this.gate, {
        appService: this.services.get('app'),
      }),
    );
    this.services.set(
      'software',
      new SoftwareService(this.gate, { ...softwareOptions, appService: this.services.get('app') }),
    );
    this.registry = createToolRegistry(this.services);
    this.desktopRuntime = desktopRuntime;
    this.desktopDiagnostics = desktopCapabilityDiagnostics(this, {
      runtime: desktopRuntime,
    });
    this.ready = Promise.resolve(this.desktopDiagnostics.desktopControl);
    this.paths = new PathPolicy(pathOptions);
    this.audit = new SecurityAudit(auditDirectory);
    this.policy = new ToolPermissionPolicy({
      registry: this.registry,
      paths: this.paths,
      available: (tool, action) =>
        (!isDesktopTool(tool) || this.desktopDiagnostics.desktopControl.ready) &&
        this.services
          .get(tool)
          ?.getActionList()
          .some((a) => a.action === action),
    });
    this.guard = new ToolExecutionGuard({
      policy: this.policy,
      gate: this.gate,
      audit: this.audit,
    });
  }

  /**
   * Dispatch a tool request to the appropriate service.
   *
   * Special handling for `_system` tool:
   * - `confirm` action: resolves a pending confirmation and executes the original action.
   *
   * @param {ToolRequest} request - The incoming tool request.
   * @param {import('electron').WebContents} [sender] - Electron WebContents for pushing
   *   confirmation-required events to the renderer process.
   * @returns {Promise<ToolResponse>} The tool response envelope.
   */
  async dispatch(request, sender) {
    try {
      checkCancellation();
      const { tool, action, params } = request || {};
      const context = executionContext.getStore();
      if (!validateRequest(request))
        return ToolEngineRouter._errorEnvelope(
          'INVALID_PARAMS',
          'Only a typed tool proposal is accepted.',
        );

      // ── System commands ──────────────────────────────────────────
      if (tool === '_system') {
        const systemKeys =
          action === 'chooseApp'
            ? ['choiceId', 'candidateId']
            : action === 'cancelAppChoice'
              ? ['choiceId']
              : ['confirmationId'];
        if (!plain(params ?? {}) || Object.keys(params ?? {}).some((k) => !systemKeys.includes(k)))
          return ToolEngineRouter._errorEnvelope('INVALID_PARAMS', 'Invalid system request.');
        if (action === 'chooseApp') return await this._handleAppChoice(params);
        if (action === 'cancelAppChoice') {
          const cancelled = this.appChoices.cancel(params?.choiceId, {
            scope: context?.scope,
            taskId: context?.taskId,
          });
          return cancelled.ok
            ? { success: true }
            : ToolEngineRouter._errorEnvelope(
                'APP_CHOICE_INVALID',
                'No pending application choice to cancel.',
              );
        }
        if (action === 'confirm') {
          return await this._handleConfirmation(params);
        }
        if (action === 'cancel') {
          if (
            this.gate.getPending(params?.confirmationId)?.scope !==
            executionContext.getStore()?.scope
          )
            return ToolEngineRouter._errorEnvelope(
              'CONFIRMATION_FAILED',
              'Confirmation belongs to another execution scope.',
            );
          const result = this.gate.cancel(params?.confirmationId);
          return result.success
            ? { success: true }
            : ToolEngineRouter._errorEnvelope('CONFIRMATION_FAILED', result.error);
        }
        if (action === 'getTools') {
          // Return the raw tool map — the renderer maps it to the model's
          // tool schema. (This is what lets the AI actually call tools.)
          return this.getTools({ model: context?.origin === 'model' });
        }
        return ToolEngineRouter._errorEnvelope(
          'UNKNOWN_SYSTEM_ACTION',
          `Unknown system action: '${action}'`,
        );
      }

      if (isDesktopTool(tool))
        this.desktopDiagnostics = desktopCapabilityDiagnostics(this, {
          runtime: this.desktopRuntime,
          requestedTool: `${tool}.${action}`,
        });
      const decision = this.guard.check(request, context);
      if (decision.decision === 'DENY')
        return {
          ...ToolEngineRouter._errorEnvelope(decision.reasonCode, decision.userMessage),
          permission: decision,
        };
      // ── Look up the service ────────────────────────────────────
      const service = this.services.get(tool);
      if (!service) {
        return ToolEngineRouter._errorEnvelope('TOOL_NOT_FOUND', `Unknown tool: '${tool}'`);
      }

      // ── Execute the action ─────────────────────────────────────
      // A second evaluation immediately precedes the service call. No await is
      // allowed between this final check and the synchronous handler admission.
      const finalDecision = this.guard.check(request, context);
      if (finalDecision.decision === 'DENY')
        return ToolEngineRouter._errorEnvelope(finalDecision.reasonCode, finalDecision.userMessage);
      if (
        finalDecision.decision === 'REQUIRE_APPROVAL' &&
        tool !== 'windowsRepair' &&
        service.actions[action]?.destructive !== true
      )
        return ToolEngineRouter._errorEnvelope(
          'POLICY_ERROR',
          'A dangerous action requires an approval gate.',
        );
      const signal = AbortSignal.any([
        ...(context.signal ? [context.signal] : []),
        AbortSignal.timeout(this.registry.get(`${tool}.${action}`).timeout),
      ]);
      // An ambiguous application lookup anywhere below reports itself through this sink instead of failing the call outright.
      const sink = {};
      let result;
      try {
        result = await executionContext.run(
          { ...context, signal, pathPolicy: this.paths, appChoiceSink: sink },
          () => service.execute(action, structuredClone(params ?? {})),
        );
      } catch (error) {
        if (error?.code !== 'AMBIGUOUS_APP' || !sink.appChoice) throw error;
        result = ToolEngineRouter._errorFromException(error);
      }
      if (finalDecision.decision === 'ALLOW')
        result = this._offerAppChoice(
          result,
          sink,
          { tool, action, params: structuredClone(params ?? {}) },
          context,
        );
      if (finalDecision.decision === 'REQUIRE_APPROVAL' && !result.needsConfirmation)
        throw Object.assign(new Error('Dangerous service omitted its approval gate.'), {
          code: 'POLICY_ERROR',
        });
      const runtimeRisk =
        result.needsConfirmation && this.gate.getRecord(result.confirmationId)?.metadata?.risk;
      const effectiveDecision =
        runtimeRisk === 'DANGEROUS'
          ? {
              ...finalDecision,
              risk: 'DANGEROUS',
              decision: 'REQUIRE_APPROVAL',
              reasonCode: 'OBSERVED_ACTION_APPROVAL_REQUIRED',
            }
          : finalDecision;
      result.permission = effectiveDecision;
      if (result.needsConfirmation)
        result.approvalDetails = {
          ...result.approvalDetails,
          risk: effectiveDecision.risk,
          action: `${tool}.${action}`,
          reason:
            result.approvalDetails?.reason || 'The requested action changes current system state.',
          impact: result.message,
        };
      this.audit.record(
        request,
        context,
        effectiveDecision,
        result.needsConfirmation
          ? 'awaiting_approval'
          : result.needsAppChoice
            ? 'awaiting_app_choice'
            : result.success
              ? 'completed'
              : 'failed',
        null,
        result,
      );

      // If the action requires confirmation, notify the renderer
      if (result.needsConfirmation && sender && typeof sender.send === 'function') {
        sender.send('tool:confirmation-required', {
          confirmationId: result.confirmationId,
          message: result.message,
          tool,
          action,
          approvalDetails: result.approvalDetails,
        });
      }

      return result;
    } catch (err) {
      return ToolEngineRouter._errorFromException(err);
    }
  }

  /**
   * Return a map of all registered tools and their action lists.
   * Useful for introspection, help commands, and auto-generating UI.
   *
   * @returns {Object<string, Array<{action: string, description: string, destructive: boolean}>>}
   */
  getTools({ model = false } = {}) {
    this.desktopDiagnostics = desktopCapabilityDiagnostics(this, {
      runtime: this.desktopRuntime,
    });
    const tools = {};
    for (const [name, service] of this.services) {
      if (isDesktopTool(name) && !this.desktopDiagnostics.desktopControl.ready) {
        tools[name] = [];
        continue;
      }
      tools[name] = service
        .getActionList()
        .filter(
          (a) =>
            this.registry.get(`${name}.${a.action}`)?.transport !== 'BLOCKED' &&
            (!model ||
              (name !== 'windowsRepair' &&
                !modelPolicy(
                  name,
                  a.action,
                  name === 'process' && a.action === 'startProcess'
                    ? { command: 'notepad.exe' }
                    : name === 'app'
                      ? { app: 'notepad.exe' }
                      : {},
                ))),
        )
        .map((a) => ({
          ...a,
          risk: this.registry.get(`${name}.${a.action}`).risk,
        }));
    }
    return tools;
  }

  // ─── Private helpers ────────────────────────────────────────────────

  /**
   * Handle a `_system.confirm` request: look up the pending confirmation,
   * confirm it through the gate, then execute the original action.
   *
   * @param {Object} params - Must contain `{ confirmationId }`.
   * @returns {Promise<ToolResponse>}
   * @private
   */
  async _handleConfirmation(params) {
    const { confirmationId } = params || {};

    if (!confirmationId) {
      return ToolEngineRouter._errorEnvelope(
        'MISSING_CONFIRMATION_ID',
        'params.confirmationId is required for _system.confirm',
      );
    }

    const pending = this.gate.getRecord(confirmationId)?.metadata;
    if (pending?.scope !== executionContext.getStore()?.scope) {
      return ToolEngineRouter._errorEnvelope(
        'APPROVAL_INVALID',
        'Confirmation not owned by this caller.',
      );
    }
    const context = executionContext.getStore();
    if (!pending)
      return ToolEngineRouter._errorEnvelope('APPROVAL_INVALID', 'Approval is unavailable.');
    const originalRequest = {
      tool: pending.tool,
      action: pending.action,
      params: pending.params,
    };
    // Runtime-grounded primitives can escalate from SAFE_WRITE to DANGEROUS.
    // Every confirmation must bind a real human, caller, task and exact params,
    // even when the registry's baseline risk did not itself require approval.
    const invalidApproval = this.gate.validateApproval(confirmationId, originalRequest, context);
    if (invalidApproval)
      return ToolEngineRouter._errorEnvelope(
        invalidApproval,
        'A matching, unexpired human approval is required.',
      );
    let permission = this.guard.check(originalRequest, context, confirmationId);
    if (pending.risk === 'DANGEROUS' && permission.decision === 'ALLOW')
      permission = {
        ...permission,
        risk: 'DANGEROUS',
        reasonCode: 'APPROVAL_VALID',
      };
    if (permission.decision !== 'ALLOW')
      return {
        ...ToolEngineRouter._errorEnvelope(permission.reasonCode, permission.userMessage),
        permission,
      };
    if (pending?.tool === 'windowsRepair') {
      const c = executionContext.getStore();
      if (c?.humanApproved !== true || pending.sessionId !== c?.admission?.sessionId)
        return ToolEngineRouter._errorEnvelope(
          'HUMAN_APPROVAL_REQUIRED',
          'Matching human approval and session are required.',
        );
    }
    // Confirm through the gate — returns { success, metadata } or { success: false, error }
    const gateResult = this.gate.confirm(confirmationId);

    if (!gateResult.success) {
      return ToolEngineRouter._errorEnvelope('CONFIRMATION_FAILED', gateResult.error);
    }

    const { tool, action, params: originalParams } = gateResult.metadata;

    // Look up the service and execute the confirmed action
    const service = this.services.get(tool);
    if (!service) {
      return ToolEngineRouter._errorEnvelope(
        'TOOL_NOT_FOUND',
        `Service '${tool}' not found when executing confirmed action`,
      );
    }

    try {
      // Re-evaluate the current policy after consumption; approval stays spent
      // even when a service's own fresh precondition check rejects execution.
      const current = this.policy.evaluate(originalRequest, context);
      if (current.decision === 'DENY')
        return ToolEngineRouter._errorEnvelope(current.reasonCode, current.userMessage);
      const signal = AbortSignal.any([
        ...(context.signal ? [context.signal] : []),
        AbortSignal.timeout(this.registry.get(`${tool}.${action}`).timeout),
      ]);
      const result = await executionContext.run(
        { ...context, signal, pathPolicy: this.paths },
        () => service.executeConfirmed(action, originalParams, gateResult.metadata),
      );
      this.audit.record(
        originalRequest,
        context,
        permission,
        result.success ? 'completed' : 'failed',
        null,
        result,
      );
      result.permission = permission;
      return result;
    } catch (err) {
      return ToolEngineRouter._errorFromException(err);
    }
  }

  /**
   * Turns an AMBIGUOUS_APP failure into a pending user choice. The choice keeps the exact tool call so that answering it
   * re-runs that call (not a new chat request) with the picked application bound. Anything else is returned unchanged.
   *
   * @param {ToolResponse} result
   * @param {{appChoice?: object}} sink - Filled by AppService when a lookup was ambiguous.
   * @param {ToolRequest} origin
   * @param {object} context - The execution context that made the call.
   * @returns {ToolResponse}
   * @private
   */
  _offerAppChoice(result, sink, origin, context) {
    if (result?.success !== false || result.error?.code !== 'AMBIGUOUS_APP' || !sink?.appChoice)
      return result;
    const { requestedApp, candidates, message } = sink.appChoice;
    return this._pendingAppChoice(origin, context, requestedApp, candidates, message);
  }

  _pendingAppChoice(origin, context, requestedApp, candidates, message, refreshed = false) {
    const choice = this.appChoices.create({
      scope: context?.scope,
      taskId: context?.taskId,
      origin,
      requestedApp,
      candidates,
    });
    const text =
      message ||
      `Which application do you mean: ${choice.candidates.map((c) => c.displayName).join(', ')}?`;
    return {
      success: false,
      needsAppChoice: true,
      choiceId: choice.choiceId,
      expiresAt: choice.expiresAt,
      requestedApp,
      candidates: choice.candidates,
      ...(refreshed ? { refreshed: true } : {}),
      message: text,
      error: { code: 'APP_CHOICE_REQUIRED', message: text },
    };
  }

  /**
   * Handle `_system.chooseApp`: bind the picked candidate to the pending call and run that call, with no model and no new
   * fuzzy matching. Only a person can answer (humanApproved), only for a choice raised by this execution, only once.
   * The original call's permission is re-evaluated, and every service-level check (app permission level, launch target
   * policy, desktop/browser admission) runs as it would for a normal call because the service is simply re-invoked.
   *
   * @param {{choiceId: string, candidateId: string}} params
   * @returns {Promise<ToolResponse>}
   * @private
   */
  async _handleAppChoice(params) {
    const { choiceId, candidateId } = params || {};
    const context = executionContext.getStore();
    const fail = (code, message) => ToolEngineRouter._errorEnvelope(code, message);
    const valid = (v) => typeof v === 'string' && /^[A-Za-z0-9:._-]{1,120}$/.test(v);
    if (!valid(choiceId) || !valid(candidateId))
      return fail('INVALID_PARAMS', 'choiceId and candidateId are required.');
    if (context?.humanApproved !== true)
      return fail('HUMAN_APPROVAL_REQUIRED', 'An application choice must come from the user.');
    const claimed = this.appChoices.claim(choiceId, {
      scope: context.scope,
      taskId: context.taskId,
    });
    if (!claimed.ok) return fail(claimed.code, claimed.message);
    const choice = claimed.choice,
      origin = {
        tool: choice.origin.tool,
        action: choice.origin.action,
        params: structuredClone(choice.origin.params),
      };
    const release = (code, message) => {
      this.appChoices.release(choiceId);
      return fail(code, message);
    };
    try {
      const service = this.services.get(origin.tool),
        appService = this.services.get('app');
      if (!service || !appService?.bindChoice)
        return release(
          'TOOL_NOT_FOUND',
          `Service '${origin.tool}' not found for the pending application choice.`,
        );
      if (isDesktopTool(origin.tool))
        this.desktopDiagnostics = desktopCapabilityDiagnostics(this, {
          runtime: this.desktopRuntime,
          requestedTool: `${origin.tool}.${origin.action}`,
        });
      const decision = this.guard.check(origin, context);
      if (decision.decision !== 'ALLOW')
        return release(
          decision.reasonCode || 'PERMISSION_DENIED',
          decision.userMessage || 'The original action is no longer permitted.',
        );
      const definition = this.registry.get(`${origin.tool}.${origin.action}`);
      if (!definition)
        return release('TOOL_NOT_FOUND', 'The original action is no longer available.');
      const signal = AbortSignal.any([
        ...(context.signal ? [context.signal] : []),
        AbortSignal.timeout(definition.timeout),
      ]);
      const run = { ...context, signal, pathPolicy: this.paths };
      const outcome = await executionContext.run(run, async () => {
        const bound = await appService.bindChoice(choice, candidateId);
        if (!bound.ok) return { bound };
        const sink = {};
        let result;
        try {
          result = await executionContext.run(
            { ...run, appChoiceSink: sink, appBinding: bound.binding },
            () => service.execute(origin.action, origin.params),
          );
        } catch (error) {
          if (error?.code !== 'AMBIGUOUS_APP' || !sink.appChoice) throw error;
          result = ToolEngineRouter._errorFromException(error);
        }
        return {
          bound,
          result: this._offerAppChoice(result, sink, origin, context),
        };
      });
      if (!outcome.bound.ok) {
        const { code, message, stale, fresh } = outcome.bound;
        if (code !== 'APP_CHOICE_STALE') return release(code, message);
        // The picked application is gone. Ask again with what is installed now; never launch a different one unasked.
        this.appChoices.finish(choiceId, 'stale');
        const candidates = appService.freshCandidates(fresh);
        this.audit.record(origin, context, decision, 'app_choice_stale');
        if (!candidates.length)
          return fail(
            'APP_NOT_FOUND',
            `${stale?.displayName || choice.requestedApp} is no longer available and no other match was found.`,
          );
        const text = `${stale?.displayName || 'That application'} is no longer available. Please choose again.`;
        return {
          ...this._pendingAppChoice(origin, context, choice.requestedApp, candidates, text, true),
          permission: decision,
        };
      }
      this.appChoices.finish(choiceId, 'consumed');
      const { result } = outcome;
      this.audit.record(
        origin,
        context,
        decision,
        result.needsAppChoice ? 'awaiting_app_choice' : result.success ? 'completed' : 'failed',
        null,
        result,
      );
      result.permission = decision;
      return result;
    } catch (error) {
      this.appChoices.finish(choiceId, 'failed');
      return ToolEngineRouter._errorFromException(error);
    }
  }

  /**
   * Build a standardised error response envelope.
   *
   * @param {string} code - Machine-readable error code.
   * @param {string} message - Human-readable error message.
   * @returns {ToolResponse}
   * @private
   */
  static _errorEnvelope(code, message) {
    return {
      success: false,
      error: { code, message },
    };
  }

  /**
   * Convert a thrown exception into a standardised error envelope.
   *
   * @param {Error & {code?: string, errors?: Array}} err - The caught exception.
   * @returns {ToolResponse}
   * @private
   */
  static _errorFromException(err) {
    const envelope = {
      success: false,
      error: {
        code: err.code || 'INTERNAL_ERROR',
        message: err.message || 'An unexpected error occurred',
      },
    };

    // Attach validation details if present
    if (err.errors) {
      envelope.error.validationErrors = err.errors;
    }

    return envelope;
  }
}
