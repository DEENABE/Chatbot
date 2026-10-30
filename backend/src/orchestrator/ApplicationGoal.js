// Portable goal checks shared by the backend and Electron chat controller.
const clean = (value) =>
  String(value || '')
    .trim()
    .replace(/^(["'])(.*)\1$/s, '$2');
export function sameTarget(a, b) {
  if (!a || !b || String(a.type).toUpperCase() !== String(b.type).toUpperCase()) return false;
  if (String(a.type).toUpperCase() === 'URL') return a.value === b.value;
  return (
    typeof a.path === 'string' &&
    typeof b.path === 'string' &&
    a.path.replaceAll('/', '\\').toLowerCase() === b.path.replaceAll('/', '\\').toLowerCase()
  );
}
export function targetEvidence(data, target, app) {
  return (
    data?.success === true &&
    data.status === 'APP_TARGET_OPENED' &&
    data.requestedApp === app &&
    sameTarget(data.target, target) &&
    Number.isSafeInteger(data.processId) &&
    data.processId > 0 &&
    typeof data.app?.id === 'string' &&
    !!data.app.id &&
    data.verification?.status === 'verified' &&
    data.verification.criterion === 'window_title' &&
    typeof data.verification.windowTitle === 'string' &&
    !!data.verification.windowTitle &&
    Number.isFinite(Date.parse(data.verification.observedAt))
  );
}
export function applicationGoalVerdict(goal, steps) {
  const resolved = steps.find(
    (s) =>
      s.tool === 'app' &&
      s.action === 'resolveTarget' &&
      clean(s.params?.query) === clean(goal.query) &&
      s.status === 'done' &&
      s.observation?.success === true &&
      s.observation?.data?.status === 'TARGET_RESOLVED' &&
      clean(s.observation.data.query) === clean(goal.query),
  );
  const opened =
    resolved &&
    steps.find(
      (s) =>
        s.tool === 'app' &&
        s.action === 'openWithTarget' &&
        s.params?.app === goal.app &&
        s.status === 'done' &&
        s.observation?.success === true &&
        sameTarget(s.params.target, resolved.observation.data.target) &&
        targetEvidence(s.observation.data, s.params.target, goal.app),
    );
  const success =
    steps.length > 0 &&
    steps.every((s) => s.status === 'done' && s.observation?.success === true) &&
    !!opened;
  return {
    success,
    scope: 'application_goal',
    summary: success
      ? opened.observation.data.message || 'The requested target is open in the application.'
      : 'The complete application goal has not been verified.',
    recommendation: success
      ? ''
      : 'Review the target resolution and application verification results.',
  };
}
