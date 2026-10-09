import { BaseToolService } from '../BaseToolService.js';
import { checkCancellation } from '../ExecutionContext.js';
import {
  SETTINGS,
  SETTING_IDS,
  OPTION_IDS,
  SOURCES,
  planChange,
  requireSetting,
  matches,
} from '../apps/SystemSettingsCatalog.js';

/**
 * Change real Windows settings (dark mode, brightness, volume, power timeouts, pointer behavior, Wi-Fi, Bluetooth, ...).
 *
 *   systemSettings.list          READ        every controllable setting with its current value
 *   systemSettings.get           READ        one setting's current value
 *   systemSettings.set           SAFE_WRITE  reversible local settings; applied at once and read back
 *   systemSettings.setConfirmed  DANGEROUS   radios and device behavior; human confirmation first
 *
 * The model chooses a catalog id, a typed value and (for power-plan settings) whether it applies plugged in, on battery or
 * both. It never supplies a command, path or script.
 *
 * A few settings need administrator rights (catalog elevation: "admin"). They are always DANGEROUS, so the human confirms first;
 * the change is then made by SettingsElevator through Windows' own UAC prompt (never silently) and verified by reading it back
 * without elevation.
 */
const failure = (code, message = code) => Object.assign(new Error(message), { code });
const FRIENDLY = {
  'dark-mode': ['dark', 'light'],
  mute: ['muted', 'unmuted'],
  'mic-mute': ['muted', 'unmuted'],
};
/** Human wording for a value: 40%, dark, "15 minutes", "never"; labels come from the catalog entry when it has them. */
export function describeValue(setting, value) {
  if (setting.type === 'percent') return `${value}%`;
  if (setting.type === 'choice')
    return setting.options.find((o) => o.id === value)?.label ?? String(value);
  if (setting.type === 'number') {
    if (value === 0 && setting.zeroLabel) return setting.zeroLabel;
    if (setting.unit === '%') return `${value}%`;
    const unit =
      value === 1 && /^(minutes|lines|characters)$/.test(setting.unit)
        ? setting.unit.slice(0, -1)
        : setting.unit; // "1 minute", but "1 ms"
    return `${value} ${unit}`;
  }
  return (setting.labels ?? FRIENDLY[setting.id] ?? ['on', 'off'])[value ? 0 : 1];
}

/** Which readings of the helper's answer a request targets (power-plan settings report pluggedIn and onBattery separately). */
const sidesFor = (setting, source) =>
  !setting.perSource
    ? ['value']
    : source === 'plugged-in'
      ? ['pluggedIn']
      : source === 'battery'
        ? ['onBattery']
        : ['pluggedIn', 'onBattery'];
const sourcePhrase = (source) =>
  source === 'plugged-in' ? ' when plugged in' : source === 'battery' ? ' on battery' : '';
/** "10 minutes", or "10 minutes plugged in, 5 minutes on battery" when the two differ. */
function describePair(setting, pair) {
  const a = pair.pluggedIn ?? pair.value,
    b = pair.onBattery;
  if (b === undefined || a === b) return describeValue(setting, a);
  return `${describeValue(setting, a)} plugged in, ${describeValue(setting, b)} on battery`;
}
/** The current value(s) a request would replace, for messages. */
function describeCurrent(setting, reading, source) {
  if (!setting.perSource) return describeValue(setting, reading.value);
  if (source === 'plugged-in') return describeValue(setting, reading.pluggedIn ?? reading.value);
  if (source === 'battery') return describeValue(setting, reading.onBattery ?? reading.value);
  return describePair(setting, reading);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class SystemSettingsService extends BaseToolService {
  /** @param ui UIAutomationService (provides run(input, script)); @param options.reader injectable runner for tests */
  constructor(gate, ui, { reader, worker, elevator, settleMs = 300 } = {}) {
    super('systemSettings', gate);
    this.settleMs = settleMs; // how long Windows gets to settle before an elevated change is read back
    this.worker = worker || null;
    this.elevator = elevator || null; // SettingsElevator: applies elevation: "admin" settings through a UAC prompt
    // A warm worker (SettingsWorker) answers in milliseconds; without one every call starts PowerShell and recompiles its C# groups.
    const run =
      reader ||
      (worker ? (input) => worker.call(input) : (input) => ui.run(input, 'SystemSettings.ps1'));
    // The helper script is optional for desktop control; if it is missing, say why instead of failing obscurely.
    this.reader = async (input) => {
      try {
        return await run(input);
      } catch (error) {
        if (error?.code === 'DESKTOP_HELPER_MISSING')
          throw failure(
            'SETTINGS_HELPER_MISSING',
            'The Windows settings helper (SystemSettings.ps1) is missing. Security software may have removed it; reinstall the app or allow it in your antivirus.',
          );
        throw error;
      }
    };
    this.busy = false;
    this.snapshot = new Map(); // id -> the helper's reading taken just before a confirmation prompt, for its text
  }

  get actions() {
    const change = {
      id: { type: 'enum', required: true, values: SETTING_IDS },
      enabled: { type: 'boolean' },
      level: { type: 'number', integer: true, min: 0, max: 4000 },
      option: { type: 'enum', values: OPTION_IDS },
      source: { type: 'enum', values: SOURCES },
    };
    return {
      list: {
        schema: {},
        destructive: false,
        handler: () => this.list(),
        description:
          'List every Windows setting you can change (display, sound, power plan, pointer and keyboard, Explorer, notifications, Wi-Fi, Bluetooth) with its current value and whether changing it needs confirmation. Settings with separate plugged-in and on-battery values also show onBattery. Call this first so you use real ids.',
      },
      get: {
        schema: { id: change.id },
        destructive: false,
        handler: (p) => this.get(p),
        description:
          'Read the current value of one Windows setting (plugged-in and on-battery values for power-plan settings).',
      },
      set: {
        schema: change,
        destructive: false,
        handler: (p) => this.change(p),
        description:
          'Change a reversible setting from systemSettings.list. Use enabled (true/false) for on/off settings (dark-mode, mute, animations, ...), level (a whole number within the range shown by list) for numeric settings (brightness, volume, mic-volume, the timeouts, mouse-speed, scroll-lines, max-processor-state, ...) and option for choices (power-mode, wake-timers, cooling-policy). For settings that list shows with onBattery, add source: "battery", "plugged-in" or "both" (default both) when the user says "on battery" or "when plugged in". Applied immediately and verified by reading it back.',
      },
      setConfirmed: {
        schema: change,
        destructive: true,
        handler: (p) => this.change(p),
        description:
          "Change a setting that needs the user's confirmation: wifi, bluetooth, airplane-mode, camera-access, microphone-access, location-access, sign-in-on-wake, firewall-* (on only), hibernate, fast-startup, remote-desktop, long-paths, feature-* (wsl, virtual-machine-platform, hyper-v, windows-sandbox) with enabled true/false; active-hours-start / active-hours-end with level (0-23); or lid-close-action, power-button-action, low-battery-action, critical-battery-action (option, optional source) and mouse-primary-button (option). Shows the user a confirmation first because these can disconnect the internet or devices, weaken privacy or security, or change how the PC behaves. Settings marked requiresAdmin in systemSettings.list also make Windows show an administrator (UAC) prompt.",
      },
    };
  }

  /** Reject bad or wrongly-routed requests before any script runs or any human is asked. */
  async execute(action, params = {}) {
    if (action === 'set' || action === 'setConfirmed') {
      const { setting } = planChange(params);
      if (action === 'set' && setting.risk !== 'SAFE_WRITE')
        throw failure(
          'APPROVAL_REQUIRED',
          `${setting.name} can disconnect the internet or devices and needs confirmation. Call systemSettings.setConfirmed with the same parameters.`,
        );
      if (action === 'setConfirmed' && setting.risk === 'SAFE_WRITE')
        throw failure(
          'CONFIRMATION_NOT_NEEDED',
          `${setting.name} does not need confirmation. Call systemSettings.set instead.`,
        );
      if (action === 'setConfirmed') {
        await this.precheck(setting, planChange(params).value); // refuse impossible changes before a human is asked
        try {
          this.snapshot.set(setting.id, await this.reader({ action: 'get', id: setting.id }));
        } catch (error) {
          throw failure(error.code || 'SETTING_UNAVAILABLE', error.message);
        } // do not ask a human about an unavailable radio
      }
    }
    return super.execute(action, params);
  }

  getConfirmationMessage(action, params) {
    const { setting, value, source } = planChange(params);
    const reading = this.snapshot.get(setting.id);
    const now = reading ? ` (currently ${describeCurrent(setting, reading, source)})` : '';
    // Warnings apply to the risky direction only: switching a radio OFF, or airplane mode ON (setting.warnWhen). Choices always warn.
    const phrase = sourcePhrase(source);
    const subject =
      setting.type === 'boolean'
        ? `Turn ${setting.name} ${describeValue(setting, value)}${phrase}`
        : `Set ${setting.name} to ${describeValue(setting, value)}${phrase}`;
    const risky =
      setting.warnAlways || setting.type === 'choice' || value === (setting.warnWhen ?? false);
    const uac =
      setting.elevation === 'admin'
        ? 'Windows will then ask you to approve administrator access (UAC).'
        : '';
    return `${subject}${now}? ${risky ? setting.warning || '' : ''} ${uac}`
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Prerequisites that would only fail after a UAC prompt: check them first, without elevation. */
  async precheck(setting, value) {
    if (setting.id === 'fast-startup' && value === true) {
      const hibernate = await this.reader({ action: 'get', id: 'hibernate' });
      if (hibernate.value !== true)
        throw failure(
          'ADMIN_PREREQUISITE',
          'Fast Startup needs hibernate to be on first. Turn on the hibernate setting, then try again.',
        );
    }
    if (setting.id === 'hibernate' && value === false) return; // turning hibernate off also turns Fast Startup off in Windows; the warning says so
    if (/^active-hours-(start|end)$/.test(setting.id)) {
      const otherId =
        setting.id === 'active-hours-start' ? 'active-hours-end' : 'active-hours-start';
      const other = (await this.reader({ action: 'get', id: otherId })).value;
      const [start, end] = setting.id === 'active-hours-start' ? [value, other] : [other, value];
      const span = (((end - start) % 24) + 24) % 24;
      if (span === 0 || span > 18)
        throw failure(
          'OUT_OF_RANGE',
          `Active hours can be at most 18 hours long (they would run from ${start}:00 to ${end}:00).`,
        );
    }
  }

  async list() {
    checkCancellation();
    const raw = await this.reader({ action: 'list' });
    const byId = new Map((raw.settings ?? []).map((s) => [s.id, s]));
    return {
      success: true,
      status: 'SETTINGS_LISTED',
      settings: SETTINGS.map((s) => {
        const live = byId.get(s.id) ?? {
          available: false,
          reason: 'Not reported by Windows.',
        };
        return {
          id: s.id,
          name: s.name,
          type: s.type,
          ...(s.type === 'percent' || s.type === 'number'
            ? { range: [s.min, s.max], ...(s.unit ? { unit: s.unit } : {}) }
            : {}),
          ...(s.type === 'choice' ? { options: s.options.map((o) => o.id) } : {}),
          description: s.description,
          requiresConfirmation: s.risk === 'DANGEROUS',
          available: live.available === true,
          ...(s.perSource ? { perSource: true } : {}),
          ...(s.elevation === 'admin' ? { requiresAdmin: true } : {}),
          ...(s.batteryOnly ? { appliesTo: 'battery' } : {}),
          ...(live.available
            ? { value: live.value, display: describeValue(s, live.value) }
            : { reason: live.reason }),
          ...(live.available && s.perSource && live.onBattery !== undefined
            ? {
                onBattery: live.onBattery,
                displayOnBattery: describeValue(s, live.onBattery),
              }
            : {}),
        };
      }),
      message:
        'Use systemSettings.set for settings with requiresConfirmation=false and systemSettings.setConfirmed for the others. For settings with perSource, value is the plugged-in value and onBattery is the battery value; pass source to change only one.',
    };
  }

  async get({ id }) {
    checkCancellation();
    const setting = requireSetting(id);
    const raw = await this.reader({ action: 'get', id: setting.id });
    return {
      success: true,
      status: 'SETTING_READ',
      id: setting.id,
      name: setting.name,
      value: raw.value,
      display: setting.perSource ? describePair(setting, raw) : describeValue(setting, raw.value),
      ...(setting.perSource ? { pluggedIn: raw.pluggedIn, onBattery: raw.onBattery } : {}),
    };
  }

  /** Make the change. Returns the helper-style answer {success, previous, requested, value, ...} and whether a restart is needed. */
  async write(setting, value, source) {
    if (setting.elevation !== 'admin')
      return {
        raw: await this.reader({
          action: 'set',
          id: setting.id,
          value,
          ...(setting.perSource ? { source } : {}),
        }),
        restartNeeded: false,
      };
    if (!this.elevator)
      throw failure(
        'ELEVATION_UNAVAILABLE',
        'Administrator settings are not available in this build.',
      );
    const before = await this.reader({ action: 'get', id: setting.id });
    if (matches(setting, value, before.value))
      return {
        raw: {
          success: true,
          previous: before.value,
          requested: value,
          value: before.value,
        },
        restartNeeded: false,
      }; // already as asked: no UAC prompt for a no-op
    const { outcome } = await this.elevator.apply({ id: setting.id, value });
    const restartNeeded = outcome === 'restart-needed';
    // The elevated helper has no channel back, so verify the way every other setting is verified: read it back without elevation.
    let now = before.value;
    for (let i = 0; i < (restartNeeded ? 2 : 8); i += 1) {
      await wait(i === 0 ? this.settleMs : Math.max(this.settleMs * 2, 100));
      now = (await this.reader({ action: 'get', id: setting.id })).value;
      if (matches(setting, value, now)) break;
    }
    return {
      raw: {
        success: true,
        previous: before.value,
        requested: value,
        value: now,
      },
      restartNeeded,
    };
  }

  async change(params) {
    if (this.busy)
      throw failure('SETTINGS_BUSY', 'Another settings change is running. Wait for it to finish.');
    this.busy = true;
    try {
      checkCancellation();
      const { setting, value, source } = planChange(params);
      const { raw, restartNeeded } = await this.write(setting, value, source);
      const sides = sidesFor(setting, source);
      // Verified only when EVERY targeted reading matches what was asked for (plugged-in and battery for source "both").
      const verified =
        raw?.success === true &&
        sides.every((side) => matches(setting, value, raw[side] ?? raw.value));
      const before = raw?.before ?? {
        pluggedIn: raw?.previous,
        onBattery: raw?.previous,
        value: raw?.previous,
      };
      const unchanged =
        verified && sides.every((side) => matches(setting, before[side] ?? raw.previous, value));
      const pendingRestart = !verified && restartNeeded && raw?.success === true;
      this.snapshot.delete(setting.id);
      const phrase = setting.perSource ? sourcePhrase(source) : '';
      const nowText = setting.perSource
        ? describeValue(setting, value)
        : describeValue(setting, raw?.value);
      const wasText = setting.perSource
        ? describeCurrent(setting, { ...before, value: before.pluggedIn }, source)
        : describeValue(setting, raw?.previous);
      return {
        success: verified || pendingRestart,
        status: verified
          ? unchanged
            ? 'SETTING_UNCHANGED'
            : 'SETTING_APPLIED'
          : pendingRestart
            ? 'SETTING_PENDING_RESTART'
            : 'SETTING_NOT_VERIFIED',
        ...(restartNeeded ? { restartRequired: true } : {}),
        id: setting.id,
        name: setting.name,
        previous: raw?.previous,
        requested: value,
        value: raw?.value,
        ...(setting.perSource
          ? { source, pluggedIn: raw?.pluggedIn, onBattery: raw?.onBattery }
          : {}),
        verification: {
          status: verified ? 'verified' : pendingRestart ? 'pending-restart' : 'unverified',
          criterion: 'readback',
          observedAt: new Date().toISOString(),
        },
        message: verified
          ? (unchanged
              ? `${setting.name} was already ${nowText}${phrase}.`
              : `${setting.name} is now ${nowText}${phrase} (was ${wasText}).`) +
            (restartNeeded ? ' Restart Windows to finish.' : '')
          : pendingRestart
            ? `${setting.name} was changed, but Windows needs a restart before the new value shows. Tell the user to restart.`
            : `${setting.name} was asked to change but Windows reports ${setting.perSource ? describePair(setting, raw ?? {}) : describeValue(setting, raw?.value)}. Do not claim it worked.`,
      };
    } finally {
      this.busy = false;
    }
  }
}
