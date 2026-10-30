import {
  desktopHelperArguments,
  desktopHelperEnvironment,
  powerShellPath,
} from '../DesktopRuntime.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BaseToolService } from '../BaseToolService.js';
import { systemProcessNames } from '../apps/WindowsSystemCapabilityRegistry.js';
import { execFile, checkCancellation } from '../ExecutionContext.js';
const expressionPattern = '^\\d{1,12}(?:\\.\\d{1,8})?\\s*[+*/×÷-]\\s*\\d{1,12}(?:\\.\\d{1,8})?$';
export class UIAutomationService extends BaseToolService {
  constructor(gate, appService, { runner } = {}) {
    super('uiAutomation', gate);
    this.appService = appService;
    this.runner = runner || this.run.bind(this);
    this.busy = false;
    this.locate = runner
      ? async () => null
      : (input) =>
          this.run(input).catch((error) => {
            if (error.message === 'UI_WINDOW_NOT_FOUND') return null;
            throw error;
          });
  }
  get actions() {
    const schema = {
      query: { type: 'string', required: true, maxLength: 200 },
      windowTitle: { type: 'string', maxLength: 300 },
      automationId: { type: 'string', maxLength: 300 },
      controlName: { type: 'string', maxLength: 300 },
      controlType: { type: 'string', maxLength: 50 },
      className: { type: 'string', maxLength: 100 },
    };
    const generic = Object.fromEntries(
      [
        'findWindow',
        'waitForWindow',
        'isWindowOpen',
        'focusWindow',
        'listControls',
        'findControl',
        'waitForControl',
        'readText',
        'navigateControl',
      ].map((action) => [
        action,
        {
          schema,
          handler: (p) => this.generic(action, p),
          destructive: false,
          description: `${action} through Windows accessibility; resolve query to an installed app. Sensitive controls are excluded.`,
        },
      ]),
    );
    return {
      ...generic,
      calculate: {
        schema: {
          requireActive: { type: 'boolean' },
          expression: {
            type: 'string',
            required: true,
            maxLength: 60,
            pattern: expressionPattern,
          },
        },
        handler: (p) => this.perform('calculate', p),
        destructive: false,
        description:
          'Use the real Windows Calculator buttons and read its displayed result. Supports two positive numbers with + - * /.',
      },
      typeInNotepad: {
        schema: {
          text: {
            type: 'string',
            required: true,
            minLength: 1,
            maxLength: 4000,
          },
        },
        handler: (p) => this.perform('typeInNotepad', p),
        destructive: false,
        description:
          'Open Notepad and enter text into an empty editor, verifying the text. Existing nonempty documents are never replaced.',
      },
    };
  }
  async generic(action, params) {
    const resolved = await this.appService.resolve(params.query);
    if (!resolved.success)
      throw Object.assign(new Error(resolved.message), {
        code: resolved.status,
      });
    if (!resolved.app.executablePath && !resolved.app.appUserModelId)
      throw Object.assign(
        new Error('Generic inspection currently requires an executable identity.'),
        { code: 'UI_UNSUPPORTED_APP' },
      );
    const evidence = await this.run(
      {
        action,
        ...params,
        executablePath: resolved.app.executablePath,
        appUserModelId: resolved.app.appUserModelId,
        ...(resolved.app.source === 'windows_system'
          ? {
              windowTitle: resolved.app.windowTitle,
              systemProcessNames: /settings|^control-panel$|^file-explorer$/.test(resolved.app.id)
                ? systemProcessNames(resolved.app)
                : undefined,
            }
          : {}),
      },
      'GenericUI.ps1',
    );
    return evidence;
  }
  async perform(action, params) {
    if (this.busy)
      throw Object.assign(new Error('Another desktop action is running. Wait for it to finish.'), {
        code: 'UI_BUSY',
      });
    this.busy = true;
    try {
      checkCancellation();
      const query = action === 'calculate' ? 'Calculator' : 'Notepad';
      const resolved = await this.appService.resolve(query);
      if (!resolved.success)
        throw Object.assign(new Error(resolved.message || resolved.status), {
          code: resolved.status,
        });
      if (params.requireActive) {
        const active = await this.generic('findWindow', { query });
        if (!active.foreground)
          throw Object.assign(
            new Error('Calculator is not the active window. Specify the application.'),
            { code: 'ACTIVE_APP_MISMATCH' },
          );
      }
      const aumid = resolved.app.appUserModelId;
      const expected =
        action === 'calculate'
          ? /^Microsoft\.WindowsCalculator_8wekyb3d8bbwe!App$/i
          : /^Microsoft\.WindowsNotepad_8wekyb3d8bbwe!App$/i;
      if (!expected.test(aumid || ''))
        throw Object.assign(
          new Error(
            'This installed application does not match a supported Windows UI automation identity.',
          ),
          { code: 'UI_UNSUPPORTED_APP' },
        );
      let existing = await this.locate({
        action: 'locate',
        processId: this.lastProcessIds?.[aumid] || 0,
        appUserModelId: aumid,
      });
      if (!existing && this.lastProcessIds?.[aumid])
        existing = await this.locate({
          action: 'locate',
          processId: 0,
          appUserModelId: aumid,
        });
      const opened = existing?.processId
        ? { success: true, processId: existing.processId }
        : await this.appService.openApp({ query });
      if (!opened.success && opened.status !== 'APP_LAUNCH_UNVERIFIED')
        throw Object.assign(new Error(opened.message), { code: opened.status });
      checkCancellation();
      const input = { ...params };
      if (action === 'calculate')
        input.expression = params.expression.replace(/×/g, '*').replace(/÷/g, '/');
      const evidence = await this.runner({
        action,
        processId: opened.processId || 0,
        appUserModelId: aumid,
        ...input,
      });
      if (
        !Number.isInteger(evidence.processId) ||
        evidence.processId < 1 ||
        evidence.appUserModelId !== aumid ||
        evidence.verification?.status !== 'verified'
      )
        throw Object.assign(new Error('The application UI action could not be verified.'), {
          code: 'UI_UNVERIFIED',
        });
      if (
        action === 'calculate' &&
        (evidence.expression !== input.expression ||
          !evidence.displayText ||
          evidence.verification.criterion !== 'calculator_display')
      )
        throw Object.assign(
          new Error('Calculator result evidence did not match the requested expression.'),
          { code: 'UI_UNVERIFIED' },
        );
      if (action === 'typeInNotepad' && evidence.verification.criterion !== 'notepad_text')
        throw Object.assign(new Error('Notepad text was not verified.'), {
          code: 'UI_UNVERIFIED',
        });
      this.lastProcessIds = {
        ...this.lastProcessIds,
        [aumid]: evidence.processId,
      };
      if (action === 'calculate') evidence.expression = params.expression;
      return {
        ...evidence,
        success: true,
        status: 'UI_ACTION_COMPLETED',
        message:
          action === 'calculate'
            ? `Windows Calculator shows ${evidence.displayText} for ${params.expression}.`
            : 'Entered the requested text in Notepad and verified it in the editor.',
      };
    } finally {
      this.busy = false;
    }
  }
  run(input, script = 'InteractWithApp.ps1') {
    return new Promise((resolve, reject) => {
      const child = execFile(
        powerShellPath(),
        desktopHelperArguments(script, {
          apartment: script === 'DesktopUI.ps1' ? 'MTA' : 'STA',
        }),
        {
          windowsHide: true,
          env: desktopHelperEnvironment(),
          timeout: script === 'DesktopUI.ps1' ? 45000 : 20000,
          maxBuffer: input.action === 'capture' ? 24 * 1024 * 1024 : 256 * 1024,
          encoding: 'utf8',
        },
        (error, out, stderr) => {
          if (process.env.CHANAKYA_DEBUG_UI === '1' && stderr)
            console.warn('[desktop native]', stderr.trim());
          if (error)
            return reject(
              Object.assign(
                new Error(
                  'UI automation failed or timed out. No completion is claimed; check the application before retrying.',
                ),
                { code: 'UI_EXECUTION_FAILED' },
              ),
            );
          try {
            const result = JSON.parse(out.replace(/^\uFEFF/, ''));
            if (!result.success)
              return reject(
                Object.assign(new Error(result.message), {
                  code: result.code || 'UI_EXECUTION_FAILED',
                }),
              );
            resolve(result);
          } catch (e) {
            reject(e);
          }
        },
      );
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(input));
    });
  }
}
