// Code-owned catalog of Windows settings the agent may CHANGE (the "open a Settings page" catalog is SettingsCatalog.js).
//
// The model never supplies a command, registry path or script: it picks an id from this list and a typed value
// (boolean or a bounded integer). SystemSettings.ps1 implements exactly these ids and nothing else.
//
//   SAFE_WRITE  reversible, local, cosmetic/audio - applied immediately and verified by reading the value back
//   DANGEROUS   can cut connectivity or disconnect devices - always goes through the human ConfirmationGate
const failure = (code, message = code) => Object.assign(new Error(message), { code });

const DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'dark-mode', name: 'Dark mode', aliases: ['dark theme', 'night theme', 'light mode', 'theme'], type: 'boolean', risk: 'SAFE_WRITE',
    description: 'Windows and app color theme. enabled=true selects dark mode, enabled=false selects light mode.' }),
  Object.freeze({ id: 'brightness', name: 'Screen brightness', aliases: ['display brightness', 'screen light'], type: 'percent', min: 10, max: 100, risk: 'SAFE_WRITE',
    description: 'Built-in display brightness in percent (10-100; never lower, so the screen cannot be left unreadable). Not available on most desktop monitors.' }),
  Object.freeze({ id: 'volume', name: 'Speaker volume', aliases: ['sound', 'audio volume', 'master volume'], type: 'percent', min: 0, max: 100, risk: 'SAFE_WRITE',
    description: 'Master volume of the default speakers in percent (0-100).' }),
  Object.freeze({ id: 'mute', name: 'Speaker mute', aliases: ['sound mute', 'silence'], type: 'boolean', risk: 'SAFE_WRITE',
    description: 'Mute state of the default speakers. enabled=true mutes, enabled=false unmutes.' }),
  Object.freeze({ id: 'mic-mute', name: 'Microphone mute', aliases: ['mic mute', 'microphone'], type: 'boolean', risk: 'SAFE_WRITE',
    description: 'Mute state of the default microphone. enabled=true mutes it, enabled=false unmutes it.' }),
  Object.freeze({ id: 'transparency', name: 'Transparency effects', aliases: ['acrylic', 'mica', 'translucent'], type: 'boolean', risk: 'SAFE_WRITE',
    description: 'Transparency effects in Windows. enabled=true turns them on, enabled=false turns them off.' }),
  Object.freeze({ id: 'file-extensions', name: 'File extensions', aliases: ['filename extensions', 'show extensions'], type: 'boolean', risk: 'SAFE_WRITE', labels: ['shown', 'hidden'],
    description: 'Whether File Explorer shows file name extensions (.txt, .mp4). enabled=true shows them. Already-open Explorer windows may need a refresh (F5).' }),
  Object.freeze({ id: 'hidden-files', name: 'Hidden files', aliases: ['show hidden', 'hidden items'], type: 'boolean', risk: 'SAFE_WRITE', labels: ['shown', 'hidden'],
    description: 'Whether File Explorer shows hidden files and folders. enabled=true shows them. Already-open Explorer windows may need a refresh (F5).' }),
  Object.freeze({ id: 'notifications', name: 'App notifications', aliases: ['toast notifications', 'notification banners', 'alerts'], type: 'boolean', risk: 'SAFE_WRITE',
    description: 'Notification banners from apps and the system. enabled=false silences them all.' }),
  Object.freeze({ id: 'clipboard-history', name: 'Clipboard history', aliases: ['clipboard'], type: 'boolean', risk: 'SAFE_WRITE',
    description: 'Clipboard history (Win+V). enabled=true keeps recent copied items.' }),
  Object.freeze({ id: 'screen-timeout', name: 'Screen timeout', aliases: ['screen off', 'turn off display after', 'display timeout'], type: 'number', unit: 'minutes', min: 0, max: 720, zeroLabel: 'never', risk: 'SAFE_WRITE',
    description: 'Minutes of inactivity before the screen turns off, applied to both plugged-in and battery. 0 means never.' }),
  Object.freeze({ id: 'sleep-timeout', name: 'Sleep timeout', aliases: ['sleep after', 'standby timeout', 'auto sleep'], type: 'number', unit: 'minutes', min: 0, max: 720, zeroLabel: 'never', risk: 'SAFE_WRITE',
    description: 'Minutes of inactivity before the PC sleeps, applied to both plugged-in and battery. 0 means never.' }),
  Object.freeze({ id: 'mouse-speed', name: 'Pointer speed', aliases: ['mouse sensitivity', 'cursor speed', 'mouse speed'], type: 'number', unit: 'level', min: 1, max: 20, risk: 'SAFE_WRITE',
    description: 'Mouse pointer speed from 1 (slowest) to 20 (fastest); 10 is the Windows default.' }),
  Object.freeze({ id: 'hibernate-timeout', name: 'Hibernate timeout', aliases: ['hibernate after', 'hibernation timer'], type: 'number', unit: 'minutes', min: 0, max: 1440, zeroLabel: 'never', risk: 'SAFE_WRITE',
    description: 'Minutes of inactivity before the PC hibernates, applied to both plugged-in and battery. 0 means never.' }),
  Object.freeze({ id: 'disk-timeout', name: 'Hard disk timeout', aliases: ['turn off hard disk after', 'disk sleep', 'drive timeout'], type: 'number', unit: 'minutes', min: 0, max: 1440, zeroLabel: 'never', risk: 'SAFE_WRITE',
    description: 'Minutes of inactivity before hard disks are powered down, applied to both plugged-in and battery. 0 means never.' }),
  Object.freeze({ id: 'lock-screen-timeout', name: 'Lock screen timeout', aliases: ['lock screen display off', 'screen off on lock screen'], type: 'number', unit: 'minutes', min: 0, max: 60, zeroLabel: 'never', risk: 'SAFE_WRITE',
    description: 'Minutes the lock screen stays on before the display turns off, applied to both plugged-in and battery. 0 means never.' }),
  Object.freeze({ id: 'pointer-trails', name: 'Pointer trails', aliases: ['mouse trails', 'cursor trails'], type: 'number', unit: 'length', min: 0, max: 20, forbid: [1], zeroLabel: 'off', risk: 'SAFE_WRITE',
    description: 'Mouse pointer trail length. 0 turns trails off; 2 (short) to 20 (long) turns them on. The value 1 is not accepted.' }),
  Object.freeze({ id: 'keyboard-repeat-delay', name: 'Keyboard repeat delay', aliases: ['key repeat delay', 'repeat delay'], type: 'number', unit: 'level', min: 0, max: 3, risk: 'SAFE_WRITE',
    description: 'How long a key must be held before it starts repeating: 0 (shortest) to 3 (longest).' }),
  Object.freeze({ id: 'menu-show-delay', name: 'Menu show delay', aliases: ['submenu delay', 'menu delay'], type: 'number', unit: 'ms', min: 0, max: 4000, risk: 'SAFE_WRITE',
    description: 'Delay before a submenu opens when you hover over it, in milliseconds (0-4000; Windows default is 400).' }),
  Object.freeze({ id: 'mic-volume', name: 'Microphone volume', aliases: ['mic level', 'input volume', 'microphone level'], type: 'percent', min: 0, max: 100, risk: 'SAFE_WRITE',
    description: 'Input level of the default microphone in percent (0-100).' }),
  Object.freeze({ id: 'pointer-precision', name: 'Pointer precision', aliases: ['mouse acceleration', 'enhance pointer precision'], type: 'boolean', risk: 'SAFE_WRITE', labels: ['on', 'off'],
    description: 'Enhance pointer precision (mouse acceleration). enabled=true turns it on, enabled=false gives a constant 1:1 pointer.' }),
  Object.freeze({ id: 'scroll-lines', name: 'Scroll lines', aliases: ['scroll speed', 'mouse wheel scroll', 'scrolling speed'], type: 'number', unit: 'lines', min: 1, max: 100, risk: 'SAFE_WRITE',
    description: 'Lines scrolled per mouse-wheel notch, 1-100 (Windows default is 3).' }),
  Object.freeze({ id: 'double-click-speed', name: 'Double-click speed', aliases: ['double click timing', 'double-click time'], type: 'number', unit: 'ms', min: 200, max: 900, risk: 'SAFE_WRITE',
    description: 'Maximum time between the two clicks of a double-click, in milliseconds (200-900; Windows default is 500; larger is more forgiving).' }),
  Object.freeze({ id: 'keyboard-repeat-rate', name: 'Keyboard repeat rate', aliases: ['key repeat', 'repeat rate', 'typing repeat speed'], type: 'number', unit: 'level', min: 0, max: 31, risk: 'SAFE_WRITE',
    description: 'How fast a held key repeats, from 0 (slowest) to 31 (fastest).' }),
  Object.freeze({ id: 'power-mode', name: 'Power mode', aliases: ['performance mode', 'power plan', 'battery mode'], type: 'choice', risk: 'SAFE_WRITE',
    options: Object.freeze([
      Object.freeze({ id: 'best-power-efficiency', label: 'Best power efficiency' }),
      Object.freeze({ id: 'balanced', label: 'Balanced' }),
      Object.freeze({ id: 'best-performance', label: 'Best performance' }),
    ]),
    description: 'Windows 11 power mode. option is one of best-power-efficiency (longest battery), balanced, best-performance (fastest, uses more power).' }),
  Object.freeze({ id: 'airplane-mode', name: 'Airplane mode', aliases: ['flight mode'], type: 'boolean', risk: 'DANGEROUS', labels: ['on', 'off'], warnWhen: true,
    warning: 'Airplane mode turns off Wi-Fi, Bluetooth and every other radio: you will lose the internet connection and paired devices.',
    description: 'Airplane mode (all radios). enabled=true turns every radio off, enabled=false turns them back on. Requires human confirmation.' }),
  Object.freeze({ id: 'lid-close-action', name: 'Lid close action', aliases: ['close the lid', 'laptop lid', 'lid closing'], type: 'choice', risk: 'DANGEROUS',
    options: Object.freeze([
      Object.freeze({ id: 'do-nothing', label: 'Do nothing' }),
      Object.freeze({ id: 'sleep', label: 'Sleep' }),
      Object.freeze({ id: 'hibernate', label: 'Hibernate' }),
      Object.freeze({ id: 'shut-down', label: 'Shut down' }),
    ]),
    warning: 'This changes what happens whenever the lid is closed, on battery and plugged in. "Do nothing" can leave a closed laptop running (and hot) in a bag.',
    description: 'What closing the laptop lid does, applied to both battery and plugged-in. option is do-nothing, sleep, hibernate or shut-down. Requires human confirmation.' }),
  Object.freeze({ id: 'power-button-action', name: 'Power button action', aliases: ['power button', 'what the power button does'], type: 'choice', risk: 'DANGEROUS',
    options: Object.freeze([
      Object.freeze({ id: 'do-nothing', label: 'Do nothing' }),
      Object.freeze({ id: 'sleep', label: 'Sleep' }),
      Object.freeze({ id: 'hibernate', label: 'Hibernate' }),
      Object.freeze({ id: 'shut-down', label: 'Shut down' }),
    ]),
    warning: 'This changes what pressing the power button does, on battery and plugged in.',
    description: 'What pressing the power button does, applied to both battery and plugged-in. option is do-nothing, sleep, hibernate or shut-down. Requires human confirmation.' }),
  Object.freeze({ id: 'mouse-primary-button', name: 'Primary mouse button', aliases: ['swap mouse buttons', 'left-handed mouse', 'right-handed mouse', 'main mouse button'], type: 'choice', risk: 'DANGEROUS',
    options: Object.freeze([Object.freeze({ id: 'left', label: 'Left button' }), Object.freeze({ id: 'right', label: 'Right button' })]),
    warning: 'This swaps the mouse buttons for every app until you swap them back.',
    description: 'Which mouse button is the primary (click) button. option is left (default) or right (left-handed). Requires human confirmation.' }),
  Object.freeze({ id: 'cursor-blink-rate', name: 'Cursor blink rate', aliases: ['caret blink', 'text cursor blink', 'cursor blink speed'], type: 'number', unit: 'ms', min: 200, max: 1200, risk: 'SAFE_WRITE',
    description: 'Blink interval of the text cursor in milliseconds, 200 (fast) to 1200 (slow); Windows default is about 530.' }),
  Object.freeze({ id: 'clock-24-hour', name: 'Clock format', aliases: ['24 hour clock', '12 hour clock', 'time format', 'military time'], type: 'boolean', risk: 'SAFE_WRITE', labels: ['24-hour', '12-hour'],
    description: 'Time format of the taskbar clock and most apps (the short time). enabled=true shows 24-hour time such as 18:30, enabled=false shows 12-hour time such as 6:30 PM. A separate long format with seconds is left unchanged.' }),
  Object.freeze({ id: 'animations', name: 'Window animations', aliases: ['animation effects', 'show animations', 'reduce motion'], type: 'boolean', risk: 'SAFE_WRITE', labels: ['on', 'off'],
    description: 'Animations in Windows (fading, sliding). enabled=false turns them off, which also helps accessibility and slower PCs.' }),
  Object.freeze({ id: 'drag-window-contents', name: 'Show window contents while dragging', aliases: ['drag full windows', 'window drag contents'], type: 'boolean', risk: 'SAFE_WRITE', labels: ['shown', 'hidden'],
    description: 'enabled=true shows the whole window while you drag it; false shows only its outline.' }),
  Object.freeze({ id: 'snap-to-default-button', name: 'Snap pointer to default button', aliases: ['pointer snap', 'snap to'], type: 'boolean', risk: 'SAFE_WRITE', labels: ['on', 'off'],
    description: 'enabled=true automatically moves the mouse pointer to the default button in a dialog box.' }),
  Object.freeze({ id: 'hide-pointer-while-typing', name: 'Hide pointer while typing', aliases: ['hide cursor while typing', 'mouse vanish'], type: 'boolean', risk: 'SAFE_WRITE', labels: ['on', 'off'],
    description: 'enabled=true hides the mouse pointer while you type and brings it back when you move the mouse.' }),
  Object.freeze({ id: 'pointer-location-on-ctrl', name: 'Show pointer location with Ctrl', aliases: ['find my mouse', 'pointer sonar', 'locate pointer'], type: 'boolean', risk: 'SAFE_WRITE', labels: ['on', 'off'],
    description: 'enabled=true highlights the pointer when you press the Ctrl key.' }),
  Object.freeze({ id: 'usb-selective-suspend', name: 'USB selective suspend', aliases: ['usb power saving', 'usb suspend'], type: 'boolean', risk: 'SAFE_WRITE', labels: ['enabled', 'disabled'],
    description: 'Lets Windows power down idle USB devices to save power. enabled=false can fix USB devices that keep disconnecting. Separate plugged-in / on-battery values.' }),
  Object.freeze({ id: 'dim-timeout', name: 'Display dim timeout', aliases: ['dim display after', 'dim the screen after', 'screen dim timer'], type: 'number', unit: 'minutes', min: 0, max: 1440, zeroLabel: 'never', risk: 'SAFE_WRITE',
    description: 'Minutes of inactivity before the display dims (before it turns off). 0 means never. Separate plugged-in / on-battery values.' }),
  Object.freeze({ id: 'max-processor-state', name: 'Maximum processor state', aliases: ['cpu limit', 'max cpu speed', 'processor cap', 'limit cpu'], type: 'number', unit: '%', min: 20, max: 100, risk: 'SAFE_WRITE',
    description: 'Caps CPU speed as a percentage of maximum (20-100). Lower values run cooler and quieter and save battery but make the PC slower; 100 is no cap. Separate plugged-in / on-battery values.' }),
  Object.freeze({ id: 'battery-saver-threshold', name: 'Battery saver threshold', aliases: ['battery saver level', 'turn on battery saver at'], type: 'number', unit: '%', min: 0, max: 100, zeroLabel: 'never', batteryOnly: true, risk: 'SAFE_WRITE',
    description: 'Battery percentage at which battery saver turns on automatically (0 = never). Applies only on battery.' }),
  Object.freeze({ id: 'wake-timers', name: 'Wake timers', aliases: ['allow wake timers', 'scheduled wake'], type: 'choice', risk: 'SAFE_WRITE',
    options: Object.freeze([Object.freeze({ id: 'disabled', label: 'Disabled' }), Object.freeze({ id: 'enabled', label: 'Enabled' }), Object.freeze({ id: 'important-only', label: 'Important wake timers only' })]),
    description: 'Whether scheduled tasks may wake the PC from sleep. option is disabled, enabled or important-only. Separate plugged-in / on-battery values.' }),
  Object.freeze({ id: 'cooling-policy', name: 'System cooling policy', aliases: ['cooling mode', 'fan policy'], type: 'choice', risk: 'SAFE_WRITE',
    options: Object.freeze([Object.freeze({ id: 'passive', label: 'Passive (slow the CPU first)' }), Object.freeze({ id: 'active', label: 'Active (fan first)' })]),
    description: 'How the PC reacts to heat. option is passive (throttle the CPU before spinning the fan up, quieter) or active (spin the fan up first). Separate plugged-in / on-battery values.' }),
  Object.freeze({ id: 'wifi', name: 'Wi-Fi', aliases: ['wi-fi', 'wireless', 'wlan'], type: 'boolean', risk: 'DANGEROUS',
    warning: 'Turning Wi-Fi off can disconnect this PC from the internet.',
    description: 'Wi-Fi radio. enabled=true turns it on, enabled=false turns it off. Requires human confirmation.' }),
  Object.freeze({ id: 'bluetooth', name: 'Bluetooth', aliases: ['bt'], type: 'boolean', risk: 'DANGEROUS',
    warning: 'Turning Bluetooth off disconnects paired devices such as headphones and mice.',
    description: 'Bluetooth radio. enabled=true turns it on, enabled=false turns it off. Requires human confirmation.' }),
]);

// Windows keeps these power-plan settings separately for "plugged in" and "on battery"; a request may target either or both.
export const SOURCES = Object.freeze(['both', 'plugged-in', 'battery']);
const PER_SOURCE = new Set(['screen-timeout', 'sleep-timeout', 'hibernate-timeout', 'disk-timeout', 'lock-screen-timeout', 'dim-timeout', 'max-processor-state',
  'usb-selective-suspend', 'wake-timers', 'cooling-policy', 'lid-close-action', 'power-button-action']);
export const SETTINGS = Object.freeze(DEFINITIONS.map(s => (PER_SOURCE.has(s.id) ? Object.freeze({ ...s, perSource: true }) : s)));

export const SETTING_IDS = Object.freeze(SETTINGS.map(s => s.id));
export const OPTION_IDS = Object.freeze([...new Set(SETTINGS.flatMap(s => (s.options ?? []).map(o => o.id)))]);
export const settingById = id => SETTINGS.find(s => s.id === id);
export function requireSetting(id) {
  const setting = settingById(id);
  if (!setting) throw failure('UNKNOWN_SETTING', `Unknown setting. Use one of: ${SETTING_IDS.join(', ')}.`);
  return setting;
}

/**
 * Validate one change request against the catalog. Returns {setting, value} (value is a boolean or an integer),
 * or throws a coded error before anything is executed or any human is asked.
 */
function planValue(params) {
  const keys = Object.keys(params ?? {});
  if (keys.some(k => !['id', 'enabled', 'level', 'option', 'source'].includes(k))) throw failure('INVALID_INPUT', 'Only id, enabled, level, option and source are accepted.');
  const setting = requireSetting(params?.id);
  if (setting.type === 'choice') {
    if (params.enabled !== undefined || params.level !== undefined || typeof params.option !== 'string') throw failure('INVALID_INPUT', `${setting.name} takes option (one of: ${setting.options.map(o => o.id).join(', ')}) and nothing else.`);
    if (!setting.options.some(o => o.id === params.option)) throw failure('INVALID_INPUT', `Unknown option. Choose one of: ${setting.options.map(o => o.id).join(', ')}.`);
    return { setting, value: params.option };
  }
  if (setting.type === 'boolean') {
    if (typeof params.enabled !== 'boolean' || params.level !== undefined || params.option !== undefined) throw failure('INVALID_INPUT', `${setting.name} takes enabled (true/false) and no level.`);
    return { setting, value: params.enabled };
  }
  if (!Number.isInteger(params.level) || params.enabled !== undefined || params.option !== undefined) throw failure('INVALID_INPUT', `${setting.name} takes level (a whole number) and no enabled.`);
  if (setting.forbid?.includes(params.level)) throw failure('OUT_OF_RANGE', `${setting.name} cannot be ${params.level}. ${setting.description}`);
  if (params.level < setting.min || params.level > setting.max) throw failure('OUT_OF_RANGE', `${setting.name} must be between ${setting.min} and ${setting.max}.`);
  return { setting, value: params.level };
}

/**
 * Validate one change request: id, a typed value, and (for power-plan settings only) a source: both | plugged-in | battery.
 * Returns {setting, value, source}; source is undefined for settings that have no plugged-in / on-battery split.
 */
export function planChange(params) {
  const planned = planValue(params);
  const { setting } = planned;
  if (params.source !== undefined) {
    if (!setting.perSource) throw failure('INVALID_INPUT', `${setting.name} has no separate plugged-in / on-battery value.`);
    if (!SOURCES.includes(params.source)) throw failure('INVALID_INPUT', `source must be one of: ${SOURCES.join(', ')}.`);
  }
  return { ...planned, source: setting.perSource ? (params.source ?? 'both') : undefined };
}

/** Does the value read back from the machine satisfy the request? Percent values (brightness, volume) allow one step of rounding; everything else must match exactly. */
export const matches = (setting, wanted, actual) => setting.type === 'percent' ? Math.abs(Number(actual) - wanted) <= 1 : actual === wanted;
