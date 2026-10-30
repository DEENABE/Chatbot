import { browserSchemas } from './BrowserTask.js';
import { desktopCompletion, desktopSnapshot } from './GenericDesktopTask.js';
import { targetEvidence } from './ApplicationGoal.js';
import { validSoftwareQuery } from './SoftwareTask.js';
import { verifiedSoftwareInstall, verifiedSoftwareDownload } from './SoftwareRunner.js';

import { validateRepair, verified } from './WindowsRepairContract.js';
import { INTENT_IDS } from './AppIntents.js';

const string = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 4096;

const integer = (min, max) => (v) => Number.isInteger(v) && v >= min && v <= max;

const oneOf = (values) => (v) => values.includes(v);

// Mirrors frontend/tools/apps/SystemSettingsCatalog.js (a test in the frontend suite fails if they drift).
export const SETTING_IDS = [
  'dark-mode',
  'brightness',
  'volume',
  'mute',
  'mic-mute',
  'transparency',
  'file-extensions',
  'hidden-files',
  'notifications',
  'clipboard-history',
  'screen-timeout',
  'sleep-timeout',
  'mouse-speed',
  'hibernate-timeout',
  'disk-timeout',
  'lock-screen-timeout',
  'pointer-trails',
  'keyboard-repeat-delay',
  'menu-show-delay',
  'mic-volume',
  'pointer-precision',
  'scroll-lines',
  'double-click-speed',
  'keyboard-repeat-rate',
  'power-mode',
  'airplane-mode',
  'lid-close-action',
  'power-button-action',
  'mouse-primary-button',
  'cursor-blink-rate',
  'clock-24-hour',
  'animations',
  'drag-window-contents',
  'snap-to-default-button',
  'hide-pointer-while-typing',
  'pointer-location-on-ctrl',
  'usb-selective-suspend',
  'dim-timeout',
  'max-processor-state',
  'battery-saver-threshold',
  'wake-timers',
  'cooling-policy',
  'caret-width',
  'horizontal-scroll-chars',
  'mouse-click-lock',
  'keyboard-underlines',
  'window-minimize-animation',
  'hybrid-sleep',
  'unattended-sleep-timeout',
  'default-brightness',
  'battery-saver-brightness',
  'low-battery-level',
  'critical-battery-level',
  'low-battery-action',
  'critical-battery-action',
  'wifi',
  'bluetooth',
  'taskbar-alignment',
  'task-view-button',
  'taskbar-badges',
  'taskbar-all-displays',
  'taskbar-combine-buttons',
  'clock-seconds',
  'desktop-icons',
  'full-path-title-bar',
  'open-explorer-to',
  'compact-view',
  'item-checkboxes',
  'folder-thumbnails',
  'recent-items',
  'quick-access-recent-files',
  'quick-access-frequent-folders',
  'aero-shake',
  'classic-context-menu',
  'accent-on-taskbar',
  'accent-on-title-bars',
  'advertising-id',
  'tips-and-suggestions',
  'game-mode',
  'mono-audio',
  'always-show-scrollbars',
  'notification-sounds',
  'storage-sense',
  'adaptive-brightness',
  'camera-access',
  'microphone-access',
  'location-access',
  'sign-in-on-wake',
  'firewall-private',
  'firewall-public',
  'firewall-domain',
  'hibernate',
  'fast-startup',
  'remote-desktop',
  'long-paths',
  'feature-wsl',
  'feature-virtual-machine-platform',
  'feature-hyper-v',
  'feature-windows-sandbox',
  'active-hours-start',
  'active-hours-end',
];
export const SETTING_LIMITS = {
  brightness: [10, 100],
  volume: [0, 100],
  'screen-timeout': [0, 720],
  'sleep-timeout': [0, 720],
  'mouse-speed': [1, 20],
  'hibernate-timeout': [0, 1440],
  'disk-timeout': [0, 1440],
  'lock-screen-timeout': [0, 60],
  'pointer-trails': [0, 20],
  'keyboard-repeat-delay': [0, 3],
  'menu-show-delay': [0, 4000],
  'mic-volume': [0, 100],
  'scroll-lines': [1, 100],
  'double-click-speed': [200, 900],
  'keyboard-repeat-rate': [0, 31],
  'cursor-blink-rate': [200, 1200],
  'dim-timeout': [0, 1440],
  'max-processor-state': [20, 100],
  'battery-saver-threshold': [0, 100],
  'caret-width': [1, 20],
  'horizontal-scroll-chars': [1, 100],
  'unattended-sleep-timeout': [0, 1440],
  'default-brightness': [10, 100],
  'battery-saver-brightness': [10, 100],
  'low-battery-level': [5, 100],
  'critical-battery-level': [3, 50],
  'active-hours-start': [0, 23],
  'active-hours-end': [0, 23],
};
export const SETTING_FORBIDDEN = { 'pointer-trails': [1] };
// Power-plan settings Windows keeps separately for plugged-in and on-battery; only these accept `source`.
export const SETTING_PER_SOURCE = [
  'screen-timeout',
  'sleep-timeout',
  'hibernate-timeout',
  'disk-timeout',
  'lock-screen-timeout',
  'lid-close-action',
  'power-button-action',
  'usb-selective-suspend',
  'dim-timeout',
  'max-processor-state',
  'wake-timers',
  'cooling-policy',
  'hybrid-sleep',
  'unattended-sleep-timeout',
  'default-brightness',
  'adaptive-brightness',
  'sign-in-on-wake',
];
// Protections that may only be switched ON through the settings tool; switching them off is blocked by policy.
export const SETTING_NEVER_OFF = ['firewall-private', 'firewall-public', 'firewall-domain'];
export const SETTING_OPTIONS = {
  'power-mode': ['best-power-efficiency', 'balanced', 'best-performance'],
  'lid-close-action': ['do-nothing', 'sleep', 'hibernate', 'shut-down'],
  'power-button-action': ['do-nothing', 'sleep', 'hibernate', 'shut-down'],
  'mouse-primary-button': ['left', 'right'],
  'wake-timers': ['disabled', 'enabled', 'important-only'],
  'cooling-policy': ['passive', 'active'],
  'low-battery-action': ['do-nothing', 'sleep', 'hibernate', 'shut-down'],
  'critical-battery-action': ['do-nothing', 'sleep', 'hibernate', 'shut-down'],
  'taskbar-alignment': ['left', 'center'],
  'open-explorer-to': ['this-pc', 'home'],
  'taskbar-combine-buttons': ['always', 'when-full', 'never'],
};

export const capabilitySchemas = {
  'desktop.open': { query: string },
  'desktop.observe': { query: string },
  'desktop.act': {
    snapshotId: string,
    elementId: string,
    operation: oneOf([
      'invoke',
      'expand',
      'collapse',
      'select',
      'toggle',
      'setValue',
      'focus',
      'scrollDown',
      'scrollUp',
    ]),
    value: string,
  },
  'desktop.actConfirmed': {
    snapshotId: string,
    elementId: string,
    operation: oneOf([
      'invoke',
      'expand',
      'collapse',
      'select',
      'toggle',
      'setValue',
      'focus',
      'scrollDown',
      'scrollUp',
    ]),
    value: string,
  },
  'desktop.input': {
    snapshotId: string,
    kind: oneOf(['type', 'key']),
    text: string,
    keys: string,
  },
  'desktop.inputConfirmed': {
    snapshotId: string,
    kind: oneOf(['type', 'key']),
    text: string,
    keys: string,
  },
  'desktop.saveAs': {
    snapshotId: string,
    path: (v) =>
      string(v) && v.length <= 260 && /^[A-Za-z]:[\\/]/.test(v) && !/[\x00-\x1f<>"|?*]/.test(v),
    overwrite: (v) => typeof v === 'boolean',
  },
  'desktop.verify': {
    snapshotId: string,
    goal: string,
    evidenceIds: (v) => Array.isArray(v) && v.length > 0 && v.length <= 10 && v.every(string),
  },
  'desktop.launch': { app: (v) => string(v) && v.length <= 200 },
  ...Object.fromEntries(
    ['click', 'doubleClick', 'select', 'focus', 'read'].map((action) => [
      `desktop.${action}`,
      { snapshotId: string, elementId: string },
    ]),
  ),
  'desktop.type': {
    snapshotId: string,
    text: (v) => string(v) && v.length <= 500 && !/[\x00-\x1f\x7f]/.test(v),
  },
  'desktop.press': {
    snapshotId: string,
    key: (v) => string(v) && v.length <= 40,
  },
  'desktop.hotkey': {
    snapshotId: string,
    keys: (v) =>
      Array.isArray(v) &&
      v.length >= 2 &&
      v.length <= 4 &&
      v.every((k) => string(k) && k.length <= 12),
  },
  'desktop.scroll': {
    snapshotId: string,
    elementId: string,
    direction: oneOf(['up', 'down', 'left', 'right']),
  },
  'desktop.find': {
    snapshotId: string,
    label: (v) => string(v) && v.length <= 300,
    role: (v) => string(v) && v.length <= 50,
  },
  'desktop.waitFor': {
    snapshotId: string,
    elementId: string,
    timeoutMs: integer(0, 10000),
  },
  'desktop.close': { snapshotId: string },
  ...Object.fromEntries(
    Object.entries(browserSchemas).map(([action, schema]) => [
      `browser.${action}`,
      Object.fromEntries(['browser', ...Object.keys(schema)].map((k) => [k, string])),
    ]),
  ),

  ...Object.fromEntries(
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
      `uiAutomation.${action}`,
      {
        query: string,
        windowTitle: string,
        automationId: string,
        controlName: string,
        controlType: string,
        className: string,
      },
    ]),
  ),

  'uiAutomation.calculate': {
    requireActive: (v) => typeof v === 'boolean',
    expression: (v) =>
      typeof v === 'string' &&
      v.length <= 60 &&
      /^\d{1,12}(?:\.\d{1,8})?\s*[+*/\u00d7\u00f7-]\s*\d{1,12}(?:\.\d{1,8})?$/.test(v),
  },

  'uiAutomation.typeInNotepad': { text: (v) => string(v) && v.length <= 4000 },

  'app.resolveTarget': {
    query: string,
    type: oneOf(['FILE', 'FOLDER', 'URL', 'MEDIA', 'DOCUMENT', 'WORKSPACE', 'UNKNOWN']),
  },

  'app.openWithTarget': {
    app: string,
    targetFromStep: string,
    target: (v) =>
      v &&
      typeof v === 'object' &&
      ['FILE', 'FOLDER', 'URL', 'MEDIA', 'DOCUMENT', 'WORKSPACE'].includes(v.type) &&
      Object.keys(v).every((k) => ['type', 'path', 'value'].includes(k)) &&
      string(v.path || v.value),
  },

  'app.openApp': { query: (v) => string(v) && v.length <= 200 },

  // Slot values are validated again (strictly) by the desktop app's AppIntentCatalog before any link is built.
  'app.openIntent': {
    intentId: oneOf(INTENT_IDS),
    slots: (v) =>
      !!v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      Object.keys(v).length <= 8 &&
      Object.values(v).every(
        (x) =>
          (typeof x === 'string' && x.length <= 1000) ||
          (Array.isArray(x) &&
            x.length <= 30 &&
            x.every((y) => typeof y === 'string' && y.length <= 254)),
      ),
  },

  'systemSettings.list': {},

  'systemSettings.get': { id: oneOf(SETTING_IDS) },

  'systemSettings.set': {
    id: oneOf(SETTING_IDS),
    enabled: (v) => typeof v === 'boolean',
    level: integer(0, 4000),
    option: (v) =>
      typeof v === 'string' && Object.values(SETTING_OPTIONS).some((o) => o.includes(v)),
    source: oneOf(['both', 'plugged-in', 'battery']),
  },

  'systemSettings.setConfirmed': {
    id: oneOf(SETTING_IDS),
    enabled: (v) => typeof v === 'boolean',
    level: integer(0, 4000),
    option: (v) =>
      typeof v === 'string' && Object.values(SETTING_OPTIONS).some((o) => o.includes(v)),
    source: oneOf(['both', 'plugged-in', 'battery']),
  },

  'winget.search': {
    query: (v) => string(v) && v.length <= 100 && !/[\x00-\x1f"'`$;&|<>^%*?\[\]{}\\!]/.test(v),
    source: oneOf(['winget', 'msstore']),
  },

  'software.providers': {},
  'software.discover': { query: validSoftwareQuery },
  'software.discoverOnline': { query: validSoftwareQuery },
  'software.resolve': {
    candidateId: (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(v),
  },
  'software.download': { planId: (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(v) },
  'software.install': { planId: (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(v) },
  'software.verify': { planId: (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(v) },

  'winget.install': {
    packageId: (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{1,127}$/.test(v),
    source: oneOf(['winget', 'msstore']),
  },

  // Vendor-website installs: the model only ever passes back ids the service issued, never a URL or a command.
  'webInstall.find': {
    query: (v) => string(v) && v.length <= 100 && !/[\x00-\x1f"'`$;&|<>^%*?\[\]{}\\!]/.test(v),
  },
  'webInstall.download': {
    candidateId: (v) => typeof v === 'string' && /^[a-f0-9]{16}$/.test(v),
  },
  'webInstall.install': {
    downloadId: (v) => typeof v === 'string' && /^[a-f0-9]{16}$/.test(v),
  },

  'hardware.systemInfo': {},
  'hardware.cpuUsage': {},
  'hardware.memoryUsage': {},

  'hardware.diskInfo': {},
  'hardware.networkAdapters': {},
  'network.ipConfig': {},

  'process.list': {
    sortBy: oneOf(['cpu', 'memory', 'name', 'pid']),
    limit: integer(1, 10000),
  },

  'process.startProcess': {
    command: string,
    args: (v) =>
      Array.isArray(v) &&
      v.length <= 128 &&
      v.every((x) => typeof x === 'string' && x.length <= 4096),
    detached: (v) => typeof v === 'boolean',
  },

  'network.ping': {
    host: (v) => string(v) && /^[a-zA-Z0-9.:%[\]_-]+$/.test(v),
    count: integer(1, 20),
    timeout: integer(1, 30000),
  },

  'network.netstat': {
    state: oneOf(['ESTABLISHED', 'LISTENING', 'TIME_WAIT', 'CLOSE_WAIT', 'ALL']),
    port: integer(1, 65535),
  },
};

export function validateCapability(tool, action, params) {
  if (tool === 'desktop') {
    const required = ['open', 'observe'].includes(action)
      ? ['query']
      : action === 'launch'
        ? ['app']
        : action === 'verify'
          ? ['snapshotId', 'goal', 'evidenceIds']
          : action === 'saveAs'
            ? ['snapshotId', 'path']
            : ['act', 'actConfirmed'].includes(action)
              ? ['snapshotId', 'elementId', 'operation']
              : ['input', 'inputConfirmed'].includes(action)
                ? ['snapshotId', 'kind']
                : action === 'type'
                  ? ['snapshotId', 'text']
                  : action === 'press'
                    ? ['snapshotId', 'key']
                    : action === 'hotkey'
                      ? ['snapshotId', 'keys']
                      : action === 'find'
                        ? ['snapshotId', 'label']
                        : action === 'close'
                          ? ['snapshotId']
                          : action === 'scroll'
                            ? ['snapshotId', 'elementId', 'direction']
                            : ['snapshotId', 'elementId'];
    if (required.some((k) => !params?.[k])) return 'Missing desktop parameter.';
    if (
      ['input', 'inputConfirmed'].includes(action) &&
      (params.kind === 'type'
        ? !params.text || params.keys !== undefined
        : params.kind === 'key'
          ? !params.keys || params.text !== undefined
          : true)
    )
      return 'Invalid desktop input parameters.';
  }
  if (
    tool === 'browser' &&
    browserSchemas[action] &&
    Object.entries(browserSchemas[action]).some(
      ([key, type]) => type === 'required' && !params?.[key],
    )
  )
    return 'Missing browser parameter.';
  if (tool === 'windowsRepair') return validateRepair(action, params);

  // Per-setting typing: numeric settings take an in-range level, on/off settings take enabled (a drift test ties this to the catalog).
  if (
    tool === 'systemSettings' &&
    (action === 'set' || action === 'setConfirmed') &&
    params &&
    typeof params === 'object' &&
    SETTING_IDS.includes(params.id)
  ) {
    if (params.source !== undefined && !SETTING_PER_SOURCE.includes(params.id))
      return `Invalid parameter: ${params.id} has no separate plugged-in / on-battery value`;
    const range = SETTING_LIMITS[params.id],
      options = SETTING_OPTIONS[params.id];
    if (options)
      return typeof params.option === 'string' &&
        options.includes(params.option) &&
        params.enabled === undefined &&
        params.level === undefined
        ? null
        : `Invalid parameter: ${params.id} takes option (${options.join(', ')})`;
    if (range && SETTING_FORBIDDEN[params.id]?.includes(params.level))
      return `Invalid parameter: ${params.id} cannot be ${params.level}`;
    if (
      range &&
      (!Number.isInteger(params.level) ||
        params.level < range[0] ||
        params.level > range[1] ||
        params.enabled !== undefined ||
        params.option !== undefined)
    )
      return `Invalid parameter: level must be ${range[0]}-${range[1]} for ${params.id}`;
    if (
      !range &&
      (typeof params.enabled !== 'boolean' ||
        params.level !== undefined ||
        params.option !== undefined)
    )
      return `Invalid parameter: ${params.id} takes enabled (true/false)`;
    if (SETTING_NEVER_OFF.includes(params.id) && params.enabled === false)
      return `Invalid parameter: ${params.id} cannot be turned off from here (blocked by policy)`;
  }

  if (
    tool === 'app' &&
    action === 'openWithTarget' &&
    (!params?.app || !!params.target === !!params.targetFromStep)
  )
    return 'Supply app and exactly one target or targetFromStep.';

  const key = `${tool}.${action}`,
    schema = capabilitySchemas[key];

  if (!schema) return 'Capability is not allowed.';

  if (
    !params ||
    Array.isArray(params) ||
    typeof params !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(params))
  )
    return 'Parameters must be a plain object.';

  for (const [name, value] of Object.entries(params))
    if (!Object.hasOwn(schema, name) || !schema[name](value)) return `Invalid parameter: ${name}`;

  for (const name of key === 'uiAutomation.calculate'
    ? ['expression']
    : key === 'uiAutomation.typeInNotepad'
      ? ['text']
      : [
            'app.openApp',
            'app.resolveTarget',
            'winget.search',
            'webInstall.find',
            'software.discover',
            'software.discoverOnline',
          ].includes(key)
        ? ['query']
        : key === 'software.resolve'
          ? ['candidateId']
          : ['software.download', 'software.install', 'software.verify'].includes(key)
            ? ['planId']
            : key === 'winget.install'
              ? ['packageId']
              : key === 'webInstall.download'
                ? ['candidateId']
                : key === 'webInstall.install'
                  ? ['downloadId']
                  : [
                        'systemSettings.get',
                        'systemSettings.set',
                        'systemSettings.setConfirmed',
                      ].includes(key)
                    ? ['id']
                    : key === 'process.startProcess'
                      ? ['command']
                      : key === 'app.openIntent'
                        ? ['intentId', 'slots']
                        : key === 'network.ping'
                          ? ['host']
                          : [])
    if (!Object.hasOwn(params, name)) return `Missing required parameter: ${name}`;

  return null;
}

const number = (v) => Number.isFinite(v) && v >= 0;

const percentage = (v) => number(v) && v <= 100;

const list = (v, predicate) =>
  Array.isArray(v) &&
  v.every((x) => x && typeof x === 'object' && !Array.isArray(x) && predicate(x));

export const verificationPredicates = {
  'desktop.launch': (d) => !!desktopSnapshot(d),
  ...Object.fromEntries(
    ['click', 'doubleClick', 'select', 'focus', 'scroll', 'type', 'press', 'hotkey'].map(
      (action) => [
        `desktop.${action}`,
        (d) => d.success === true && d.status === 'UI_ACTION_VERIFIED' && !!desktopSnapshot(d),
      ],
    ),
  ),
  'desktop.read': (d) =>
    d.success === true && d.status === 'UI_ELEMENT_READ' && !!desktopSnapshot(d),
  'desktop.waitFor': (d) =>
    d.success === true && d.status === 'UI_ELEMENT_READY' && !!desktopSnapshot(d),
  'desktop.find': (d) =>
    d.success === true && d.status === 'UI_ELEMENTS_FOUND' && !!desktopSnapshot(d),
  'desktop.close': (d) =>
    d.success === true &&
    d.status === 'UI_WINDOW_CLOSED' &&
    d.verification?.criterion === 'window_absent',
  'desktop.open': (d) => !!desktopSnapshot(d),
  'desktop.observe': (d) => !!desktopSnapshot(d),
  'desktop.act': (d) =>
    d.success === true && d.status === 'UI_ACTION_VERIFIED' && !!desktopSnapshot(d),
  'desktop.actConfirmed': (d) =>
    d.success === true && d.status === 'UI_ACTION_VERIFIED' && !!desktopSnapshot(d),
  'desktop.input': (d) =>
    d.success === true && d.status === 'UI_ACTION_VERIFIED' && !!desktopSnapshot(d),
  'desktop.inputConfirmed': (d) =>
    d.success === true && d.status === 'UI_ACTION_VERIFIED' && !!desktopSnapshot(d),
  'desktop.verify': (d, p) => desktopCompletion(d, p.goal),
  'desktop.saveAs': (d) =>
    d.success === true &&
    d.status === 'FILE_SAVED' &&
    string(d.path) &&
    d.verification?.status === 'verified' &&
    d.verification.criterion === 'file_on_disk' &&
    Number.isFinite(Date.parse(d.verification.observedAt)),
  ...Object.fromEntries(
    Object.keys(browserSchemas).map((action) => [
      `browser.${action}`,
      (d, p) =>
        d.success === true &&
        d.action === action &&
        (action !== 'search' || d.verification?.query === p.query) &&
        (action !== 'navigate' || !!d.verification?.requestedUrl) &&
        d.status === 'BROWSER_ACTION_COMPLETED' &&
        d.verification?.status === 'verified' &&
        d.verification?.criterion === 'browser_dom' &&
        string(d.url) &&
        Number.isFinite(Date.parse(d.verification.observedAt)),
    ]),
  ),

  'uiAutomation.calculate': (d, p) =>
    d.success === true &&
    d.status === 'UI_ACTION_COMPLETED' &&
    d.expression === p.expression &&
    string(d.displayText) &&
    integer(1, Number.MAX_SAFE_INTEGER)(d.processId) &&
    d.verification?.status === 'verified' &&
    d.verification.criterion === 'calculator_display' &&
    Number.isFinite(Date.parse(d.verification.observedAt)),

  'uiAutomation.typeInNotepad': (d) =>
    d.success === true &&
    d.status === 'UI_ACTION_COMPLETED' &&
    integer(1, Number.MAX_SAFE_INTEGER)(d.processId) &&
    d.verification?.status === 'verified' &&
    d.verification.criterion === 'notepad_text' &&
    Number.isFinite(Date.parse(d.verification.observedAt)),

  'systemSettings.list': (d) =>
    d.success === true &&
    Array.isArray(d.settings) &&
    d.settings.length > 0 &&
    d.settings.every((s) => string(s.id) && typeof s.available === 'boolean'),

  'systemSettings.get': (d, p) => d.success === true && d.id === p.id && d.value !== undefined,

  // A change counts only when the value read back from Windows matches; a bare "applied" is not evidence.
  'systemSettings.set': (d, p) =>
    d.success === true &&
    ['SETTING_APPLIED', 'SETTING_UNCHANGED'].includes(d.status) &&
    d.id === p.id &&
    d.verification?.status === 'verified' &&
    d.verification.criterion === 'readback' &&
    Number.isFinite(Date.parse(d.verification.observedAt)),

  // Some confirmed changes (Windows optional features) only show after a restart: that is reported, not claimed as applied.
  'systemSettings.setConfirmed': (d, p) =>
    d.success === true &&
    d.id === p.id &&
    ((['SETTING_APPLIED', 'SETTING_UNCHANGED'].includes(d.status) &&
      d.verification?.status === 'verified') ||
      (d.status === 'SETTING_PENDING_RESTART' &&
        d.restartRequired === true &&
        d.verification?.status === 'pending-restart')) &&
    d.verification.criterion === 'readback' &&
    Number.isFinite(Date.parse(d.verification.observedAt)),

  'winget.search': (d, p) =>
    d.success === true &&
    d.query === p.query &&
    Array.isArray(d.results) &&
    d.results.every((r) => string(r.id) && string(r.name)),

  'software.providers': (d) => d.success === true && Array.isArray(d.providers),
  'software.discover': (d) =>
    d.success === true &&
    string(d.discoveryId) &&
    Array.isArray(d.candidates) &&
    d.candidates.every((c) => string(c.candidateId) && string(c.name) && string(c.publisher)),
  'software.discoverOnline': (d) =>
    d.success === true &&
    string(d.discoveryId) &&
    Array.isArray(d.candidates) &&
    d.candidates.every((c) => string(c.candidateId) && string(c.name) && string(c.publisher)),
  'software.resolve': (d) =>
    d.success === true &&
    ['PLAN_READY', 'HANDOFF_REQUIRED'].includes(d.status) &&
    string(d.plan?.planId || d.planId),
  'software.download': (d, p) => d.planId === p.planId && verifiedSoftwareDownload(d),
  'software.install': (d, p) => d.planId === p.planId && verifiedSoftwareInstall(d),
  'software.verify': (d, p) => d.planId === p.planId && verifiedSoftwareInstall(d),

  // Only a package the package manager itself lists as installed counts; a bare exit code is not enough.
  'winget.install': (d, p) =>
    d.success === true &&
    ['INSTALLED', 'ALREADY_INSTALLED'].includes(d.status) &&
    d.packageId === p.packageId &&
    d.verification?.status === 'verified' &&
    d.verification.criterion === 'winget_list' &&
    Number.isFinite(Date.parse(d.verification.observedAt)),

  'webInstall.find': (d, p) =>
    d.success === true &&
    d.query === p.query &&
    Array.isArray(d.results) &&
    d.results.every((r) => string(r.candidateId) && string(r.host)),

  // A file that is signed, identifies itself as the app, and has a recorded hash. It has NOT been run.
  'webInstall.download': (d) =>
    d.success === true &&
    d.status === 'DOWNLOADED_VERIFIED' &&
    d.signature === 'Valid' &&
    /^[a-f0-9]{64}$/.test(d.sha256) &&
    string(d.publisher) &&
    string(d.host),

  // Installer exit codes are not proof: only the app being found afterwards counts as verified.
  'webInstall.install': (d) =>
    d.success === true &&
    d.status === 'INSTALLER_COMPLETED' &&
    d.verification?.status === 'verified' &&
    d.verification.criterion === 'app_registry' &&
    Number.isFinite(Date.parse(d.verification.observedAt)),

  'app.resolveTarget': (d) =>
    d.success === true &&
    d.status === 'TARGET_RESOLVED' &&
    !!d.target &&
    string(d.target.path || d.target.value),

  'app.openWithTarget': (d, p) => targetEvidence(d, p.target, p.app),

  'app.openIntent': (d, p) =>
    d.success === true &&
    d.status === 'APP_INTENT_OPENED' &&
    d.intentId === p.intentId &&
    integer(1, Number.MAX_SAFE_INTEGER)(d.processId) &&
    d.readiness?.status === 'ready',

  'app.openApp': (d) =>
    d.success === true &&
    d.status === 'APP_OPENED' &&
    string(d.app?.id) &&
    integer(1, Number.MAX_SAFE_INTEGER)(d.processId) &&
    d.readiness?.pid === d.processId &&
    d.readiness.status === 'ready' &&
    ['executable_process', 'activated_process', 'window_title'].includes(d.readiness.criterion) &&
    Number.isFinite(Date.parse(d.readiness.observedAt)),

  'windowsRepair.inspectSpooler': (d) => typeof d.diagnosisId === 'string',

  'windowsRepair.startSpooler': (d) =>
    d.verificationStatus === 'passed' && verified(d.samples, d.baseline),

  'windowsRepair.verifySpooler': (d) =>
    d.verificationStatus === 'passed' && verified(d.samples, d.baseline),

  'process.startProcess': (d, p) =>
    integer(1, Number.MAX_SAFE_INTEGER)(d.pid) &&
    d.command === p.command &&
    d.readiness?.status === 'ready' &&
    d.readiness.pid === d.pid &&
    d.readiness.criterion === 'responding_window' &&
    string(d.readiness.windowTitle) &&
    Number.isFinite(Date.parse(d.readiness.observedAt)),

  'hardware.systemInfo': (d) =>
    string(d.hostname) &&
    string(d.platform) &&
    string(d.cpuModel) &&
    integer(1, 4096)(d.cpuCores) &&
    number(d.totalMemory) &&
    number(d.freeMemory) &&
    d.freeMemory <= d.totalMemory,

  'hardware.cpuUsage': (d) =>
    percentage(d.usagePercent) &&
    list(d.perCore, (x) => integer(0, 4095)(x.core) && percentage(x.usagePercent)) &&
    d.perCore.length > 0,

  'hardware.memoryUsage': (d) =>
    number(d.total) &&
    d.total > 0 &&
    number(d.free) &&
    number(d.used) &&
    d.free + d.used === d.total &&
    percentage(d.usagePercent),

  'hardware.diskInfo': (d) =>
    list(
      d.drives,
      (x) => string(x.DeviceID) && number(x.Size) && number(x.FreeSpace) && x.FreeSpace <= x.Size,
    ),

  'hardware.networkAdapters': (d) => list(d.adapters, (x) => string(x.Description)),

  'network.ipConfig': (d) => list(d.adapters, (x) => string(x.name)),

  'network.netstat': (d) =>
    list(d.connections, (x) => string(x.LocalAddress) && integer(0, 65535)(x.LocalPort)),

  'process.list': (d) =>
    list(d.processes, (x) => integer(0, Number.MAX_SAFE_INTEGER)(x.pid) && string(x.name)) &&
    integer(0, Number.MAX_SAFE_INTEGER)(d.total) &&
    d.total >= d.processes.length,

  'network.ping': (d, p) =>
    d.host === p.host &&
    d.sent === (p.count ?? 4) &&
    integer(1, d.sent)(d.received) &&
    d.lost === d.sent - d.received &&
    percentage(d.lossPercent) &&
    d.roundTrip &&
    number(d.roundTrip.min) &&
    number(d.roundTrip.avg) &&
    number(d.roundTrip.max) &&
    d.roundTrip.min <= d.roundTrip.avg &&
    d.roundTrip.avg <= d.roundTrip.max,
};

export function verifyCapabilities(steps) {
  if (!steps.length || steps.some((s) => !verificationPredicates[`${s.tool}.${s.action}`]))
    return null;

  const success = steps.every(
    (s) =>
      s.status === 'done' &&
      !validateCapability(s.tool, s.action, s.params) &&
      s.observation?.success === true &&
      s.observation.toolCallId === s.toolCallId &&
      s.observation.data &&
      verificationPredicates[`${s.tool}.${s.action}`](s.observation.data, s.params),
  );

  const manual = steps.some(
    (s) => s.observation?.reconciliation?.provenance === 'human_attestation',
  );

  return {
    success,
    scope: manual ? 'human_attestation' : 'capability_result',
    summary: success
      ? manual
        ? 'Manually reviewed results satisfy the capability data checks; completion relies on the reviewer’s evidence.'
        : 'Supported capability results passed deterministic checks.'
      : 'Capability results failed deterministic checks.',
    recommendation: success ? '' : 'Inspect the returned capability data before continuing.',
  };
}
