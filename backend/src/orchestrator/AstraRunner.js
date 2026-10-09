// Drives an Astra plan (see AstraTask.js) one tool call per turn. The chat protocol is stateless: every turn the runner
// replays the tool results of the current request against the plan to find where it is, then proposes the next call.
// Only the plan itself (and where model-driven "goal" steps finished) is kept in memory, keyed by user + conversation +
// request, so a resent request never re-plans differently halfway through.
import { desktopSnapshot, desktopCompletion } from './GenericDesktopTask.js';
import { nextDesktopDecision } from './GenericAppPlanner.js';
import { planAstraTask, astraTask, composeText } from './AstraTask.js';
import { completeJSON, DEFAULT_MODEL } from '../ai/llmClient.js';
import { modelRuntime } from '../services/modelRuntime.js';
import { verificationPredicates } from './CapabilityContracts.js';
import { nextSoftwareDecision } from './SoftwareRunner.js';

const plans = new Map();
const TTL = 2 * 60 * 60 * 1000,
  MAX_PLANS = 200,
  MAX_EVENTS = 80;
export const clearAstraPlans = () => plans.clear();
function remember(key, entry) {
  plans.delete(key);
  plans.set(key, entry);
  for (const [k, v] of plans)
    if (plans.size > MAX_PLANS || Date.now() - v.createdAt > TTL) plans.delete(k);
    else break;
}

const ok = (e) => e?.success === true && e.data?.success !== false;
const code = (e) => e?.error?.code || e?.data?.code || e?.data?.status || 'UNKNOWN';
const why = (e) => String(e?.error?.message || e?.data?.message || code(e)).slice(0, 500);
const RETRY = new Set([
  'STALE_SNAPSHOT',
  'UI_BUSY',
  'WINDOW_NOT_FOUND',
  'UI_INSPECTION_FAILED',
  'FOCUS_UNVERIFIED',
  'NO_EDITABLE_FOCUS',
  'UI_EXECUTION_UNCERTAIN',
  'TARGET_WINDOW_CHANGED',
  'CONTROL_NOT_FOUND',
]);
const PLAIN_LAUNCH_FALLBACK = new Set([
  'UI_INSPECTION_FAILED',
  'UI_EXECUTION_FAILED',
  'UI_AUTOMATION_INSUFFICIENT',
]);
const TEXT_ROLES = new Set(['Edit', 'Document', 'ComboBox']);
const tokens = (s) =>
  String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter(Boolean);

function packageCandidates(results, app) {
  const want = tokens(app);
  if (!Array.isArray(results) || !want.length) return { exact: [], plausible: [] };
  const seen = new Set();
  const rows = results.filter((r) => {
    if (
      typeof r?.name !== 'string' ||
      !r.name.trim() ||
      typeof r.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._+-]{1,127}$/.test(r.id) ||
      seen.has(r.id.toLowerCase())
    )
      return false;
    seen.add(r.id.toLowerCase());
    return true;
  });
  const normalized = (name) => tokens(name).join(' ');
  const requested = want.join(' ');
  const exact = rows.filter(
    (r) =>
      normalized(r.name) === requested ||
      normalized(r.id) === requested ||
      normalized(r.id.split('.').at(-1)) === requested,
  );
  const fits = (r) => {
    const have = new Set([...tokens(r.name), ...tokens(r.id)]);
    return want.every((w) => have.has(w));
  };
  return { exact, plausible: rows.filter(fits) };
}

/** A unique exact name/id match wins; otherwise there must be only one plausible package. Never guess among ties. */
export function pickPackage(results, app) {
  const { exact, plausible } = packageCandidates(results, app);
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  return plausible.length === 1 ? plausible[0] : null;
}

function verifiedPlainOpen(snapshot) {
  return (
    snapshot?.success === true &&
    typeof snapshot.snapshotId === 'string' &&
    !!snapshot.snapshotId.trim() &&
    typeof snapshot.observedAt === 'string' &&
    Number.isFinite(Date.parse(snapshot.observedAt)) &&
    Number.isSafeInteger(snapshot.application?.processId) &&
    snapshot.application.processId > 0 &&
    Number.isSafeInteger(snapshot.application?.windowId) &&
    snapshot.application.windowId > 0 &&
    typeof snapshot.application.name === 'string' &&
    !!snapshot.application.name.trim() &&
    Array.isArray(snapshot.elements)
  );
}

function verifiedPlainLaunch(data) {
  if (
    !data ||
    !verificationPredicates['app.openApp'](data) ||
    typeof data.app?.name !== 'string' ||
    !data.app.name.trim()
  )
    return false;
  // ProcessService's already-running path proves a visible process through readiness. New launches also
  // return an HWND; reject invalid or conflicting handles when that stronger evidence is available.
  const handle = (value) => {
    const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  };
  const main = data.windowId;
  const ready = data.readiness.windowId;
  if (main !== undefined && handle(main) === null) return false;
  if (ready !== undefined && handle(ready) === null) return false;
  if (main !== undefined && ready !== undefined && handle(main) !== handle(ready)) return false;
  return true;
}

/** Text -> keyboard operations: lines of at most 500 characters, Enter between lines. */
export function typingOps(text) {
  const ops = [];
  String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .forEach((line, i) => {
      if (i > 0) ops.push({ kind: 'key', keys: 'enter' });
      for (let at = 0; at < line.length; at += 500)
        ops.push({
          kind: 'type',
          text: line.slice(at, at + 500).replace(/[\x00-\x1f\x7f]/g, ' '),
        });
    });
  return ops.filter((o) => o.kind === 'key' || o.text.length);
}

/** The control to put the caret in: the focused text field, else the largest focusable document/edit. */
function textTarget(snapshot) {
  const fields = (snapshot?.elements || []).filter(
    (e) =>
      TEXT_ROLES.has(e.role) &&
      e.enabled !== false &&
      e.actions?.some(
        (a) => a.operation === 'focus' && a.allowed !== false && a.permission !== 'CRITICAL',
      ),
  );
  const area = (e) => (e.bounds?.width || 0) * (e.bounds?.height || 0);
  return (
    fields.sort(
      (a, b) => (b.role === 'Document') - (a.role === 'Document') || area(b) - area(a),
    )[0] || null
  );
}

// ─── Step handlers: init(step,ctx) -> state, feed(state,event,ctx), next(state,ctx) -> decision ───
/**
 * Typo candidates for an application name nobody can find ("vcl", "google chorme"): the name with one adjacent letter pair
 * swapped, tried one winget search per turn only after the exact name found nothing. Only winget results that fit the
 * corrected name are ever offered, and installing still needs the user's approval.
 */
export function typoVariants(name, limit = 12) {
  const words = String(name || '')
    .trim()
    .split(/\s+/);
  const out = [];
  for (let w = words.length - 1; w >= 0; w--) {
    const word = words[w];
    if (!/^[a-z]{3,}$/i.test(word)) continue;
    for (let i = 0; i < word.length - 1; i++) {
      if (word[i] === word[i + 1]) continue;
      const swapped = word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
      out.push(words.map((x, k) => (k === w ? swapped : x)).join(' '));
    }
  }
  return [...new Set(out)].slice(0, limit);
}
const MISSING_APP = new Set(['APP_NOT_INSTALLED', 'APP_NOT_FOUND']);
const handlers = {
  open: {
    init: () => ({ stage: 'open', retries: 0, softwareEvidence: [] }),
    feed(s, e, ctx) {
      if (s.stage === 'software' && /^software_/.test(e.toolName || '')) {
        s.softwareEvidence.push(e);
        const decision = nextSoftwareDecision({
          admission: {
            query: {
              operation: 'install',
              product: ctx.app,
              architecture: 'auto',
              scope: 'application',
            },
          },
          evidence: s.softwareEvidence,
          signal: ctx.signal,
        });
        if (decision.success === true) {
          const resolved = s.softwareEvidence.findLast(
            (event) => event.toolName === 'software_resolve' && ok(event),
          );
          const plan = resolved?.data?.plan || {};
          ctx.pkg = {
            id: plan.planId || decision.planId,
            name: plan.name || ctx.app,
            publisher: plan.publisher,
            source: 'software',
          };
          ctx.installed = ctx.pkg;
          s.stage = 'reopen';
        } else if (decision.success === false) s.failed = decision.message;
        return;
      }
      if (e.toolName === 'desktop_open' && ['open', 'reopen', 'reopenByName'].includes(s.stage)) {
        const snapshot = desktopSnapshot(e.data);
        if (ok(e) && snapshot && (!ctx.plan.plainOpen || verifiedPlainOpen(snapshot))) {
          s.done = true;
          ctx.appQuery = s.stage === 'reopenByName' ? ctx.pkg.name : ctx.app;
          ctx.appName = snapshot.application?.name || ctx.app;
          return;
        }
        if (ok(e) && ctx.plan.plainOpen) {
          s.failed = ctx.installed
            ? `${ctx.pkg.name} was installed, but its application window could not be verified as open.`
            : `${ctx.app}'s application window could not be verified as open.`;
          return;
        }
        const c = code(e);
        // APP_NOT_FOUND is what AppService reports when part of application discovery failed, so a missing app
        // looks like "no confident match". It is still a miss: winget search decides, and install needs approval.
        if (
          (ctx.plan.plainOpen ? c === 'APP_NOT_INSTALLED' : MISSING_APP.has(c)) &&
          s.stage === 'open' &&
          ctx.plan.install !== false
        ) {
          s.stage = 'software';
          return;
        }
        if (
          MISSING_APP.has(c) &&
          s.stage === 'reopen' &&
          ctx.pkg?.name &&
          ctx.pkg.name.toLowerCase() !== ctx.app.toLowerCase()
        ) {
          s.stage = 'reopenByName';
          return;
        }
        if (ctx.plan.plainOpen && PLAIN_LAUNCH_FALLBACK.has(c)) {
          s.launchQuery = s.stage === 'reopenByName' ? ctx.pkg.name : ctx.app;
          s.stage = 'launchOnly';
          return;
        }
        if (RETRY.has(c) && s.retries++ < 2) return;
        s.failed = ctx.installed
          ? `${ctx.pkg.name} was installed, but I could not verify that it opened: ${why(e)}`
          : why(e);
        return;
      }
      if (e.toolName === 'app_openApp' && s.stage === 'launchOnly') {
        if (ok(e) && verifiedPlainLaunch(e.data)) {
          s.done = true;
          ctx.appQuery = s.launchQuery;
          ctx.appName = e.data.app.name;
          if (e.data.inspection?.success === false)
            ctx.openingNote = ' Its interface could not be inspected.';
          return;
        }
        s.failed = ctx.installed
          ? `${ctx.pkg.name} was installed, but I could not verify that it opened: ${ok(e) ? 'the launcher returned no verified readiness evidence' : why(e)}`
          : `I could not verify opening ${ctx.app}: ${ok(e) ? 'the launcher returned no verified readiness evidence' : why(e)}`;
        return;
      }
    },
    next(s, ctx) {
      if (s.stage === 'software') {
        const decision = nextSoftwareDecision({
          admission: {
            query: {
              operation: 'install',
              product: ctx.app,
              architecture: 'auto',
              scope: 'application',
            },
          },
          evidence: s.softwareEvidence,
          signal: ctx.signal,
        });
        if (decision.call || decision.waiting) return decision;
        return { fail: decision.message || 'Software installation was not verified.' };
      }
      if (s.stage === 'launchOnly')
        return {
          call: {
            tool: 'app',
            action: 'openApp',
            params: { query: s.launchQuery },
          },
          note: 'verifying the application launch after UI inspection was unavailable',
        };
      return {
        call: {
          tool: 'desktop',
          action: 'open',
          params: {
            query: s.stage === 'reopenByName' ? ctx.pkg.name : ctx.app,
          },
        },
      };
    },
  },
  type: {
    init: (step) => ({
      ops: typingOps(step.text),
      i: 0,
      retries: 0,
      focusTries: 0,
      newDoc: false,
      needObserve: false,
    }),
    feed(s, e, ctx) {
      if (e.toolName === 'desktop_observe') {
        if (ok(e)) s.needObserve = false;
        else if (s.retries++ > 3) s.failed = why(e);
        return;
      }
      if (e.toolName === 'desktop_act') {
        s.focusTries++;
        if (!ok(e) && s.focusTries > 2)
          s.failed = `I could not put the cursor in ${ctx.appName}'s text area: ${why(e)}`;
        if (!ok(e)) s.needObserve = true;
        return;
      }
      if (e.toolName === 'desktop_inputConfirmed') {
        s.newDoc = true;
        if (!ok(e)) s.needObserve = true;
        return;
      }
      if (e.toolName === 'desktop_input') {
        if (ok(e) && e.data?.status === 'UI_ACTION_VERIFIED') {
          s.i++;
          s.retries = 0;
          if (s.i >= s.ops.length) {
            s.done = true;
            ctx.typed =
              (ctx.typed || 0) +
              s.ops.filter((o) => o.kind === 'type').reduce((n, o) => n + o.text.length, 0);
          }
          return;
        }
        // Only failures known to precede input can retry after observation.
        // Sent/unverified text is never counted as typed or replayed blindly.
        if (
          ['STALE_SNAPSHOT', 'UI_BUSY', 'FOCUS_UNVERIFIED', 'NO_EDITABLE_FOCUS'].includes(
            code(e),
          ) &&
          s.retries++ < 3
        ) {
          s.needObserve = true;
          return;
        }
        s.failed = `Typing in ${ctx.appName} failed: ${why(e)}`;
      }
    },
    next(s, ctx) {
      const snap = ctx.snapshot;
      if (!s.ops.length) return { done: true };
      if (!snap || s.needObserve)
        return {
          call: {
            tool: 'desktop',
            action: 'observe',
            params: { query: ctx.appQuery },
          },
        };
      if (s.i === 0 && !s.newDoc && ctx.step.fresh !== false) {
        // A restored tab (Windows 11 Notepad) already holds text: ask before opening a new document so nothing is mixed.
        const field =
          snap.elements?.find((e) => e.elementId === snap.input?.focusedTextField?.elementId) ||
          textTarget(snap);
        if (field?.text?.trim() && snap.input?.keys?.allowed)
          return {
            call: {
              tool: 'desktop',
              action: 'inputConfirmed',
              params: {
                snapshotId: snap.snapshotId,
                kind: 'key',
                keys: 'ctrl+n',
              },
            },
            note: 'the open document already has text - new document',
          };
      }
      if (!snap.input?.type?.allowed) {
        if (!snap.input?.keys?.allowed)
          return {
            fail: `${ctx.appName} is not allowed keyboard input in App Permissions (needs “interact” or higher).`,
          };
        const target = textTarget(snap);
        if (!target)
          return {
            fail: `${ctx.appName} shows no text field I can type into.`,
          };
        return {
          call: {
            tool: 'desktop',
            action: 'act',
            params: {
              snapshotId: snap.snapshotId,
              elementId: target.elementId,
              operation: 'focus',
            },
          },
        };
      }
      const op = s.ops[s.i];
      return {
        call: {
          tool: 'desktop',
          action: 'input',
          params:
            op.kind === 'type'
              ? { snapshotId: snap.snapshotId, kind: 'type', text: op.text }
              : { snapshotId: snap.snapshotId, kind: 'key', keys: op.keys },
        },
      };
    },
  },
  save_as: {
    init: () => ({ retries: 0, needObserve: false }),
    feed(s, e, ctx) {
      if (e.toolName === 'desktop_observe') {
        if (ok(e)) s.needObserve = false;
        else s.failed = why(e);
        return;
      }
      if (e.toolName !== 'desktop_saveAs') return;
      if (ok(e) && e.data?.status === 'FILE_SAVED') {
        s.done = true;
        (ctx.saved ||= []).push(e.data.path);
        return;
      }
      if (['STALE_SNAPSHOT', 'UI_BUSY'].includes(code(e)) && s.retries++ < 1) {
        s.needObserve = true;
        return;
      }
      s.failed = `Saving failed: ${why(e)}`;
    },
    next(s, ctx) {
      const snap = ctx.snapshot;
      if (!snap || s.needObserve)
        return {
          call: {
            tool: 'desktop',
            action: 'observe',
            params: { query: ctx.appQuery },
          },
        };
      return {
        call: {
          tool: 'desktop',
          action: 'saveAs',
          params: {
            snapshotId: snap.snapshotId,
            path: ctx.step.path,
            overwrite: !!ctx.step.overwrite,
          },
        },
      };
    },
  },
  goal: {
    init: (step, ctx) => ({ events: [], seed: ctx.snapshotEvent }),
    feed(s, e, ctx) {
      if (!e.toolName?.startsWith('desktop_')) return;
      s.events.push(e);
      if (e.toolName === 'desktop_verify' && desktopCompletion(e.data, ctx.step.goal)) {
        s.done = true;
        (ctx.goals ||= []).push(e.data.message || ctx.step.goal);
      }
    },
    async next(s, ctx) {
      const evidence = [s.seed, ...s.events].filter(Boolean);
      const d = await ctx.desktopDecision({
        task: ctx.step.goal,
        evidence,
        model: ctx.model,
        signal: ctx.signal,
        intent: {
          query: ctx.appQuery,
          goal: ctx.step.goal,
          task: ctx.step.goal,
        },
      });
      if (d.call) return { call: d.call };
      if (d.waiting) return { waiting: true, message: d.message };
      if (d.success === true) return { done: true, message: d.message || ctx.step.goal };
      return {
        fail: d.message || `“${ctx.step.goal}” could not be verified in ${ctx.appName}.`,
      };
    },
  },
};

function summary(ctx) {
  const parts = [];
  if (ctx.installed)
    parts.push(
      ctx.installed.source === 'software'
        ? `installed ${ctx.installed.name} using its verified software provider`
        : ctx.installed.source === 'web'
          ? `installed ${ctx.installed.name} from ${ctx.installed.host} (installer signed by ${ctx.installed.publisher})`
          : ctx.installed.source === 'msstore'
            ? `installed ${ctx.installed.name} (${ctx.installed.id}) from the Microsoft Store`
            : `installed ${ctx.installed.name} (${ctx.installed.id}) with winget`,
    );
  parts.push(`opened ${ctx.appName || ctx.app}`);
  if (ctx.typed)
    parts.push(
      `${ctx.plan.steps.some((s) => s.composed) ? 'wrote and typed the content' : 'typed your text'} (${ctx.typed} characters)`,
    );
  for (const p of ctx.saved || []) parts.push(`saved it to ${p} - verified on disk`);
  for (const g of ctx.goals || []) parts.push(g.replace(/[.\s]+$/, ''));
  return `Done: ${parts.join(', ')}.${ctx.openingNote || ''}`;
}

/**
 * Next decision for an Astra task: {call:{tool,action,params}} | {waiting:true,message} | {success:true|false,message}.
 * @param key    stable id of this request (user + conversation + request text)
 * @param evidence tool results of the current request, oldest first ({toolName,success,data,error,needsConfirmation...})
 */
export async function nextAstraDecision({
  key,
  task,
  admission,
  evidence = [],
  model = DEFAULT_MODEL,
  signal,
  planner = planAstraTask,
  desktopDecision = nextDesktopDecision,
  composer = composeText,
}) {
  let entry = plans.get(key);
  if (!entry) {
    const plan = await planner({
      task,
      admission: admission || astraTask(task),
      model,
      signal,
      complete: completeJSON,
    });
    if (plan.error) return { success: false, message: plan.error };
    // Content the user asked to be written is generated once, here, so every later turn replays the same text.
    for (const [i, step] of plan.steps.entries())
      if (step.op === 'compose') {
        try {
          plan.steps[i] = {
            op: 'type',
            text: await composer({
              about: step.about,
              app: plan.app,
              task,
              model: modelRuntime.getStore()?.generalModel || model,
              signal,
              complete: completeJSON,
            }),
            composed: true,
          };
        } catch (error) {
          if (signal?.aborted) throw error;
          return {
            success: false,
            message: `I could not write “${step.about}”: ${error.message}`,
          };
        }
      }
    entry = { plan, marks: {}, messages: {}, createdAt: Date.now() };
    remember(key, entry);
  }
  const last = evidence.at(-1);
  if (last?.needsConfirmation)
    return {
      waiting: true,
      message: last.confirmationMessage || 'Waiting for your confirmation.',
    };
  if (last?.needsAppChoice)
    return {
      waiting: true,
      message: last.choiceMessage || 'Waiting for you to choose the application.',
    };
  if (evidence.length >= MAX_EVENTS)
    return {
      success: false,
      message: 'The task used its whole action budget before it was verified as complete.',
    };

  const plan = entry.plan,
    steps = [{ op: 'open' }, ...plan.steps];
  const ctx = {
    plan,
    app: plan.app,
    appQuery: plan.app,
    appName: plan.app,
    model,
    signal,
    desktopDecision,
    snapshot: null,
    snapshotEvent: null,
  };
  let cursor = 0;
  const track = (e) => {
    const snap = desktopSnapshot(e?.data);
    if (snap) {
      ctx.snapshot = snap;
      ctx.snapshotEvent = e;
    }
  };
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index],
      handler = handlers[step.op];
    ctx.step = step;
    const state = handler.init(step, ctx);
    while (cursor < evidence.length && !state.done && !state.failed) {
      if (entry.marks[index] !== undefined && cursor >= entry.marks[index]) break;
      const e = evidence[cursor++];
      handler.feed(state, e, ctx);
      track(e);
    }
    if (state.failed) return { success: false, message: state.failed };
    if (entry.marks[index] !== undefined && cursor >= entry.marks[index]) {
      if (entry.messages[index]) (ctx.goals ||= []).push(entry.messages[index]);
      continue;
    }
    if (state.done) continue;
    const d = await handler.next(state, ctx);
    if (d.call) return { call: d.call, note: d.note, step: index, plan };
    if (d.waiting) return { ...d, waiting: true, message: d.message };
    if (d.fail) return { success: false, message: d.fail };
    if (d.done) {
      entry.marks[index] = cursor;
      if (d.message) {
        entry.messages[index] = d.message;
        (ctx.goals ||= []).push(d.message);
      }
      continue;
    }
  }
  plans.delete(key);
  return { success: true, message: summary(ctx), plan };
}
