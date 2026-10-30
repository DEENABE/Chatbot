import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FileAssociationService } from '../apps/FileAssociationService.js';
import { resolveDocumentTarget, targetSchema } from '../apps/DocumentTarget.js';
import { capabilitiesFor } from '../apps/AppCapabilities.js';
import { BaseToolService } from '../BaseToolService.js';
import { ProcessService } from './ProcessService.js';
import { AppRegistryService } from '../apps/AppRegistryService.js';
import { validAppQuery, normalizeAppName } from '../apps/AppQueryNormalizer.js';
import { findAppForCandidate, toCandidate } from '../apps/AppCandidates.js';
import { AppResolverService } from '../apps/AppResolverService.js';
import { validateTarget } from '../apps/AppTargetPolicy.js';
import { checkCancellation, executionContext } from '../ExecutionContext.js';
import { AppPermissionStore, PERMISSION_LEVELS, levelSummary } from '../apps/AppPermissionStore.js';
import { isThirdPartyApp, isCatalogApp, catalogEntry, describeApp } from '../apps/AppCatalog.js';
const publicApp = (a) => ({
  id: a.id,
  name: a.name,
  publisher: a.publisher,
  version: a.version,
  available: a.available,
  capabilities: capabilitiesFor(a),
});
export class AppService extends BaseToolService {
  constructor(gate, options = {}) {
    super('app', gate);
    this.registry = options.registry || new AppRegistryService(options);
    this.permissions =
      options.permissions || new AppPermissionStore({ directory: this.registry.directory });
    this.resolver = options.resolver || new AppResolverService(options.resolverOptions);
    this.activeContexts = new Map();
    this.targetAliases = options.targetAliases || {};
    this.targetRoots = options.targetRoots;
    this.uiFallback = options.uiFallback;
    this.processService = options.processService || new ProcessService(gate);
  }
  get actions() {
    const query = {
      query: { type: 'string', required: true, minLength: 1, maxLength: 200 },
    };
    const action = (handler, description, schema = query) => ({
      handler,
      description,
      schema,
      destructive: false,
    });
    return {
      resolveTarget: action(
        (p) => this.resolveTarget(p),
        'Resolve an explicit file/folder or a configured target name',
        {
          query: { type: 'string', required: true, maxLength: 4096 },
          type: { type: 'string', maxLength: 20 },
        },
      ),
      focusApp: action(
        (p) => this.lifecycle('focusWindow', p),
        'Focus a resolved application window',
      ),
      isAppOpen: action(
        (p) => this.lifecycle('isWindowOpen', p),
        'Check a resolved application window',
      ),
      closeApp: {
        ...action((p) => this.lifecycle('closeWindow', p), 'Close the resolved application window'),
        destructive: true,
      },
      getCapabilities: action(async (p) => {
        const r = await this.resolve(p.query);
        return r.success
          ? {
              success: true,
              app: publicApp(r.app),
              capabilities: capabilitiesFor(r.app),
            }
          : r;
      }, 'Get supported app target types'),
      openWithTarget: action(
        (p) => this.openWithTarget(p),
        'Open and verify a document, folder, media or URL in an installed app',
        {
          app: { type: 'string', required: true, maxLength: 200 },
          target: { type: 'object', required: true, properties: targetSchema },
        },
      ),
      openApp: action(
        (p) => this.openApp(p),
        'Open a discovered installed application by name; never supply paths.',
      ),
      listApps: action(
        (p) => this.listApps(p),
        'List installed third-party applications the assistant can work with, with category and the user-set permission level (blocked/read/interact/modify). Optional name filter.',
        {
          query: { type: 'string', maxLength: 200 },
          limit: { type: 'number', min: 1, max: 200 },
          withAliases: { type: 'boolean' },
        },
      ),
      describeApp: action(
        (p) => this.describeApp(p),
        'Describe one installed application: category, what the assistant can do in it, and its permission level. Call before planning UI work in an unfamiliar app.',
      ),
      setAppPermission: {
        ...action(
          (p) => this.setAppPermission(p),
          'Set the permission level of an application (user-approved only).',
          {
            appId: { type: 'string', required: true, maxLength: 80 },
            level: {
              type: 'enum',
              required: true,
              values: [...PERMISSION_LEVELS],
            },
          },
        ),
        destructive: true,
      },
      open: action(
        (p) => this.openApp({ query: p.query || p.app }),
        'Open a discovered application',
        {
          query: { type: 'string', maxLength: 200 },
          app: { type: 'string', maxLength: 200 },
        },
      ),
      searchInstalledApps: action(async (p) => {
        await this.registry.ensureTrusted();
        return {
          matches: this.resolver
            .search(p.query, this.registry.apps, this.registry.aliases)
            .map((x) => ({ ...publicApp(x.app), confidence: x.score })),
        };
      }, 'Search installed apps locally by name'),
      resolveApp: action(
        async (p) => this.publicResult(await this.resolve(p.query)),
        'Resolve an installed application',
      ),
      isInstalled: action(
        async (p) => this.publicResult(await this.resolve(p.query)),
        'Check whether an application is installed',
      ),
      getAppInfo: action(
        async (p) => this.publicResult(await this.resolve(p.query)),
        'Get relevant application metadata',
      ),
      refreshAppRegistry: action(
        async () => {
          const r = await this.registry.refresh();
          if (r.retained)
            return {
              ...r,
              success: false,
              status: 'REGISTRY_REFRESH_FAILED',
              code: 'REGISTRY_REFRESH_FAILED',
              message:
                'The installed application registry could not be refreshed. Existing verified records were retained.',
            };
          return {
            ...r,
            success: true,
            status: 'APP_REGISTRY_REFRESHED',
            message: `Application registry refreshed: ${this.registry.apps.filter((a) => a.available).length} launchable records${r.errors?.length ? ' (some optional sources were unavailable)' : ''}.`,
          };
        },
        'Refresh the local installed application registry',
        {},
      ),
    };
  }
  getConfirmationMessage(action, params) {
    if (action !== 'setAppPermission') return undefined;
    const app = this.registry.apps.find((a) => a.id === params.appId);
    return `Change what the assistant may do in ${app?.name || 'this application'} from “${this.permissions.levelFor({ id: params.appId })}” to “${params.level}”?`;
  }
  /** Launch/read/act gate shared by openApp and the desktop service. Returns a failure result or null. */
  permissionFailure(app) {
    const level = this.permissions.levelFor(app);
    return level === 'blocked'
      ? {
          success: false,
          status: 'APP_PERMISSION_DENIED',
          code: 'APP_PERMISSION_DENIED',
          permission: levelSummary(level),
          message: `${app.name} is blocked in App Permissions, so the assistant will not open or control it.`,
        }
      : null;
  }
  async listApps({ query, limit = 40, withAliases = false } = {}) {
    await this.registry.ensureTrusted();
    let apps = this.registry.apps.filter(isCatalogApp);
    if (query && validAppQuery(query)) {
      const ranked = this.resolver.search(query, apps, this.registry.aliases);
      apps = ranked.map((r) => r.app);
    }
    const seen = new Set(),
      entries = [];
    for (const app of apps) {
      const key = String(app.name).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = catalogEntry(app, this.permissions.levelFor(app));
      if (withAliases)
        entry.aliases = (app.aliases || [])
          .filter(
            (a) =>
              typeof a === 'string' &&
              a.length >= 3 &&
              a.length <= 60 &&
              !/\.exe$/i.test(a) &&
              a.toLowerCase() !== key,
          )
          .slice(0, 6);
      entries.push(entry);
    }
    if (!query) entries.sort((a, b) => a.name.localeCompare(b.name));
    return {
      success: true,
      status: 'APPS_LISTED',
      total: entries.length,
      apps: entries.slice(0, Math.min(Number(limit) || 40, 200)),
      levels: Object.fromEntries(PERMISSION_LEVELS.map((l) => [l, levelSummary(l).description])),
      message: 'Use describeApp for details, then desktop_open to launch an app and read its UI.',
    };
  }
  async describeApp({ query }) {
    const r = await this.resolve(query);
    if (!r.success) return r;
    const app = r.app;
    if (!isThirdPartyApp(app))
      return {
        success: true,
        status: 'SYSTEM_APP',
        app: { id: app.id, name: app.name },
        message: `${app.name} is a Windows system tool or setting. It can be opened with openApp; UI control of system tools is not enabled yet.`,
      };
    return {
      success: true,
      status: 'APP_DESCRIBED',
      app: describeApp(app, this.permissions.levelFor(app)),
    };
  }
  async setAppPermission({ appId, level }) {
    await this.registry.ensureTrusted();
    const app = this.registry.apps.find((a) => a.id === appId);
    if (!app || !isThirdPartyApp(app))
      return {
        success: false,
        status: 'APP_NOT_FOUND',
        message: 'That application is not an installed third-party app.',
      };
    const applied = await this.permissions.setLevel(appId, level);
    return {
      success: true,
      status: 'APP_PERMISSION_SET',
      app: { id: app.id, name: app.name },
      permission: levelSummary(applied),
      message: `${app.name}: permission set to ${applied}.`,
    };
  }
  publicResult(r) {
    return r.app ? { ...r, app: publicApp(r.app) } : r;
  }
  /**
   * The application the user picked for exactly this query (ToolEngineRouter `chooseApp` re-runs the ambiguous call with
   * a binding). It is found by registry id alone: no fuzzy matching, no model. Launch, permission and target checks still
   * run afterwards because callers receive an ordinary resolved record. A vanished record falls back to normal resolution.
   */
  async boundApp(query) {
    const binding = executionContext.getStore()?.appBinding;
    if (!binding || normalizeAppName(query) !== binding.query) return null;
    try {
      await this.registry.ensureTrusted();
    } catch {
      checkCancellation();
      return null;
    }
    const app = this.registry.apps.find((a) => a.id === binding.appId && a.available === true);
    return app
      ? {
          success: true,
          status: 'APP_RESOLVED',
          code: 'USER_SELECTED',
          app,
          confidence: 1,
          score: 1,
          matchType: 'USER_SELECTED',
          matchedAgainst: binding.query,
          margin: 1,
        }
      : null;
  }
  /** Makes an ambiguous lookup visible to the tool engine, which turns it into a pending user choice for the calling task. */
  offerChoice(query, result) {
    const sink = executionContext.getStore()?.appChoiceSink;
    if (sink && result.appCandidates?.length)
      sink.appChoice = {
        requestedApp: query,
        candidates: result.appCandidates,
        message: result.message,
      };
  }
  /**
   * Binds the candidate the user picked. The candidate must be one that was offered; its registry record is looked up by
   * canonical identity and re-validated. If it is gone the registry is refreshed once and, when it is still gone, the
   * caller gets a fresh resolution to ask about again. Nothing the user did not pick is ever launched.
   */
  async bindChoice(choice, candidateId) {
    const offered = choice.candidates.find((c) => c.id === candidateId);
    if (!offered)
      return {
        ok: false,
        code: 'APP_CHOICE_INVALID',
        message: 'That application was not one of the offered choices.',
      };
    const refreshFailed = {
      ok: false,
      code: 'REGISTRY_REFRESH_FAILED',
      message:
        'The installed application registry could not be refreshed. No application was selected.',
    };
    // Same rule as openApp: a record whose file is gone is no longer launchable, and only a full rescan drops it for good.
    const lookup = () => {
      const app = findAppForCandidate(this.registry.apps, offered);
      if (!app) return null;
      try {
        validateTarget(app);
        return app;
      } catch (error) {
        if (error.message === 'APP_TARGET_MISSING') app.available = false;
        return null;
      }
    };
    try {
      await this.registry.ensureTrusted();
    } catch {
      checkCancellation();
      return refreshFailed;
    }
    let app = lookup();
    if (!app) {
      try {
        const refresh = await this.registry.refresh();
        if (refresh.retained) return refreshFailed;
      } catch {
        checkCancellation();
        return refreshFailed;
      }
      app = lookup();
    }
    if (app)
      return {
        ok: true,
        app,
        binding: {
          query: normalizeAppName(choice.requestedApp),
          appId: app.id,
        },
      };
    return {
      ok: false,
      code: 'APP_CHOICE_STALE',
      stale: offered,
      fresh: this.resolver.resolve(choice.requestedApp, this.registry.apps, this.registry.aliases),
    };
  }
  /** What to ask about again after a stale choice: the fresh ambiguity's candidates, or the one application that now resolves. */
  freshCandidates(fresh) {
    if (fresh?.appCandidates?.length) return fresh.appCandidates;
    return fresh?.success && fresh.app ? [toCandidate(fresh.app, fresh.score)] : [];
  }
  async resolve(query, { refreshOnMiss = true } = {}) {
    if (!validAppQuery(query))
      return {
        success: false,
        status: 'APP_INVALID_QUERY',
        message: 'Provide an application name.',
      };
    const bound = await this.boundApp(query);
    if (bound) return bound;
    const refreshFailure = () => ({
      success: false,
      status: 'REGISTRY_REFRESH_FAILED',
      code: 'REGISTRY_REFRESH_FAILED',
      query,
      message:
        'The installed application registry could not be refreshed. No application was selected.',
    });
    const scannedBefore = this.registry.scannedAt;
    try {
      await this.registry.ensureTrusted();
    } catch (error) {
      checkCancellation();
      return refreshFailure();
    }
    let result = this.resolver.resolve(query, this.registry.apps, this.registry.aliases);
    let refreshed = this.registry.scannedAt !== scannedBefore;
    if (!result.success && refreshOnMiss && !refreshed) {
      try {
        const refresh = await this.registry.refresh({ query });
        if (refresh.retained) return refreshFailure();
        refreshed = true;
      } catch (error) {
        checkCancellation();
        return refreshFailure();
      }
      result = this.resolver.resolve(query, this.registry.apps, this.registry.aliases);
    }
    if (result.success && refreshed)
      return {
        ...result,
        matchCode: result.code,
        code: 'REGISTRY_REFRESHED_AND_MATCHED',
        registryRefreshed: true,
      };
    if (!result.success && this.registry.errors.includes('discovery_unavailable'))
      return refreshFailure();
    if (result.status === 'APP_NOT_FOUND') {
      const blocked = this.resolver.resolve(
        query,
        this.registry.apps
          .filter((a) => a.blockedReason && a.blockedReason !== 'APP_TARGET_MISSING')
          .map((a) => ({ ...a, available: true })),
        this.registry.aliases,
      );
      if (blocked.success)
        return {
          success: false,
          status: 'APP_UNSAFE_TARGET',
          app: publicApp(blocked.app),
          message: `${blocked.app.name} was found, but its launch target is blocked by the application safety policy.`,
        };
      if (this.registry.errors.length)
        return {
          success: false,
          status: 'APP_NOT_FOUND',
          code: 'APP_NOT_FOUND',
          query,
          partialDiscovery: true,
          message:
            'No confident match was found among the available application sources. Provide a more specific application name.',
        };
      const displayName = query;
      return {
        success: false,
        status: 'APP_NOT_INSTALLED',
        code: 'APP_NOT_FOUND',
        query,
        suggestion: { type: 'INSTALL_REQUIRED', displayName },
        message: `${displayName} doesn't appear to be installed on this PC. You can install it and ask me to open it again.`,
      };
    }
    if (result.status === 'AMBIGUOUS_APP') {
      result.message = `Which application do you mean: ${result.matches.map((a) => a.name).join(', ')}?`;
      this.offerChoice(query, result);
    }
    return result;
  }
  async lifecycle(action, params) {
    if (!this.uiService)
      return {
        success: false,
        status: 'UI_FALLBACK_FAILED',
        message: 'UI Automation is unavailable.',
      };
    return this.uiService.generic(action, params);
  }
  async resolveTarget({ query, type = 'UNKNOWN' }) {
    try {
      let configured = {};
      if (this.registry.directory)
        try {
          configured = JSON.parse(
            await fs.readFile(path.join(this.registry.directory, 'app-targets.json'), 'utf8'),
          );
        } catch {}
      const aliasKey = Object.keys({
        ...configured.aliases,
        ...this.targetAliases,
      }).find((k) => k.toLowerCase() === query.toLowerCase());
      let alias = aliasKey && (this.targetAliases[aliasKey] || configured.aliases?.[aliasKey]);
      if (
        !alias &&
        !/^[A-Za-z]:[\\/]|^https?:/i.test(query) &&
        /^[^\\/:*?"<>|]+$/i.test(query) &&
        !/^(my project(?: folder)?|this (?:file|movie|folder))$/i.test(query)
      ) {
        const roots =
          this.targetRoots ||
          configured.roots ||
          ['Documents', 'Desktop', 'Downloads'].map((p) => path.join(os.homedir(), p));
        const matches = [];
        let budget = 2000;
        for (const root of roots.slice(0, 8)) {
          const queue = [{ directory: root, depth: 0 }];
          while (queue.length && budget > 0) {
            const { directory, depth } = queue.shift();
            let entries;
            try {
              entries = await fs.readdir(directory, { withFileTypes: true });
            } catch {
              continue;
            }
            for (const entry of entries) {
              if (--budget < 0) break;
              if (entry.isSymbolicLink()) continue;
              const p = path.join(directory, entry.name);
              if (
                (entry.isFile() || entry.isDirectory()) &&
                entry.name.toLowerCase() ===
                  query.replace(/^(?:the |my )?(.+?) (?:folder|directory)$/i, '$1').toLowerCase()
              )
                matches.push(p);
              else if (entry.isDirectory() && depth < 2)
                queue.push({ directory: p, depth: depth + 1 });
            }
          }
        }
        if (matches.length > 1)
          return {
            success: false,
            status: 'AMBIGUOUS_TARGET',
            message: 'Multiple files match. Provide the full path.',
            matches,
          };
        if (matches.length === 1)
          alias = {
            type: type === 'UNKNOWN' ? 'UNKNOWN' : type,
            path: matches[0],
          };
      }
      const input =
        alias ||
        (type.toUpperCase() === 'URL'
          ? { type, value: query }
          : { type, path: query.replace(/^(["'])(.*)\1$/, '$2') });
      const target = await resolveDocumentTarget(input);
      return { success: true, status: 'TARGET_RESOLVED', query, target };
    } catch (error) {
      return {
        success: false,
        status: error.code || 'TARGET_NOT_FOUND',
        message:
          'The requested target could not be resolved. Provide its full path or configure a named target.',
      };
    }
  }
  async openWithTarget({ app: query, target }) {
    try {
      target = await resolveDocumentTarget(target);
      await this.registry.ensureTrusted();
      const associated = await new FileAssociationService(this.processService)
        .resolve(target, this.registry.apps)
        .catch(() => null);
      const resolved =
        query === 'default'
          ? associated
            ? { success: true, app: associated }
            : {
                success: false,
                status: 'APP_CAPABILITY_UNSUPPORTED',
                message: 'No safely supported registered default app was found.',
              }
          : await this.resolve(query);
      if (!resolved.success) return resolved;
      const app = resolved.app;
      validateTarget(app);
      const capabilities = capabilitiesFor(app);
      if (
        app.launchType !== 'executable' ||
        (!capabilities.types.includes(target.type) && associated?.id !== app.id)
      ) {
        if (this.uiFallback) {
          const result = await this.uiFallback({ app, target });
          const verified = result.success === true && result.verification?.status === 'verified';
          return {
            ...result,
            success: verified,
            status: verified ? 'APP_TARGET_OPENED' : result.status || 'UI_FALLBACK_FAILED',
            requestedApp: query,
            app: publicApp(app),
            target,
            strategy: 'UI_AUTOMATION',
          };
        }
        return {
          success: false,
          status: 'APP_CAPABILITY_UNSUPPORTED',
          message:
            'This app has no supported native target adapter or verified UI opening profile.',
        };
      }
      const launch = await this.processService.launchApp(app, target);
      const success = launch.verification?.status === 'verified';
      return {
        ...launch,
        success,
        status: success ? 'APP_TARGET_OPENED' : 'VERIFICATION_FAILED',
        app: publicApp(app),
        requestedApp: query,
        target,
        strategy: 'NATIVE_ARGUMENT',
        message: success
          ? `${target.path || target.value} is open in ${app.name}.`
          : `${app.name} received the target, but the requested target could not be verified in its window.`,
      };
    } catch (error) {
      checkCancellation();
      const code = [
        'TARGET_NOT_FOUND',
        'TARGET_TYPE_UNSUPPORTED',
        'APP_UNSAFE_TARGET',
        'APP_TARGET_MISSING',
      ].includes(error.code || error.message)
        ? error.code || error.message
        : ['EACCES', 'EPERM'].includes(error.code)
          ? 'PERMISSION_DENIED'
          : error.code === 'ENOENT'
            ? 'APP_LAUNCH_FAILED'
            : 'TARGET_OPEN_FAILED';
      return {
        success: false,
        status: code,
        errorCode: code,
        retryable: false,
        message: error.message,
      };
    }
  }
  async openApp({ query }, { inspect = true } = {}) {
    let result = await this.resolve(query);
    if (!result.success) return result;
    const denied = this.permissionFailure(result.app);
    if (denied) return denied;
    try {
      validateTarget(result.app);
    } catch (error) {
      if (error.message !== 'APP_TARGET_MISSING')
        return {
          success: false,
          status: error.message,
          message: 'This application launch target is blocked.',
        };
      result.app.available = false;
      await this.registry.refresh();
      result = await this.resolve(query, { refreshOnMiss: false });
      if (!result.success) return result;
    }
    let launch;
    try {
      launch = await this.processService.launchApp(result.app);
    } catch (error) {
      checkCancellation();
      if (['EACCES', 'EPERM'].includes(error.code))
        return {
          success: false,
          status: 'PERMISSION_DENIED',
          app: publicApp(result.app),
          message: `Windows denied launching ${result.app.name}. The application policy allows opening it, but this OS session requires additional privileges.`,
        };
      // Activation may fail after uninstall. Refresh metadata, but never replay a launch.
      await this.registry.refresh();
      const current = this.resolver.resolve(query, this.registry.apps, this.registry.aliases);
      if (!current.success) return this.resolve(query, { refreshOnMiss: false });
      return {
        success: false,
        status: 'APP_LAUNCH_UNVERIFIED',
        app: publicApp(result.app),
        message: `The launch of ${result.app.name} could not be verified. Check the desktop before trying again.`,
      };
    }
    const success = launch.readiness?.status === 'ready';
    if (success && executionContext.getStore()?.scope)
      this.activeContexts.set(executionContext.getStore().scope, {
        query,
        appId: result.app.id,
        processId: launch.processId,
        windowId: launch.windowId || launch.readiness?.windowId,
        taskId: executionContext.getStore().taskId,
        lastInspection: null,
      });
    if (success && result.app.id === 'bluetooth-settings') {
      try {
        const observed = await this.uiService.generic('listControls', {
          query: 'Settings',
        });
        if (!(observed.controls || []).some((c) => /bluetooth/i.test(c.name)))
          throw new Error('Page not observed');
        launch.pageVerification = {
          status: 'verified',
          criterion: 'bluetooth_visible',
          observedAt: new Date().toISOString(),
        };
      } catch {
        return {
          success: false,
          status: 'VERIFICATION_FAILED',
          message: 'Settings opened, but the Bluetooth page could not be verified.',
        };
      }
    }
    // "Check for updates": the ms-settings action URI starts the scan; read the Windows Update page to report what it shows.
    let special;
    if (success && result.app.id === 'updatecheck-settings' && this.uiService) {
      let state = null;
      for (let i = 0; i < 6 && !state; i++) {
        try {
          const observed = await this.uiService.generic('listControls', {
            query: 'Settings',
          });
          const text = (observed.controls || []).map((c) => c.name || '').join(' | ');
          state = /checking for updates|looking for updates/i.test(text)
            ? 'checking'
            : /you(?:'|\u2019)?re up to date/i.test(text)
              ? 'up_to_date'
              : /updates? (?:are )?available|downloading|installing|pending (?:install|restart)|restart (?:now|required)/i.test(
                    text,
                  )
                ? 'updates_found'
                : null;
        } catch {}
        if (!state) {
          checkCancellation();
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
      launch.updateCheck = {
        status: state ? 'verified' : 'unverified',
        criterion: 'windows_update_page',
        state,
        observedAt: new Date().toISOString(),
      };
      special =
        {
          checking: 'Windows Update is checking for updates now.',
          up_to_date: 'Windows Update checked for updates: you are up to date.',
          updates_found:
            'Windows Update checked and shows updates to download, install or restart for. Review them on the Windows Update page.',
        }[state] ||
        'Windows Update opened and a check for updates was requested, but its status could not be read from the page.';
    }
    let inspection;
    if (success && inspect && isThirdPartyApp(result.app) && this.launchObserver) {
      try {
        inspection = await this.launchObserver({ query });
        if (
          inspection.success &&
          (inspection.application?.id !== result.app.id ||
            inspection.application?.processId !== launch.processId ||
            (launch.windowId && inspection.application?.windowId !== launch.windowId))
        )
          throw Object.assign(
            new Error('The inspected window does not belong to the verified launch.'),
            { code: 'TARGET_PROCESS_CHANGED' },
          );
      } catch (error) {
        checkCancellation();
        inspection = {
          success: false,
          status: error.code || 'UI_INSPECTION_FAILED',
          message: error.message,
        };
      }
    }
    const inspectionMessage = inspection
      ? inspection.success && inspection.elements?.length
        ? ' Its window was identified and its interface inspected.'
        : ` The application opened, but its interface could not be inspected (${inspection.status || inspection.code || 'NO_CONTROLS'}${inspection.success && !inspection.elements?.length ? ': no accessible controls' : ''}).`
      : '';
    return {
      success,
      resolutionCode: result.code,
      resolutionScore: result.score,
      status: success ? 'APP_OPENED' : 'APP_LAUNCH_UNVERIFIED',
      app: publicApp(result.app),
      matchConfidence: result.confidence,
      matchType: result.matchType,
      strategy: result.app.source === 'windows_system' ? 'TRUSTED_SYSTEM' : 'DISCOVERED_EXECUTABLE',
      ...launch,
      ...(inspection ? { inspection } : {}),
      message: success
        ? special || `${result.app.name} opened successfully.${inspectionMessage}`
        : `${result.app.name} was launched, but its process could not be verified. Check the desktop before trying again.`,
    };
  }
  async execute(action, params = {}) {
    let result;
    try {
      result = await super.execute(action, params);
    } catch (error) {
      if (
        error.code === 'VALIDATION_ERROR' ||
        error.code === 'ACTION_NOT_FOUND' ||
        error.name === 'AbortError'
      )
        throw error;
      return {
        success: false,
        data: { status: 'APP_DISCOVERY_FAILED' },
        error: {
          code: 'APP_DISCOVERY_FAILED',
          message:
            'The application registry could not be refreshed or checked. Try refreshing it again.',
        },
      };
    }
    if (result.data?.success === false)
      return {
        ...result,
        success: false,
        error: {
          code: result.data.status,
          message: result.data.message || result.data.status,
          retryable: result.data.retryable === true,
        },
      };
    return result;
  }
}
