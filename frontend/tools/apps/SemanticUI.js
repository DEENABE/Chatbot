import { createHash, randomUUID } from 'node:crypto';
// A snapshot is re-validated against the live UI at act time (locator + signature); this age limit is only a backstop, and
// must outlast a slow local model turn.
export const SNAPSHOT_TTL_MS = Number(process.env.CHANAKYA_SNAPSHOT_TTL_MS) || 900000;
export const digest = (value) => createHash('sha256').update(String(value)).digest('hex');
const sensitive =
  /password|passcode|credential|one.time|verification code|security code|credit.?card|\bcvv\b|\bpin\b|\botp\b|api.?key|access.?token|secret|sign.?in|log.?in/i;
const critical =
  /powershell|command prompt|terminal|script|console|defender|firewall|antivirus|security|permission|privilege|credential|bitlocker|format disk|partition|registry|services|task manager/i;
const dangerous =
  /delete|remove|overwrite|replace|uninstall|install|stop|restart|shutdown|reset|submit|send|publish|purchase|pay|save|create|add|apply|confirm|accept/i;

export function actionPermission(control, operation, application) {
  const context = [
    application.name,
    application.windowTitle,
    control.label,
    control.automationId,
    control.ancestorLabels,
  ].join(' ');
  if (sensitive.test(context) || critical.test(context)) return 'CRITICAL';
  if (control.provider === 'VISION') return 'DANGEROUS';
  if (dangerous.test(control.label || '')) return 'DANGEROUS';
  if (
    [
      'expand',
      'collapse',
      'select',
      'focus',
      'scrollDown',
      'scrollUp',
      'scrollLeft',
      'scrollRight',
    ].includes(operation)
  )
    return 'SAFE_WRITE';
  if (operation === 'setValue' && control.role === 'Edit') return 'SAFE_WRITE';
  if (
    ['invoke', 'click', 'doubleClick'].includes(operation) &&
    (control.parentRole === 'MenuBar' ||
      /^(open|browse|show|view|search|find|play|pause)\b/i.test(control.label))
  )
    return 'SAFE_WRITE';
  // A label alone cannot prove an unknown button is harmless.
  return 'DANGEROUS';
}

export class CapabilityDiscoveryEngine {
  discover(elements) {
    const meanings = [
      ['create', /\b(new|create|add)\b/i],
      ['open', /\b(open|browse|workspace)\b/i],
      ['save', /\bsave\b/i],
      ['export', /\bexport\b/i],
      ['print', /\bprint\b/i],
      ['search', /\b(search|find)\b/i],
      ['media.play', /\bplay\b/i],
      ['media.pause', /\bpause\b/i],
      ['media.next', /\bnext\b/i],
    ];
    return elements
      .flatMap((e) =>
        meanings
          .filter(([, p]) => p.test(e.label))
          .map(([intent]) => ({
            intent,
            elementId: e.elementId,
            actions: e.actions,
            observed: true,
          })),
      )
      .slice(0, 100);
  }
}

export function buildSemanticSnapshot(raw, app, { now = Date.now() } = {}) {
  const snapshotId = randomUUID(),
    ids = new Map(),
    bindings = new Map();
  for (const c of raw.controls || []) ids.set(c.locator, randomUUID());
  const byLocator = new Map((raw.controls || []).map((c) => [c.locator, c]));
  const elements = [],
    seenControls = new Set();
  for (const c of (raw.controls || []).slice(0, 500)) {
    if (
      c.visible === false ||
      c.offscreen === true ||
      (!c.enabled && !c.label) ||
      (!c.label && !c.actions?.length)
    )
      continue;
    const duplicate = [c.provider, c.locator].join('|');
    if (seenControls.has(duplicate)) continue;
    seenControls.add(duplicate);
    let parent = byLocator.get(c.parentId),
      ancestorLabels = '',
      seen = new Set();
    while (parent && !seen.has(parent.locator)) {
      seen.add(parent.locator);
      ancestorLabels += ' ' + parent.label;
      parent = byLocator.get(parent.parentId);
    }
    if (c.sensitive || sensitive.test([c.label, c.automationId, ancestorLabels].join(' ')))
      continue;
    const elementId = ids.get(c.locator),
      control = {
        ...c,
        ancestorLabels,
        parentRole: byLocator.get(c.parentId)?.role,
      };
    const actions = (c.enabled ? c.actions : [])
      .filter((op) =>
        [
          'invoke',
          'expand',
          'collapse',
          'select',
          'toggle',
          'setValue',
          'focus',
          'scrollDown',
          'scrollUp',
          'scrollLeft',
          'scrollRight',
          'click',
          'doubleClick',
        ].includes(op),
      )
      .map((operation) => ({
        operation,
        permission: actionPermission(control, operation, {
          ...app,
          windowTitle: raw.windowTitle,
        }),
      }));
    elements.push({
      elementId,
      label: String(c.label || '').slice(0, 300),
      role: c.role,
      automationId: c.automationId || '',
      parentId: ids.get(c.parentId) || null,
      enabled: !!c.enabled,
      selected: !!c.selected,
      focused: !!c.focused,
      text: String(c.text || '').slice(0, 300),
      shortcut: c.shortcut || '',
      provider: c.provider,
      visible: true,
      bounds: {
        x: c.x || 0,
        y: c.y || 0,
        width: c.width || 0,
        height: c.height || 0,
      },
      actions,
    });
    bindings.set(elementId, control);
  }
  const snapshot = {
    success: true,
    status: 'UI_OBSERVED',
    mode: 'GENERIC_INSPECTION_MODE',
    snapshotId,
    observedAt: new Date(now).toISOString(),
    application: {
      id: app.id,
      name: app.name,
      processId: raw.processId,
      windowId: raw.windowId,
      title: raw.windowTitle,
    },
    currentView: {
      type: raw.isDialog || elements.some((e) => e.role === 'Dialog') ? 'dialog' : 'window',
    },
    provider: raw.provider,
    truncated: !!raw.truncated,
    inspectionStatus: elements.some((e) => e.actions.some((a) => a.permission !== 'CRITICAL'))
      ? 'available'
      : 'limited',
    accessibleElements: elements.length,
    support: elements.some((e) => e.actions.some((a) => a.permission !== 'CRITICAL'))
      ? raw.truncated || raw.provider !== 'UIA' || elements.length < 5
        ? 'PARTIAL_UIA_SUPPORT'
        : 'FULL_UIA_SUPPORT'
      : 'NO_USEFUL_UIA_SUPPORT',
    elements,
    capabilities: new CapabilityDiscoveryEngine().discover(elements),
    fallback: {
      uia: raw.provider === 'UIA' ? 'available' : 'incomplete',
      accessibility: raw.provider === 'MSAA' ? 'available' : 'not_needed',
      keyboard: 'bound_window_only',
      vision: raw.visionStatus || 'not_configured',
      coordinates: 'native_observed_element_only',
    },
    trust: 'UNTRUSTED_APPLICATION_DATA',
  };
  return { snapshot, bindings, raw, app, createdAt: now, used: false };
}

export class ActionGroundingEngine {
  ground(record, params, now = Date.now()) {
    if (!record || record.used || now - record.createdAt > SNAPSHOT_TTL_MS)
      throw Object.assign(new Error('Observe the application again before acting.'), {
        code: 'STALE_SNAPSHOT',
      });
    const element = record.snapshot.elements.find((e) => e.elementId === params.elementId);
    const action = element?.actions.find((a) => a.operation === params.operation);
    if (!element || !action || !element.enabled)
      throw Object.assign(new Error('Action is not grounded in the latest observed UI.'), {
        code: 'UNGROUNDED_ACTION',
      });
    if (action.permission === 'CRITICAL')
      throw Object.assign(new Error('Security-sensitive UI control is blocked.'), {
        code: 'CRITICAL_OPERATION',
      });
    if (
      params.operation === 'setValue' &&
      (typeof params.value !== 'string' || params.value.length > 2000)
    )
      throw Object.assign(new Error('A bounded text value is required.'), {
        code: 'INVALID_PARAMS',
      });
    if (params.operation !== 'setValue' && params.value !== undefined)
      throw Object.assign(new Error('Only setValue accepts text.'), {
        code: 'INVALID_PARAMS',
      });
    return { element, action, binding: record.bindings.get(params.elementId) };
  }
}
