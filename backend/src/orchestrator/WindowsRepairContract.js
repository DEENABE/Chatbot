export const CAPABILITY = "windows.printSpooler.start.v1";
export const POLICY_VERSION = 1;
export const LIMITS = Object.freeze({
  diagnosisMs: 10000,
  eligibilityMs: 120000,
  startMs: 35000,
  verifyMs: 15000,
  outputBytes: 65536,
  maxSteps: 6,
  maxRetries: 0,
  renewals: 3,
});
export const uuid = (v) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
export const plain = (v) =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v));
export function validateRepair(action, params) {
  if (!["inspectSpooler", "startSpooler", "verifySpooler"].includes(action))
    return "Unknown repair capability.";
  if (!plain(params)) return "Parameters must be a plain object.";
  const keys = Object.keys(params);
  if (action === "inspectSpooler")
    return keys.length ? "Inspection accepts no parameters." : null;
  return keys.length === 1 &&
    Object.hasOwn(params, "diagnosisId") &&
    uuid(params.diagnosisId)
    ? null
    : "Only an owned diagnosisId UUID is accepted.";
}
export function validSample(s) {
  return (
    plain(s) &&
    s.platform === "win32" &&
    s.name === "Spooler" &&
    typeof s.hostId === "string" &&
    s.hostId.length > 0 &&
    typeof s.bootId === "string" &&
    s.bootId.length > 0 &&
    typeof s.configHash === "string" &&
    /^[a-f0-9]{64}$/.test(s.configHash) &&
    Number.isFinite(s.observedAt) &&
    Number.isInteger(s.status) &&
    s.status >= 1 &&
    s.status <= 7 &&
    typeof s.stock === "boolean" &&
    typeof s.canStart === "boolean" &&
    typeof s.dependenciesRunning === "boolean" &&
    Number.isInteger(s.startType)
  );
}
export function eligibility(s) {
  if (!validSample(s)) return "INVALID_EVIDENCE";
  if (!s.canStart) return "PRIVILEGE_REQUIRED";
  if (!s.stock || s.startType !== 2) return "UNSUPPORTED_CONFIGURATION";
  if (!s.dependenciesRunning) return "DEPENDENCY_NOT_RUNNING";
  return s.status === 1
    ? null
    : s.status === 4
      ? "ALREADY_RUNNING"
      : "SERVICE_NOT_STOPPED";
}
export function sameMachine(a, b) {
  return (
    validSample(a) &&
    validSample(b) &&
    ["hostId", "bootId", "configHash"].every((k) => a[k] === b[k])
  );
}
export function verified(samples, baseline) {
  return (
    Array.isArray(samples) &&
    samples.length === 2 &&
    samples.every((s) => sameMachine(s, baseline) && s.status === 4) &&
    samples[1].observedAt - samples[0].observedAt >= 1000 &&
    samples[1].observedAt - samples[0].observedAt <= LIMITS.verifyMs
  );
}
const reads = new Set([
  "hardware.systemInfo",
  "hardware.cpuUsage",
  "hardware.memoryUsage",
  "hardware.diskInfo",
  "hardware.networkAdapters",
  "network.ipConfig",
  "network.ping",
  "network.netstat",
  "process.list",
  "file.read",
  "file.list",
  "file.exists",
  "services.list",
  "services.getStatus",
]);
const apps = new Set(["notepad.exe", "calc.exe", "mspaint.exe", "taskmgr.exe"]);
export const isAllowedLegacyProcess = (params) =>
  apps.has(params.command) && (!params.args || params.args.length === 0);
/** Applied to every model origin regardless of its claimed intent. Utilities remain internal/manual. */
export function modelPolicy(tool, action, params = {}) {
  if (
    tool === "desktop" &&
    [
      "open",
      "observe",
      "act",
      "actConfirmed",
      "input",
      "inputConfirmed",
      "verify",
      "saveAs",
      "launch",
      "click",
      "doubleClick",
      "select",
      "focus",
      "scroll",
      "type",
      "press",
      "hotkey",
      "read",
      "find",
      "waitFor",
      "close",
    ].includes(action)
  )
    return null;
  if (tool === "winget" && ["search", "install"].includes(action)) return null;
  if (tool === "webInstall" && ["find", "download", "install"].includes(action))
    return null;
  if (
    tool === "systemSettings" &&
    ["list", "get", "set", "setConfirmed"].includes(action)
  )
    return null;
  if (
    tool === "inspector" &&
    ["inspect", "resolveControl", "navigate"].includes(action)
  )
    return null;
  if (
    tool === "browser" &&
    [
      "openBrowser",
      "attachBrowser",
      "newTab",
      "closeTab",
      "switchTab",
      "navigate",
      "search",
      "click",
      "type",
      "submit",
      "readText",
      "scroll",
      "getPageTitle",
      "getCurrentUrl",
      "getVisibleElements",
      "waitForElement",
      "waitForNavigation",
      "back",
      "forward",
      "downloads",
    ].includes(action)
  )
    return null;
  if (
    tool === "uiAutomation" &&
    [
      "calculate",
      "typeInNotepad",
      "findWindow",
      "waitForWindow",
      "isWindowOpen",
      "focusWindow",
      "listControls",
      "findControl",
      "waitForControl",
      "readText",
      "navigateControl",
    ].includes(action)
  )
    return null;
  if (
    tool === "app" &&
    [
      "open",
      "openApp",
      "openWithTarget",
      "resolveTarget",
      "getCapabilities",
      "focusApp",
      "isAppOpen",
      "closeApp",
      "searchInstalledApps",
      "listApps",
      "describeApp",
      "resolveApp",
      "isInstalled",
      "getAppInfo",
      "refreshAppRegistry",
    ].includes(action)
  )
    return null;
  if (
    tool === "file" &&
    [
      "readFile",
      "listDir",
      "fileInfo",
      "searchFiles",
      "createDirectory",
      "createTextFile",
    ].includes(action)
  )
    return null;
  if (tool === "windowsRepair") return validateRepair(action, params);
  if (tool === "_system" && ["getTools", "cancel"].includes(action))
    return null;
  if (reads.has(`${tool}.${action}`)) return null;
  return "MODEL_CAPABILITY_DENIED";
}
