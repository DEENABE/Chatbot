import { AND_NAMED_ITEM } from './AppLaunchTask.js';
// No application names here. Adapters are not required for admission.
export function genericDesktopTask(message) {
  const text = String(message || '').trim();
  if (/^(?:explain|describe|how|what|write (?:a|an) (?:story|essay))\b/i.test(text)) return null;
  const close = text
    .replace(/[.!?]+$/, '')
    .match(/^(?:(?:can|could|would) you\s+)?(?:please\s+)?close\s+(?:my\s+|the\s+)?(.+)$/i);
  if (close) {
    const query = close[1].trim().replace(/\s+(?:app|application|window)$/i, '');
    if (
      !query ||
      query.includes('&&') ||
      query.length > 200 ||
      /[\\/:;|<>`$\x00-\x1f]/.test(query) ||
      /\b(?:and|or|then|after|before|while|when|if|unless|until|without|except|but)\b/i.test(
        query,
      ) ||
      /\bsettings?\b/i.test(query) ||
      /^(?:it|this|that|all|every|everything|current|active|apps?|applications?|programs?|windows?|tabs?|files?|documents?|folders?|settings|windows settings)(?:\s|$)/i.test(
        query,
      ) ||
      /\.(?:exe|txt|docx?|xlsx?|pdf|csv|pptx?|json|png|jpe?g|mp[34])$/i.test(query)
    )
      return null;
    return { query, goal: 'close it', task: text, closeOnly: true };
  }
  if (
    AND_NAMED_ITEM.test(
      text
        .replace(
          /^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:open|launch|start|run)\s+(?:my\s+|the\s+)?/i,
          '',
        )
        .replace(/[.!?]+$/, ''),
    )
  )
    return null;
  let m = text.match(
    /^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:open|launch|start|run)\s+(?:my\s+|the\s+)?(.+?)\s+(?:(?:and(?: then)?|then)\s+)(.+)$/i,
  );
  if (!m)
    m = text.match(
      /^(?:open|launch|start|run)\s+(?:my\s+|the\s+)?(.+?)\s+((?:go to|navigate to|show)\s+.+)$/i,
    );
  let implicitGoal = false;
  // Natural app commands often omit "and": "run VLC play the movie".
  // Keep the app name separate from the goal before registry resolution.
  if (!m) {
    m = text.match(
      /^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:open|launch|start|run)\s+(?:my\s+|the\s+)?(.+?)\s+((?:add|calculate|type|write|enter|paste|play|pause|search|find|click|select|press|scroll|save|draw|create|schedule|book|join|call|message|chat|send|compose|reply|forward|new|set|record|share|post|upload|edit|delete|rename|make)\s+.+)$/i,
    );
    implicitGoal = !!m;
  }
  if (!m) {
    const reverse = text.match(
      /^((?:create|add|open|find|search|select|click|type|enter|calculate|play|pause)\s+.+?)\s+(?:in|using)\s+(.+)$/i,
    );
    if (reverse) m = [reverse[0], reverse[2], reverse[1]];
  }
  if (!m) return null;
  const query = m[1].trim().replace(/\s+app$/i, ''),
    goal = m[2].trim();
  if (!query || query.includes('&&') || query.length > 200 || /[\\/:;|<>`$\x00-\x1f]/.test(query))
    return null;
  return { query, goal, task: text, ...(implicitGoal ? { implicitGoal: true } : {}) };
}
export const desktopSnapshot = (data) =>
  data?.snapshot?.status === 'UI_OBSERVED'
    ? data.snapshot
    : data?.status === 'UI_OBSERVED'
      ? data
      : null;
export function desktopCompletion(data, task) {
  return (
    data?.success === true &&
    data.status === 'UI_GOAL_EVIDENCE_VERIFIED' &&
    data.goal === task &&
    typeof data.snapshotId === 'string' &&
    Array.isArray(data.evidence) &&
    data.evidence.length > 0 &&
    data.verification?.criterion === 'fresh_goal_evidence' &&
    data.verification.status === 'verified' &&
    Number.isFinite(Date.parse(data.verification.observedAt))
  );
}

const closeText = (value) =>
  String(value || '')
    .trim()
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
/** Native absence verifies the exact bound window and a complete close-only goal. */
export function verifiedCloseGoal(task, intent, history) {
  const parsed = genericDesktopTask(task),
    last = history.at(-1),
    data = last?.data;
  if (
    !parsed ||
    closeText(parsed.query) !== closeText(intent?.query) ||
    last?.success !== true ||
    last.toolName !== 'desktop_close' ||
    data?.success !== true ||
    data.status !== 'UI_WINDOW_CLOSED' ||
    data.closed !== true ||
    data.verification?.status !== 'verified' ||
    data.verification.criterion !== 'window_absent' ||
    !Number.isFinite(Date.parse(data.verification.observedAt)) ||
    closeText(data.query) !== closeText(parsed.query)
  )
    return false;
  const before = history.slice(0, -1).findLast((h) => desktopSnapshot(h.data));
  const snapshot = desktopSnapshot(before?.data),
    application = snapshot?.application;
  if (
    before?.success !== true ||
    before.data?.success === false ||
    !snapshot ||
    snapshot.currentView?.type === 'dialog' ||
    data.snapshotId !== snapshot.snapshotId ||
    (last.toolArguments?.snapshotId !== undefined &&
      last.toolArguments.snapshotId !== snapshot.snapshotId) ||
    !application?.id ||
    !application.processId ||
    !application.windowId ||
    data.application?.id !== application.id ||
    data.application?.name !== application.name ||
    data.processId !== application.processId ||
    data.windowId !== application.windowId ||
    data.application?.processId !== application.processId ||
    data.application?.windowId !== application.windowId ||
    !Number.isFinite(Date.parse(snapshot.observedAt)) ||
    Date.parse(data.verification.observedAt) < Date.parse(snapshot.observedAt)
  )
    return false;
  // A verified close never proves typing, saving or another action that happened
  // to precede it in a longer request.
  const goal = closeText(parsed.goal).replace(/^please\s+/, '');
  const target = goal.match(/^close\s+(.+)$/)?.[1]?.replace(/^(?:the|my|this|that)\s+/, '');
  const names = [closeText(parsed.query), closeText(application.name)];
  const targets = [
    'it',
    'app',
    'application',
    'window',
    ...names,
    ...names.flatMap((n) => [n + ' window', n + ' app', n + ' application']),
  ];
  if (!target || !targets.includes(target)) return false;
  return (
    parsed.closeOnly ||
    history.slice(0, -1).some((h) => {
      const opened = desktopSnapshot(h.data)?.application;
      return (
        ['desktop_open', 'desktop_launch'].includes(h.toolName) &&
        h.success === true &&
        h.data?.success !== false &&
        opened?.id === application.id &&
        opened.processId === application.processId &&
        opened.windowId === application.windowId
      );
    })
  );
}

/** Preserve all prior observations when a controller has advanced to its last step. */
export function desktopExecutionEvidence(steps, attempts = []) {
  return (attempts.length ? attempts : steps)
    .filter((a) => a.observation)
    .map((a) => {
      const request = a.request || a;
      return {
        ...a.observation,
        toolName: `${request.tool}_${request.action}`,
        toolArguments: request.params,
      };
    });
}
