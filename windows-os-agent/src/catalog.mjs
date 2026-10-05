import Ajv from 'ajv';
import { isIP } from 'node:net';

const ajv = new Ajv({ allErrors: true, strict: true });
ajv.addFormat('ip', value => isIP(value) !== 0);
ajv.addFormat('ipv4', value => isIP(value) === 4);
const str = (maxLength = 200) => ({ type: 'string', minLength: 1, maxLength });
const choice = (...values) => ({ type: 'string', enum: values });
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const bool = { type: 'boolean' };
const object = (properties = {}, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const guid = { type: 'string', pattern: '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' };
const index = integer(1, 2147483647);
const ip = { type: 'string', format: 'ip' };
const ipv4 = { type: 'string', format: 'ipv4' };
const radio = choice('WiFi', 'Bluetooth', 'MobileBroadband');
const privacy = choice('location', 'webcam', 'microphone');
const entries = [];
function add(id, description, params = object(), risk = 'read', admin = false, uri = null, engine = 'direct') {
  entries.push({ id, description, params, risk, admin, uri, engine });
}
add('system.inspect', 'OS build, administrator token, interactive session and PowerShell version.');
add('network.inspect', 'Adapters, IP addresses, routes and DNS.');
add('network.adapter', 'Enable/disable exactly one adapter by interface index. May disconnect this computer.', object({ interfaceIndex: index, enabled: bool }), 'high', true, 'network-status');
add('network.dns', 'Set DNS servers, or reset=true with servers=[] to use DHCP DNS.', object({ interfaceIndex: index, reset: bool, servers: { type: 'array', items: ip, maxItems: 4, uniqueItems: true } }), 'high', true, 'network-ethernet');
add('network.ipv4', 'Configure a dedicated static IPv4 address or return to DHCP. Existing manual IPv4 addresses on this adapter are replaced.', object({ interfaceIndex: index, mode: choice('dhcp', 'static'), address: ipv4, prefixLength: integer(1, 32), gateway: ipv4 }, ['interfaceIndex', 'mode']), 'high', true, 'network-ethernet');
add('wifi.inspect', 'List saved WLAN profiles and connection state; never reveal credentials.');
add('wifi.connect', 'Connect using an existing saved WLAN profile, on an exact interface name.', object({ profile: str(128), interface: str(128) }), 'high', false, 'network-wifi');
add('radio.inspect', 'Read Wi-Fi, Bluetooth and cellular radio states using WinRT.');
add('radio.set', 'Change one radio kind; fails if zero or multiple matching radios exist.', object({ kind: radio, enabled: bool }), 'high', false, 'network-airplanemode');
add('airplane.get', 'Observe the actual Airplane mode Settings switch (requires UIA).', object(), 'read', false, 'network-airplanemode', 'uia');
add('airplane.set', 'Set actual Airplane mode; not an approximation by disabling network adapters.', object({ enabled: bool }), 'high', false, 'network-airplanemode', 'uia');
add('display.inspect', 'List display devices, active modes and driver-supported modes.');
add('display.mode', 'Set an enumerated display resolution and integer refresh rate. Driver tests the mode before applying.', object({ device: str(64), width: integer(320, 16384), height: integer(200, 16384), frequency: integer(1, 1000) }), 'high', false, 'display');
add('display.topology', 'Apply Windows display topology: internal, clone, extend or external.', object({ topology: choice('internal', 'clone', 'extend', 'external') }), 'high', false, 'display');
add('brightness.get', 'Read laptop/internal-monitor brightness via WMI; external DDC/CI displays may be unsupported.');
add('brightness.set', 'Set a specific WMI monitor instance brightness to 0..100%.', object({ instance: str(300), percent: integer(0, 100) }), 'low', false, 'display');
add('nightlight.get', 'Observe Night light through Settings UIA.', object(), 'read', false, 'nightlight', 'uia');
add('nightlight.set', 'Set Night light through a trusted UIA selector.', object({ enabled: bool }), 'low', false, 'nightlight', 'uia');
add('audio.inspect', 'List active input/output endpoint IDs, defaults, master volume and mute.');
add('audio.volume', 'Set the default output master volume and/or mute using Core Audio.', object({ percent: integer(0, 100), muted: bool }, []), 'low', false, 'sound');
add('audio.default', 'Select an exact input/output endpoint name in Settings; a build-specific UIA profile is required.', object({ direction: choice('input', 'output'), name: str(200) }), 'low', false, 'sound', 'uia');
add('power.inspect', 'Power schemes, active scheme, timeouts, battery and energy saver status.');
add('power.plan', 'Activate an existing power scheme GUID.', object({ guid }), 'low', false, 'powersleep');
add('power.timeout', 'Set AC/DC display, sleep or hibernate timeout in minutes; zero means never.', object({ source: choice('ac', 'dc'), setting: choice('monitor', 'standby', 'hibernate'), minutes: integer(0, 10080) }), 'low', false, 'powersleep');
add('power.hibernate', 'Enable/disable hibernation support.', object({ enabled: bool }), 'high', true, 'powersleep');
add('battery.set', 'Set Battery/Energy saver through Settings UIA, when available on this hardware.', object({ enabled: bool }), 'low', false, 'batterysaver', 'uia');
add('personalization.inspect', 'Read light/dark preferences, accent values, wallpaper and taskbar auto-hide.');
add('theme.set', 'Set app and Windows shell light/dark preferences for this account.', object({ mode: choice('dark', 'light') }), 'low');
add('accent.set', 'Set an exact accent color using a trusted Settings UIA profile.', object({ color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' } }), 'low', false, 'personalization-colors', 'uia');
add('wallpaper.set', 'Set an existing local JPG/PNG/BMP wallpaper. UNC paths and reparse points are rejected.', object({ path: str(260) }), 'low');
add('taskbar.set', 'Set taskbar auto-hide using the Shell appbar API.', object({ autoHide: bool }), 'low');
add('privacy.get', 'Read current-account location/camera/microphone consent and policy state.', object({ capability: privacy }));
add('privacy.set', 'Set current-account consent; machine policy and app-specific restrictions can still deny access.', object({ capability: privacy, enabled: bool }), 'high', false, 'privacy-location');
add('firewall.get', 'Read all Windows Defender Firewall profiles.');
add('firewall.set', 'Enable/disable named firewall profiles; requires explicit approval.', object({ profiles: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: choice('Domain', 'Private', 'Public') }, enabled: bool }), 'high', true);
add('storage.inspect', 'Read fixed volume free space and preview old files in this account temp directory.');
add('storage.cleanup', 'Delete only regular files older than the cutoff under the canonical current-account temp directory. No directory or reparse-point deletion.', object({ olderThanDays: integer(1, 365), maxFiles: integer(1, 5000) }), 'high');
add('updates.status', 'Read recent Windows Update history and reboot-required state.');
add('updates.scan', 'Search for applicable software updates with the Windows Update Agent API. Can take several minutes.', object(), 'high');
add('updates.install', 'Use the Windows Update Settings page for user-supervised installation.', object(), 'high', false, 'windowsupdate', 'navigate');
add('service.inspect', 'Read an exact service, or list services when name is omitted.', object({ name: str(100) }, []));
add('service.set', 'Start/stop/restart or configure a service from the administrator-maintained allowlist.', object({ name: str(100), action: choice('start', 'stop', 'restart', 'configure'), startupType: choice('Automatic', 'Manual', 'Disabled') }, ['name', 'action']), 'high', true);
add('registry.get', 'Read a named, administrator-allowlisted registry target. Raw paths are never accepted.', object({ target: str(80) }));
add('registry.set', 'Write a named allowlisted registry value; target-specific type/range validation applies. No deletion.', object({ target: str(80), value: { anyOf: [{ type: 'integer', minimum: 0, maximum: 4294967295 }, { type: 'string', maxLength: 1024 }] } }), 'high');
add('policy.inspect', 'Read Resultant Set of Policy summary using gpresult.');
add('policy.get', 'Read one allowlisted Local GPO entry using the Microsoft LGPO utility and its effective registry value.', object({ target: str(80) }));
add('policy.set', 'Write one allowlisted Local GPO DWORD entry using a signature/hash-pinned Microsoft LGPO utility, then refresh policy.', object({ target: str(80), value: integer(0, 1) }), 'high', true);
add('policy.refresh', 'Refresh computer/user Group Policy. This applies existing policy; it does not edit Local GPO.', object({ target: choice('user', 'computer') }), 'high', true);
add('settings.open', 'Open an allowlisted Settings page; opening a page does not change its setting.', object({ page: choice('network-status', 'network-wifi', 'network-ethernet', 'network-cellular', 'network-airplanemode', 'bluetooth', 'display', 'nightlight', 'sound', 'powersleep', 'batterysaver', 'personalization', 'personalization-colors', 'taskbar', 'privacy-location', 'privacy-webcam', 'privacy-microphone', 'windowsupdate', 'storagesense') }), 'low', false, null, 'navigate');

export const catalog = Object.freeze(Object.fromEntries(entries.map(e => [e.id, Object.freeze(e)])));
const validators = new Map(entries.map(e => [e.id, ajv.compile(e.params)]));
export function validateOperation(id, parameters) {
  if (!Object.hasOwn(catalog, id)) throw Object.assign(new Error('Unknown operation'), { code: 'UNKNOWN_OPERATION' });
  if (!validators.get(id)(parameters)) throw Object.assign(new Error(ajv.errorsText(validators.get(id).errors)), { code: 'INVALID_ARGUMENTS' });
  if (id === 'network.dns' && (parameters.reset ? parameters.servers.length !== 0 : parameters.servers.length === 0)) throw new Error('reset requires empty servers; otherwise at least one server is required');
  if (id === 'network.ipv4' && parameters.mode === 'static' && ['address', 'prefixLength', 'gateway'].some(k => parameters[k] === undefined)) throw new Error('Static IPv4 requires address, prefixLength and gateway');
  if (id === 'network.ipv4' && parameters.mode === 'dhcp' && Object.keys(parameters).length !== 2) throw new Error('DHCP accepts only interfaceIndex and mode');
  if (id === 'audio.volume' && !Object.keys(parameters).length) throw new Error('Provide percent or muted');
  if (id === 'service.set' && (parameters.action === 'configure') !== (parameters.startupType !== undefined)) throw new Error('startupType is required only for configure');
  return catalog[id];
}
export const tools = [
  { type: 'function', function: { name: 'list_capabilities', description: 'Discover operation IDs and schemas. Filter by a category prefix such as audio, network, privacy.', parameters: object({ category: str(40) }, []) } },
  { type: 'function', function: { name: 'run_operation', description: 'Run a catalog operation with schema-validated parameters. Writes may return an approval plan. No shell commands, scripts, paths to executables or approval tokens are accepted.', parameters: object({ operation: { type: 'string', enum: entries.map(e => e.id) }, parameters: { type: 'object' } }) } }
];
