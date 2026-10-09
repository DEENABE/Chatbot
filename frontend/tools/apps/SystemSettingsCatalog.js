// Code-owned catalog of Windows settings the agent may CHANGE (the "open a Settings page" catalog is SettingsCatalog.js).
//
// The model never supplies a command, registry path or script: it picks an id from this list and a typed value
// (boolean or a bounded integer). SystemSettings.ps1 implements exactly these ids and nothing else.
//
//   SAFE_WRITE  reversible, local, cosmetic/audio - applied immediately and verified by reading the value back
//   DANGEROUS   can cut connectivity, weaken privacy/security or change device behavior - always goes through the human ConfirmationGate;
//               entries with elevation: "admin" are additionally applied through a UAC prompt by SystemSettingsAdmin.ps1
const failure = (code, message = code) => Object.assign(new Error(message), { code });

// ---- Added settings (second catalog batch) -------------------------------------------------------------------
// Small builders keep these entries uniform. Nothing here changes the rules above: the model still picks an id and a typed value.
const toggle = (id, name, aliases, description, extra = {}) =>
  Object.freeze({
    id,
    name,
    aliases,
    type: 'boolean',
    risk: 'SAFE_WRITE',
    description,
    ...extra,
  });
const picker = (id, name, aliases, options, description, extra = {}) =>
  Object.freeze({
    id,
    name,
    aliases,
    type: 'choice',
    risk: 'SAFE_WRITE',
    options: Object.freeze(
      options.map(([optionId, label]) => Object.freeze({ id: optionId, label })),
    ),
    description,
    ...extra,
  });
// Privacy and security switches: no administrator rights, but a prompt-injected "turn on the microphone" must not go unnoticed.
const guarded = (id, name, aliases, description, warning, extra = {}) =>
  toggle(id, name, aliases, `${description} Requires human confirmation.`, {
    risk: 'DANGEROUS',
    warning,
    ...extra,
  });
// Needs administrator rights: always DANGEROUS (human confirmation) and applied by the UAC-elevated helper
// (SystemSettingsAdmin.ps1). Windows shows its own UAC prompt on top of our confirmation; nothing is elevated silently.
const admin = (id, name, aliases, description, warning, extra = {}) =>
  toggle(
    id,
    name,
    aliases,
    `${description} Needs administrator approval (Windows asks through UAC) and human confirmation.`,
    { risk: 'DANGEROUS', elevation: 'admin', warning, ...extra },
  );

const ADDED_DEFINITIONS = Object.freeze([
  // -- taskbar, Explorer and Start (per user, no administrator rights) --
  picker(
    'taskbar-alignment',
    'Taskbar alignment',
    ['taskbar position', 'taskbar icons', 'start button alignment'],
    [
      ['left', 'Left'],
      ['center', 'Center'],
    ],
    'Where the Windows 11 taskbar icons and Start button sit. May need Explorer to restart or a sign-out before the taskbar moves.',
  ),
  toggle(
    'task-view-button',
    'Task View button',
    ['task view', 'virtual desktops button'],
    'Task View button on the taskbar. enabled=true shows it.',
    { labels: ['shown', 'hidden'] },
  ),
  toggle(
    'taskbar-badges',
    'Taskbar app badges',
    ['taskbar badges', 'app badges'],
    'Unread-count badges on taskbar app icons.',
  ),
  toggle(
    'taskbar-all-displays',
    'Taskbar on all displays',
    ['taskbar on every monitor', 'multiple displays taskbar'],
    'Show the taskbar on every connected display, not just the main one.',
  ),
  picker(
    'taskbar-combine-buttons',
    'Combine taskbar buttons',
    ['group taskbar buttons', 'taskbar labels'],
    [
      ['always', 'Always'],
      ['when-full', 'When the taskbar is full'],
      ['never', 'Never'],
    ],
    'When windows of the same app are grouped into one taskbar button. May need Explorer to restart or a sign-out.',
  ),
  toggle(
    'clock-seconds',
    'Seconds in taskbar clock',
    ['show seconds', 'clock seconds'],
    'Show seconds in the taskbar clock. May need Explorer to restart.',
  ),
  toggle(
    'desktop-icons',
    'Desktop icons',
    ['show desktop icons', 'hide desktop icons'],
    'Whether icons are shown on the desktop. enabled=true shows them.',
    { labels: ['shown', 'hidden'] },
  ),
  toggle(
    'full-path-title-bar',
    'Full path in Explorer title bar',
    ['show full path', 'explorer path'],
    'Show the full folder path in the File Explorer title bar.',
  ),
  picker(
    'open-explorer-to',
    'Open File Explorer to',
    ['explorer start folder', 'explorer opens to'],
    [
      ['this-pc', 'This PC'],
      ['home', 'Home'],
    ],
    'The page File Explorer shows when it opens.',
  ),
  toggle(
    'compact-view',
    'Compact view in Explorer',
    ['compact mode', 'decrease space between items'],
    'Decrease the space between items in File Explorer lists.',
  ),
  toggle(
    'item-checkboxes',
    'Item check boxes in Explorer',
    ['checkboxes', 'select checkboxes'],
    'Show check boxes for selecting files and folders in File Explorer.',
  ),
  toggle(
    'folder-thumbnails',
    'Folder thumbnails',
    ['thumbnails', 'show thumbnails', 'icons only'],
    'Whether File Explorer shows thumbnails of files. enabled=false shows icons only.',
    { labels: ['shown', 'hidden'] },
  ),
  toggle(
    'recent-items',
    'Recent items in Start and Jump Lists',
    ['recent documents', 'recently opened items'],
    'Show recently opened items in Start, Jump Lists and File Explorer.',
  ),
  toggle(
    'quick-access-recent-files',
    'Recent files in Quick access',
    ['quick access recent', 'home recent files'],
    'Show recently used files in File Explorer Quick access / Home.',
  ),
  toggle(
    'quick-access-frequent-folders',
    'Frequent folders in Quick access',
    ['frequent folders', 'quick access folders'],
    'Show frequently used folders in File Explorer Quick access / Home.',
  ),
  toggle(
    'aero-shake',
    'Shake to minimize other windows',
    ['window shake', 'title bar shake'],
    "Shaking a window's title bar minimizes all other windows.",
  ),
  toggle(
    'classic-context-menu',
    'Classic right-click menu',
    ['old context menu', 'windows 10 context menu', 'show more options'],
    'The full Windows 10 style right-click menu instead of the short Windows 11 one. Takes effect after Explorer restarts or you sign out.',
  ),
  // -- personalization, privacy, accessibility, gaming, notifications --
  toggle(
    'accent-on-taskbar',
    'Accent color on Start and taskbar',
    ['accent color taskbar', 'colored taskbar'],
    'Use the accent color on Start and the taskbar (Windows only shows it in dark mode).',
  ),
  toggle(
    'accent-on-title-bars',
    'Accent color on title bars',
    ['title bar color', 'window border color'],
    'Use the accent color on window title bars and borders.',
  ),
  toggle(
    'advertising-id',
    'Advertising ID',
    ['personalized ads', 'ad id'],
    'Let apps use your advertising ID for personalized ads. enabled=false turns it off.',
  ),
  toggle(
    'tips-and-suggestions',
    'Tips and suggestions',
    ['windows tips', 'suggested content', 'welcome experience'],
    'Windows tips, tricks and suggestions notifications.',
  ),
  toggle(
    'game-mode',
    'Game Mode',
    ['gaming mode'],
    'Windows Game Mode, which prioritises the game you are playing.',
  ),
  toggle(
    'mono-audio',
    'Mono audio',
    ['mono sound', 'single channel audio'],
    'Mix left and right audio into one channel. May need a sign-out before running apps pick it up.',
  ),
  toggle(
    'always-show-scrollbars',
    'Always show scroll bars',
    ['scrollbars', 'auto hide scrollbars'],
    'Keep scroll bars visible instead of hiding them. Running apps may need a restart.',
  ),
  toggle(
    'notification-sounds',
    'Notification sounds',
    ['notification sound', 'toast sound'],
    'Allow notifications to play sounds.',
  ),
  toggle(
    'storage-sense',
    'Storage Sense',
    ['automatic cleanup', 'auto clean temp files'],
    'Storage Sense automatically frees space by removing temporary files.',
  ),
  toggle(
    'adaptive-brightness',
    'Adaptive brightness',
    ['auto brightness', 'automatic brightness'],
    'Let the ambient light sensor adjust the screen brightness. Only on PCs with a light sensor.',
    { perSource: true },
  ),
  guarded(
    'camera-access',
    'Camera access',
    ['webcam access', 'allow apps camera'],
    'Whether apps may use the camera for your account. enabled=false blocks all apps.',
    'Allowing camera access lets apps use your camera.',
    { warnWhen: true },
  ),
  guarded(
    'microphone-access',
    'Microphone access',
    ['mic access', 'allow apps microphone'],
    'Whether apps may use the microphone for your account. enabled=false blocks all apps.',
    'Allowing microphone access lets apps listen through your microphone.',
    { warnWhen: true },
  ),
  guarded(
    'location-access',
    'Location access',
    ['location services', 'allow apps location'],
    'Whether apps may use your location for your account. enabled=false blocks all apps.',
    'Allowing location access lets apps see where this PC is.',
    { warnWhen: true },
  ),
  guarded(
    'sign-in-on-wake',
    'Require sign-in on wake',
    ['password on wake', 'sign in after sleep', 'require password on resume'],
    'Whether Windows asks for your sign-in when the PC wakes from sleep. Plugged-in and on-battery are separate.',
    'Without it, anyone who wakes this PC can use it without signing in.',
    { perSource: true },
  ),
  // -- administrator settings: read without elevation, changed through the UAC-elevated helper --
  // The firewall can only be turned ON here: switching it off is blocked by policy (like security.disableFirewall in the registry).
  admin(
    'firewall-private',
    'Windows Firewall (private networks)',
    ['firewall private', 'home network firewall'],
    'Windows Defender Firewall for private networks. Only enabled=true (turn it on) is allowed; turning it off is blocked by policy.',
    'Windows Firewall will be turned on for private networks.',
    { forbidOff: true },
  ),
  admin(
    'firewall-public',
    'Windows Firewall (public networks)',
    ['firewall public', 'public network firewall'],
    'Windows Defender Firewall for public networks such as cafes. Only enabled=true (turn it on) is allowed; turning it off is blocked by policy.',
    'Windows Firewall will be turned on for public networks.',
    { forbidOff: true },
  ),
  admin(
    'firewall-domain',
    'Windows Firewall (domain networks)',
    ['firewall domain', 'work network firewall'],
    'Windows Defender Firewall for domain (work) networks. Only enabled=true (turn it on) is allowed; turning it off is blocked by policy.',
    'Windows Firewall will be turned on for domain networks.',
    { forbidOff: true },
  ),
  admin(
    'hibernate',
    'Hibernate',
    ['hibernation', 'hiberfile', 'enable hibernate'],
    'Hibernation support (the hiberfile). enabled=false also turns off Fast Startup and frees disk space.',
    'Turning hibernate off deletes the hibernation file and turns off Fast Startup.',
  ),
  admin(
    'fast-startup',
    'Fast Startup',
    ['fast boot', 'hybrid shutdown'],
    'Fast Startup makes shutdown-then-start quicker. Needs hibernate to be on. May need a restart to take effect.',
    'Turning Fast Startup off makes the next start slower.',
  ),
  admin(
    'remote-desktop',
    'Remote Desktop',
    ['rdp', 'remote access', 'allow remote connections'],
    'Allow other PCs to connect to this PC with Remote Desktop (not available on Windows Home).',
    'Allowing Remote Desktop lets other devices on the network try to sign in to this PC.',
    { warnWhen: true },
  ),
  admin(
    'long-paths',
    'Long file paths',
    ['long path support', '260 character limit', 'max path'],
    'Allow file paths longer than 260 characters. Apps must also support it; a restart may be needed.',
    'Some old apps may misbehave with very long paths.',
    { warnWhen: true },
  ),
  admin(
    'feature-wsl',
    'Windows Subsystem for Linux',
    ['wsl', 'linux subsystem'],
    'The Windows Subsystem for Linux optional feature. Needs a restart.',
    'This turns a Windows feature on or off and needs a restart.',
    { warnAlways: true },
  ),
  admin(
    'feature-virtual-machine-platform',
    'Virtual Machine Platform',
    ['vmp', 'virtual machine platform feature'],
    'The Virtual Machine Platform optional feature (needed by WSL 2 and some emulators). Needs a restart.',
    'This turns a Windows feature on or off and needs a restart.',
    { warnAlways: true },
  ),
  admin(
    'feature-hyper-v',
    'Hyper-V',
    ['hyperv', 'hyper v virtualization'],
    'The Hyper-V optional feature (not on Windows Home). Needs a restart.',
    'This turns a Windows feature on or off and needs a restart. Other virtual machine software may stop working while Hyper-V is on.',
    { warnAlways: true },
  ),
  admin(
    'feature-windows-sandbox',
    'Windows Sandbox',
    ['sandbox', 'disposable desktop'],
    'The Windows Sandbox optional feature (not on Windows Home). Needs a restart.',
    'This turns a Windows feature on or off and needs a restart.',
    { warnAlways: true },
  ),
  Object.freeze({
    id: 'active-hours-start',
    name: 'Windows Update active hours start',
    aliases: ['active hours', 'update active hours start'],
    type: 'number',
    unit: "o'clock",
    min: 0,
    max: 23,
    risk: 'DANGEROUS',
    elevation: 'admin',
    warning:
      'Windows will not restart for updates during active hours. The window can be at most 18 hours long.',
    description:
      'Hour of day (0-23, 24-hour clock) when Windows Update active hours start. The start and end may be at most 18 hours apart. Needs administrator approval (Windows asks through UAC) and human confirmation.',
  }),
  Object.freeze({
    id: 'active-hours-end',
    name: 'Windows Update active hours end',
    aliases: ['update active hours end'],
    type: 'number',
    unit: "o'clock",
    min: 0,
    max: 23,
    risk: 'DANGEROUS',
    elevation: 'admin',
    warning:
      'Windows will not restart for updates during active hours. The window can be at most 18 hours long.',
    description:
      'Hour of day (0-23, 24-hour clock) when Windows Update active hours end. The start and end may be at most 18 hours apart. Needs administrator approval (Windows asks through UAC) and human confirmation.',
  }),
]);

const DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'dark-mode',
    name: 'Dark mode',
    aliases: ['dark theme', 'night theme', 'light mode', 'theme'],
    type: 'boolean',
    risk: 'SAFE_WRITE',
    description:
      'Windows and app color theme. enabled=true selects dark mode, enabled=false selects light mode.',
  }),
  Object.freeze({
    id: 'brightness',
    name: 'Screen brightness',
    aliases: ['display brightness', 'screen light'],
    type: 'percent',
    min: 10,
    max: 100,
    risk: 'SAFE_WRITE',
    description:
      'Built-in display brightness in percent (10-100; never lower, so the screen cannot be left unreadable). Not available on most desktop monitors.',
  }),
  Object.freeze({
    id: 'volume',
    name: 'Speaker volume',
    aliases: ['sound', 'audio volume', 'master volume'],
    type: 'percent',
    min: 0,
    max: 100,
    risk: 'SAFE_WRITE',
    description: 'Master volume of the default speakers in percent (0-100).',
  }),
  Object.freeze({
    id: 'mute',
    name: 'Speaker mute',
    aliases: ['sound mute', 'silence'],
    type: 'boolean',
    risk: 'SAFE_WRITE',
    description: 'Mute state of the default speakers. enabled=true mutes, enabled=false unmutes.',
  }),
  Object.freeze({
    id: 'mic-mute',
    name: 'Microphone mute',
    aliases: ['mic mute', 'microphone'],
    type: 'boolean',
    risk: 'SAFE_WRITE',
    description:
      'Mute state of the default microphone. enabled=true mutes it, enabled=false unmutes it.',
  }),
  Object.freeze({
    id: 'transparency',
    name: 'Transparency effects',
    aliases: ['acrylic', 'mica', 'translucent'],
    type: 'boolean',
    risk: 'SAFE_WRITE',
    description:
      'Transparency effects in Windows. enabled=true turns them on, enabled=false turns them off.',
  }),
  Object.freeze({
    id: 'file-extensions',
    name: 'File extensions',
    aliases: ['filename extensions', 'show extensions'],
    type: 'boolean',
    risk: 'SAFE_WRITE',
    labels: ['shown', 'hidden'],
    description:
      'Whether File Explorer shows file name extensions (.txt, .mp4). enabled=true shows them. Already-open Explorer windows may need a refresh (F5).',
  }),
  Object.freeze({
    id: 'hidden-files',
    name: 'Hidden files',
    aliases: ['show hidden', 'hidden items'],
    type: 'boolean',
    risk: 'SAFE_WRITE',
    labels: ['shown', 'hidden'],
    description:
      'Whether File Explorer shows hidden files and folders. enabled=true shows them. Already-open Explorer windows may need a refresh (F5).',
  }),
  Object.freeze({
    id: 'notifications',
    name: 'App notifications',
    aliases: ['toast notifications', 'notification banners', 'alerts'],
    type: 'boolean',
    risk: 'SAFE_WRITE',
    description: 'Notification banners from apps and the system. enabled=false silences them all.',
  }),
  Object.freeze({
    id: 'clipboard-history',
    name: 'Clipboard history',
    aliases: ['clipboard'],
    type: 'boolean',
    risk: 'SAFE_WRITE',
    description: 'Clipboard history (Win+V). enabled=true keeps recent copied items.',
  }),
  Object.freeze({
    id: 'screen-timeout',
    name: 'Screen timeout',
    aliases: ['screen off', 'turn off display after', 'display timeout'],
    type: 'number',
    unit: 'minutes',
    min: 0,
    max: 720,
    zeroLabel: 'never',
    risk: 'SAFE_WRITE',
    description:
      'Minutes of inactivity before the screen turns off, applied to both plugged-in and battery. 0 means never.',
  }),
  Object.freeze({
    id: 'sleep-timeout',
    name: 'Sleep timeout',
    aliases: ['sleep after', 'standby timeout', 'auto sleep'],
    type: 'number',
    unit: 'minutes',
    min: 0,
    max: 720,
    zeroLabel: 'never',
    risk: 'SAFE_WRITE',
    description:
      'Minutes of inactivity before the PC sleeps, applied to both plugged-in and battery. 0 means never.',
  }),
  Object.freeze({
    id: 'mouse-speed',
    name: 'Pointer speed',
    aliases: ['mouse sensitivity', 'cursor speed', 'mouse speed'],
    type: 'number',
    unit: 'level',
    min: 1,
    max: 20,
    risk: 'SAFE_WRITE',
    description: 'Mouse pointer speed from 1 (slowest) to 20 (fastest); 10 is the Windows default.',
  }),
  Object.freeze({
    id: 'hibernate-timeout',
    name: 'Hibernate timeout',
    aliases: ['hibernate after', 'hibernation timer'],
    type: 'number',
    unit: 'minutes',
    min: 0,
    max: 1440,
    zeroLabel: 'never',
    risk: 'SAFE_WRITE',
    description:
      'Minutes of inactivity before the PC hibernates, applied to both plugged-in and battery. 0 means never.',
  }),
  Object.freeze({
    id: 'disk-timeout',
    name: 'Hard disk timeout',
    aliases: ['turn off hard disk after', 'disk sleep', 'drive timeout'],
    type: 'number',
    unit: 'minutes',
    min: 0,
    max: 1440,
    zeroLabel: 'never',
    risk: 'SAFE_WRITE',
    description:
      'Minutes of inactivity before hard disks are powered down, applied to both plugged-in and battery. 0 means never.',
  }),
  Object.freeze({
    id: 'lock-screen-timeout',
    name: 'Lock screen timeout',
    aliases: ['lock screen display off', 'screen off on lock screen'],
    type: 'number',
    unit: 'minutes',
    min: 0,
    max: 60,
    zeroLabel: 'never',
    risk: 'SAFE_WRITE',
    description:
      'Minutes the lock screen stays on before the display turns off, applied to both plugged-in and battery. 0 means never.',
  }),
  Object.freeze({
    id: 'pointer-trails',
    name: 'Pointer trails',
    aliases: ['mouse trails', 'cursor trails'],
    type: 'number',
    unit: 'length',
    min: 0,
    max: 20,
    forbid: [1],
    zeroLabel: 'off',
    risk: 'SAFE_WRITE',
    description:
      'Mouse pointer trail length. 0 turns trails off; 2 (short) to 20 (long) turns them on. The value 1 is not accepted.',
  }),
  Object.freeze({
    id: 'keyboard-repeat-delay',
    name: 'Keyboard repeat delay',
    aliases: ['key repeat delay', 'repeat delay'],
    type: 'number',
    unit: 'level',
    min: 0,
    max: 3,
    risk: 'SAFE_WRITE',
    description:
      'How long a key must be held before it starts repeating: 0 (shortest) to 3 (longest).',
  }),
  Object.freeze({
    id: 'menu-show-delay',
    name: 'Menu show delay',
    aliases: ['submenu delay', 'menu delay'],
    type: 'number',
    unit: 'ms',
    min: 0,
    max: 4000,
    risk: 'SAFE_WRITE',
    description:
      'Delay before a submenu opens when you hover over it, in milliseconds (0-4000; Windows default is 400).',
  }),
  Object.freeze({
    id: 'mic-volume',
    name: 'Microphone volume',
    aliases: ['mic level', 'input volume', 'microphone level'],
    type: 'percent',
    min: 0,
    max: 100,
    risk: 'SAFE_WRITE',
    description: 'Input level of the default microphone in percent (0-100).',
  }),
  Object.freeze({
    id: 'pointer-precision',
    name: 'Pointer precision',
    aliases: ['mouse acceleration', 'enhance pointer precision'],
    type: 'boolean',
    risk: 'SAFE_WRITE',
    labels: ['on', 'off'],
    description:
      'Enhance pointer precision (mouse acceleration). enabled=true turns it on, enabled=false gives a constant 1:1 pointer.',
  }),
  Object.freeze({
    id: 'scroll-lines',
    name: 'Scroll lines',
    aliases: ['scroll speed', 'mouse wheel scroll', 'scrolling speed'],
    type: 'number',
    unit: 'lines',
    min: 1,
    max: 100,
    risk: 'SAFE_WRITE',
    description: 'Lines scrolled per mouse-wheel notch, 1-100 (Windows default is 3).',
  }),
  Object.freeze({
    id: 'double-click-speed',
    name: 'Double-click speed',
    aliases: ['double click timing', 'double-click time'],
    type: 'number',
    unit: 'ms',
    min: 200,
    max: 900,
    risk: 'SAFE_WRITE',
    description:
      'Maximum time between the two clicks of a double-click, in milliseconds (200-900; Windows default is 500; larger is more forgiving).',
  }),
  Object.freeze({
    id: 'keyboard-repeat-rate',
    name: 'Keyboard repeat rate',
    aliases: ['key repeat', 'repeat rate', 'typing repeat speed'],
    type: 'number',
    unit: 'level',
    min: 0,
    max: 31,
    risk: 'SAFE_WRITE',
    description: 'How fast a held key repeats, from 0 (slowest) to 31 (fastest).',
  }),
  Object.freeze({
    id: 'power-mode',
    name: 'Power mode',
    aliases: ['performance mode', 'power plan', 'battery mode'],
    type: 'choice',
    risk: 'SAFE_WRITE',
    options: Object.freeze([
      Object.freeze({
        id: 'best-power-efficiency',
        label: 'Best power efficiency',
      }),
      Object.freeze({ id: 'balanced', label: 'Balanced' }),
      Object.freeze({ id: 'best-performance', label: 'Best performance' }),
    ]),
    description:
      'Windows 11 power mode. option is one of best-power-efficiency (longest battery), balanced, best-performance (fastest, uses more power).',
  }),
  Object.freeze({
    id: 'airplane-mode',
    name: 'Airplane mode',
    aliases: ['flight mode'],
    type: 'boolean',
    risk: 'DANGEROUS',
    labels: ['on', 'off'],
    warnWhen: true,
    warning:
      'Airplane mode turns off Wi-Fi, Bluetooth and every other radio: you will lose the internet connection and paired devices.',
    description:
      'Airplane mode (all radios). enabled=true turns every radio off, enabled=false turns them back on. Requires human confirmation.',
  }),
  Object.freeze({
    id: 'lid-close-action',
    name: 'Lid close action',
    aliases: ['close the lid', 'laptop lid', 'lid closing'],
    type: 'choice',
    risk: 'DANGEROUS',
    options: Object.freeze([
      Object.freeze({ id: 'do-nothing', label: 'Do nothing' }),
      Object.freeze({ id: 'sleep', label: 'Sleep' }),
      Object.freeze({ id: 'hibernate', label: 'Hibernate' }),
      Object.freeze({ id: 'shut-down', label: 'Shut down' }),
    ]),
    warning:
      'This changes what happens whenever the lid is closed, on battery and plugged in. "Do nothing" can leave a closed laptop running (and hot) in a bag.',
    description:
      'What closing the laptop lid does, applied to both battery and plugged-in. option is do-nothing, sleep, hibernate or shut-down. Requires human confirmation.',
  }),
  Object.freeze({
    id: 'power-button-action',
    name: 'Power button action',
    aliases: ['power button', 'what the power button does'],
    type: 'choice',
    risk: 'DANGEROUS',
    options: Object.freeze([
      Object.freeze({ id: 'do-nothing', label: 'Do nothing' }),
      Object.freeze({ id: 'sleep', label: 'Sleep' }),
      Object.freeze({ id: 'hibernate', label: 'Hibernate' }),
      Object.freeze({ id: 'shut-down', label: 'Shut down' }),
    ]),
    warning: 'This changes what pressing the power button does, on battery and plugged in.',
    description:
      'What pressing the power button does, applied to both battery and plugged-in. option is do-nothing, sleep, hibernate or shut-down. Requires human confirmation.',
  }),
  Object.freeze({
    id: 'mouse-primary-button',
    name: 'Primary mouse button',
    aliases: ['swap mouse buttons', 'left-handed mouse', 'right-handed mouse', 'main mouse button'],
    type: 'choice',
    risk: 'DANGEROUS',
    options: Object.freeze([
      Object.freeze({ id: 'left', label: 'Left button' }),
      Object.freeze({ id: 'right', label: 'Right button' }),
    ]),
    warning: 'This swaps the mouse buttons for every app until you swap them back.',
    description:
      'Which mouse button is the primary (click) button. option is left (default) or right (left-handed). Requires human confirmation.',
  }),
  Object.freeze({
    id: 'cursor-blink-rate',
    name: 'Cursor blink rate',
    aliases: ['caret blink', 'text cursor blink', 'cursor blink speed'],
    type: 'number',
    unit: 'ms',
    min: 200,
    max: 1200,
    risk: 'SAFE_WRITE',
    description:
      'Blink interval of the text cursor in milliseconds, 200 (fast) to 1200 (slow); Windows default is about 530.',
  }),
  Object.freeze({
    id: 'clock-24-hour',
    name: 'Clock format',
    aliases: ['24 hour clock', '12 hour clock', 'time format', 'military time'],
    type: 'boolean',
    risk: 'SAFE_WRITE',
    labels: ['24-hour', '12-hour'],
    description:
      'Time format of the taskbar clock and most apps (the short time). enabled=true shows 24-hour time such as 18:30, enabled=false shows 12-hour time such as 6:30 PM. A separate long format with seconds is left unchanged.',
  }),
  Object.freeze({
    id: 'animations',
    name: 'Window animations',
    aliases: ['animation effects', 'show animations', 'reduce motion'],
    type: 'boolean',
    risk: 'SAFE_WRITE',
    labels: ['on', 'off'],
    description:
      'Animations in Windows (fading, sliding). enabled=false turns them off, which also helps accessibility and slower PCs.',
  }),
  Object.freeze({
    id: 'drag-window-contents',
    name: 'Show window contents while dragging',
    aliases: ['drag full windows', 'window drag contents'],
    type: 'boolean',
    risk: 'SAFE_WRITE',
    labels: ['shown', 'hidden'],
    description:
      'enabled=true shows the whole window while you drag it; false shows only its outline.',
  }),
  Object.freeze({
    id: 'snap-to-default-button',
    name: 'Snap pointer to default button',
    aliases: ['pointer snap', 'snap to'],
    type: 'boolean',
    risk: 'SAFE_WRITE',
    labels: ['on', 'off'],
    description:
      'enabled=true automatically moves the mouse pointer to the default button in a dialog box.',
  }),
  Object.freeze({
    id: 'hide-pointer-while-typing',
    name: 'Hide pointer while typing',
    aliases: ['hide cursor while typing', 'mouse vanish'],
    type: 'boolean',
    risk: 'SAFE_WRITE',
    labels: ['on', 'off'],
    description:
      'enabled=true hides the mouse pointer while you type and brings it back when you move the mouse.',
  }),
  Object.freeze({
    id: 'pointer-location-on-ctrl',
    name: 'Show pointer location with Ctrl',
    aliases: ['find my mouse', 'pointer sonar', 'locate pointer'],
    type: 'boolean',
    risk: 'SAFE_WRITE',
    labels: ['on', 'off'],
    description: 'enabled=true highlights the pointer when you press the Ctrl key.',
  }),
  Object.freeze({
    id: 'usb-selective-suspend',
    name: 'USB selective suspend',
    aliases: ['usb power saving', 'usb suspend'],
    type: 'boolean',
    risk: 'SAFE_WRITE',
    labels: ['enabled', 'disabled'],
    description:
      'Lets Windows power down idle USB devices to save power. enabled=false can fix USB devices that keep disconnecting. Separate plugged-in / on-battery values.',
  }),
  Object.freeze({
    id: 'dim-timeout',
    name: 'Display dim timeout',
    aliases: ['dim display after', 'dim the screen after', 'screen dim timer'],
    type: 'number',
    unit: 'minutes',
    min: 0,
    max: 1440,
    zeroLabel: 'never',
    risk: 'SAFE_WRITE',
    description:
      'Minutes of inactivity before the display dims (before it turns off). 0 means never. Separate plugged-in / on-battery values.',
  }),
  Object.freeze({
    id: 'max-processor-state',
    name: 'Maximum processor state',
    aliases: ['cpu limit', 'max cpu speed', 'processor cap', 'limit cpu'],
    type: 'number',
    unit: '%',
    min: 20,
    max: 100,
    risk: 'SAFE_WRITE',
    description:
      'Caps CPU speed as a percentage of maximum (20-100). Lower values run cooler and quieter and save battery but make the PC slower; 100 is no cap. Separate plugged-in / on-battery values.',
  }),
  Object.freeze({
    id: 'battery-saver-threshold',
    name: 'Battery saver threshold',
    aliases: ['battery saver level', 'turn on battery saver at'],
    type: 'number',
    unit: '%',
    min: 0,
    max: 100,
    zeroLabel: 'never',
    batteryOnly: true,
    risk: 'SAFE_WRITE',
    description:
      'Battery percentage at which battery saver turns on automatically (0 = never). Applies only on battery.',
  }),
  Object.freeze({
    id: 'wake-timers',
    name: 'Wake timers',
    aliases: ['allow wake timers', 'scheduled wake'],
    type: 'choice',
    risk: 'SAFE_WRITE',
    options: Object.freeze([
      Object.freeze({ id: 'disabled', label: 'Disabled' }),
      Object.freeze({ id: 'enabled', label: 'Enabled' }),
      Object.freeze({
        id: 'important-only',
        label: 'Important wake timers only',
      }),
    ]),
    description:
      'Whether scheduled tasks may wake the PC from sleep. option is disabled, enabled or important-only. Separate plugged-in / on-battery values.',
  }),
  Object.freeze({
    id: 'cooling-policy',
    name: 'System cooling policy',
    aliases: ['cooling mode', 'fan policy'],
    type: 'choice',
    risk: 'SAFE_WRITE',
    options: Object.freeze([
      Object.freeze({ id: 'passive', label: 'Passive (slow the CPU first)' }),
      Object.freeze({ id: 'active', label: 'Active (fan first)' }),
    ]),
    description:
      'How the PC reacts to heat. option is passive (throttle the CPU before spinning the fan up, quieter) or active (spin the fan up first). Separate plugged-in / on-battery values.',
  }),
  Object.freeze({
    id: 'caret-width',
    name: 'Text cursor width',
    aliases: ['cursor thickness', 'caret thickness', 'text cursor thickness'],
    type: 'number',
    unit: 'px',
    min: 1,
    max: 20,
    risk: 'SAFE_WRITE',
    description:
      'Thickness of the blinking text cursor in pixels (1-20; Windows default is 1). A thicker cursor is easier to see.',
  }),
  Object.freeze({
    id: 'horizontal-scroll-chars',
    name: 'Horizontal scroll characters',
    aliases: ['horizontal scrolling', 'sideways scroll'],
    type: 'number',
    unit: 'characters',
    min: 1,
    max: 100,
    risk: 'SAFE_WRITE',
    description:
      'Characters scrolled per tilt of the mouse wheel when scrolling sideways (1-100; Windows default is 3).',
  }),
  Object.freeze({
    id: 'mouse-click-lock',
    name: 'Mouse ClickLock',
    aliases: ['click lock', 'lock mouse button'],
    type: 'boolean',
    risk: 'SAFE_WRITE',
    labels: ['on', 'off'],
    description:
      'enabled=true lets you drag or select without holding the mouse button down (hold briefly to lock, click again to release).',
  }),
  Object.freeze({
    id: 'keyboard-underlines',
    name: 'Underline keyboard shortcuts',
    aliases: ['keyboard cues', 'underline access keys', 'show keyboard shortcuts'],
    type: 'boolean',
    risk: 'SAFE_WRITE',
    labels: ['on', 'off'],
    description:
      'enabled=true always underlines keyboard shortcuts and access keys in menus and dialogs.',
  }),
  Object.freeze({
    id: 'window-minimize-animation',
    name: 'Minimize and maximize animation',
    aliases: ['window minimize animation', 'minimize animation'],
    type: 'boolean',
    risk: 'SAFE_WRITE',
    labels: ['on', 'off'],
    description: 'enabled=false turns off the animation when windows are minimized or maximized.',
  }),
  Object.freeze({
    id: 'hybrid-sleep',
    name: 'Hybrid sleep',
    aliases: ['hybrid sleep mode'],
    type: 'boolean',
    risk: 'SAFE_WRITE',
    labels: ['on', 'off'],
    description:
      'Sleep that also saves memory to disk so a power loss does not lose work. Separate plugged-in / on-battery values.',
  }),
  Object.freeze({
    id: 'unattended-sleep-timeout',
    name: 'Unattended sleep timeout',
    aliases: ['sleep after automatic wake', 'unattended sleep'],
    type: 'number',
    unit: 'minutes',
    min: 0,
    max: 1440,
    zeroLabel: 'never',
    risk: 'SAFE_WRITE',
    description:
      'Minutes before the PC goes back to sleep after it woke up on its own (for example for a scheduled task). 0 means never. Separate plugged-in / on-battery values.',
  }),
  Object.freeze({
    id: 'default-brightness',
    name: 'Default screen brightness',
    aliases: ['brightness on battery', 'brightness when plugged in', 'plan brightness'],
    type: 'number',
    unit: '%',
    min: 10,
    max: 100,
    risk: 'SAFE_WRITE',
    description:
      'The brightness the power plan applies when the PC runs on that power source (10-100); it takes effect right away if that is the current source. Use this with source for "brightness on battery"; plain brightness only changes the screen right now.',
  }),
  Object.freeze({
    id: 'battery-saver-brightness',
    name: 'Battery saver brightness',
    aliases: ['battery saver dimming'],
    type: 'number',
    unit: '%',
    min: 10,
    max: 100,
    batteryOnly: true,
    risk: 'SAFE_WRITE',
    description:
      'Screen brightness (as a percent of normal) while battery saver is on (10-100). Applies only on battery.',
  }),
  Object.freeze({
    id: 'low-battery-level',
    name: 'Low battery level',
    aliases: ['battery low warning level'],
    type: 'number',
    unit: '%',
    min: 5,
    max: 100,
    batteryOnly: true,
    risk: 'SAFE_WRITE',
    description:
      'Battery percentage that counts as low (5-100). Must stay above the critical level. Applies only on battery.',
  }),
  Object.freeze({
    id: 'critical-battery-level',
    name: 'Critical battery level',
    aliases: ['battery critical level'],
    type: 'number',
    unit: '%',
    min: 3,
    max: 50,
    batteryOnly: true,
    risk: 'SAFE_WRITE',
    description:
      'Battery percentage that counts as critical (3-50). Must stay below the low level. Applies only on battery.',
  }),
  Object.freeze({
    id: 'low-battery-action',
    name: 'Low battery action',
    aliases: ['action at low battery'],
    type: 'choice',
    batteryOnly: true,
    risk: 'DANGEROUS',
    options: Object.freeze([
      Object.freeze({ id: 'do-nothing', label: 'Do nothing' }),
      Object.freeze({ id: 'sleep', label: 'Sleep' }),
      Object.freeze({ id: 'hibernate', label: 'Hibernate' }),
      Object.freeze({ id: 'shut-down', label: 'Shut down' }),
    ]),
    warning:
      'This decides what happens when the battery gets low. "Shut down" can lose unsaved work.',
    description:
      'What the PC does when the battery reaches the low level. option is do-nothing, sleep, hibernate or shut-down. Applies only on battery. Requires human confirmation.',
  }),
  Object.freeze({
    id: 'critical-battery-action',
    name: 'Critical battery action',
    aliases: ['action at critical battery'],
    type: 'choice',
    batteryOnly: true,
    risk: 'DANGEROUS',
    options: Object.freeze([
      Object.freeze({ id: 'do-nothing', label: 'Do nothing' }),
      Object.freeze({ id: 'sleep', label: 'Sleep' }),
      Object.freeze({ id: 'hibernate', label: 'Hibernate' }),
      Object.freeze({ id: 'shut-down', label: 'Shut down' }),
    ]),
    warning:
      'This decides what happens when the battery is almost empty. "Do nothing" can lose unsaved work when the battery runs out.',
    description:
      'What the PC does when the battery reaches the critical level. option is do-nothing, sleep, hibernate or shut-down. Applies only on battery. Requires human confirmation.',
  }),
  Object.freeze({
    id: 'wifi',
    name: 'Wi-Fi',
    aliases: ['wi-fi', 'wireless', 'wlan'],
    type: 'boolean',
    risk: 'DANGEROUS',
    warning: 'Turning Wi-Fi off can disconnect this PC from the internet.',
    description:
      'Wi-Fi radio. enabled=true turns it on, enabled=false turns it off. Requires human confirmation.',
  }),
  Object.freeze({
    id: 'bluetooth',
    name: 'Bluetooth',
    aliases: ['bt'],
    type: 'boolean',
    risk: 'DANGEROUS',
    warning: 'Turning Bluetooth off disconnects paired devices such as headphones and mice.',
    description:
      'Bluetooth radio. enabled=true turns it on, enabled=false turns it off. Requires human confirmation.',
  }),
  ...ADDED_DEFINITIONS,
]);

// Windows keeps these power-plan settings separately for "plugged in" and "on battery"; a request may target either or both.
export const SOURCES = Object.freeze(['both', 'plugged-in', 'battery']);
const PER_SOURCE = new Set([
  'screen-timeout',
  'sleep-timeout',
  'hibernate-timeout',
  'disk-timeout',
  'lock-screen-timeout',
  'dim-timeout',
  'max-processor-state',
  'usb-selective-suspend',
  'wake-timers',
  'cooling-policy',
  'lid-close-action',
  'power-button-action',
  'hybrid-sleep',
  'unattended-sleep-timeout',
  'default-brightness',
]);
export const SETTINGS = Object.freeze(
  DEFINITIONS.map((s) => (PER_SOURCE.has(s.id) ? Object.freeze({ ...s, perSource: true }) : s)),
);

export const SETTING_IDS = Object.freeze(SETTINGS.map((s) => s.id));
export const OPTION_IDS = Object.freeze([
  ...new Set(SETTINGS.flatMap((s) => (s.options ?? []).map((o) => o.id))),
]);
export const settingById = (id) => SETTINGS.find((s) => s.id === id);
export function requireSetting(id) {
  const setting = settingById(id);
  if (!setting)
    throw failure('UNKNOWN_SETTING', `Unknown setting. Use one of: ${SETTING_IDS.join(', ')}.`);
  return setting;
}

/**
 * Validate one change request against the catalog. Returns {setting, value} (value is a boolean or an integer),
 * or throws a coded error before anything is executed or any human is asked.
 */
function planValue(params) {
  const keys = Object.keys(params ?? {});
  if (keys.some((k) => !['id', 'enabled', 'level', 'option', 'source'].includes(k)))
    throw failure('INVALID_INPUT', 'Only id, enabled, level, option and source are accepted.');
  const setting = requireSetting(params?.id);
  if (setting.type === 'choice') {
    if (
      params.enabled !== undefined ||
      params.level !== undefined ||
      typeof params.option !== 'string'
    )
      throw failure(
        'INVALID_INPUT',
        `${setting.name} takes option (one of: ${setting.options.map((o) => o.id).join(', ')}) and nothing else.`,
      );
    if (!setting.options.some((o) => o.id === params.option))
      throw failure(
        'INVALID_INPUT',
        `Unknown option. Choose one of: ${setting.options.map((o) => o.id).join(', ')}.`,
      );
    return { setting, value: params.option };
  }
  if (setting.type === 'boolean') {
    if (
      typeof params.enabled !== 'boolean' ||
      params.level !== undefined ||
      params.option !== undefined
    )
      throw failure('INVALID_INPUT', `${setting.name} takes enabled (true/false) and no level.`);
    if (params.enabled === false && setting.forbidOff)
      throw failure(
        'BLOCKED_BY_POLICY',
        `${setting.name} cannot be turned off from here: switching a security protection off is blocked by policy. The user can do it themselves in Windows Security.`,
      );
    return { setting, value: params.enabled };
  }
  if (
    !Number.isInteger(params.level) ||
    params.enabled !== undefined ||
    params.option !== undefined
  )
    throw failure('INVALID_INPUT', `${setting.name} takes level (a whole number) and no enabled.`);
  if (setting.forbid?.includes(params.level))
    throw failure(
      'OUT_OF_RANGE',
      `${setting.name} cannot be ${params.level}. ${setting.description}`,
    );
  if (params.level < setting.min || params.level > setting.max)
    throw failure(
      'OUT_OF_RANGE',
      `${setting.name} must be between ${setting.min} and ${setting.max}.`,
    );
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
    if (!setting.perSource)
      throw failure(
        'INVALID_INPUT',
        `${setting.name} has no separate plugged-in / on-battery value.`,
      );
    if (!SOURCES.includes(params.source))
      throw failure('INVALID_INPUT', `source must be one of: ${SOURCES.join(', ')}.`);
  }
  return {
    ...planned,
    source: setting.perSource ? (params.source ?? 'both') : undefined,
  };
}

/** Does the value read back from the machine satisfy the request? Percent values (brightness, volume) allow one step of rounding; everything else must match exactly. */
export const matches = (setting, wanted, actual) =>
  setting.type === 'percent' ? Math.abs(Number(actual) - wanted) <= 1 : actual === wanted;
