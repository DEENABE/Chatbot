// Fixed app-neutral tools. Targets are opaque IDs from the current observation;
// there are deliberately no coordinates, executable paths, scripts or app recipes.
const id = { type: 'string', required: true, minLength: 1, maxLength: 40 };
const snapshot = { snapshotId: id };
const element = { ...snapshot, elementId: id };
export const primitiveSchemas = Object.freeze({
  launch: {
    app: { type: 'string', required: true, minLength: 1, maxLength: 200 },
  },
  click: element,
  doubleClick: element,
  select: element,
  focus: element,
  read: element,
  type: {
    ...snapshot,
    text: { type: 'string', required: true, minLength: 1, maxLength: 500 },
  },
  press: {
    ...snapshot,
    key: { type: 'string', required: true, minLength: 1, maxLength: 40 },
  },
  hotkey: {
    ...snapshot,
    keys: {
      type: 'array',
      required: true,
      minItems: 2,
      maxItems: 4,
      itemSchema: { type: 'string', minLength: 1, maxLength: 12 },
    },
  },
  scroll: {
    ...element,
    direction: {
      type: 'enum',
      required: true,
      values: ['up', 'down', 'left', 'right'],
    },
  },
  find: {
    ...snapshot,
    label: { type: 'string', required: true, minLength: 1, maxLength: 300 },
    role: { type: 'string', maxLength: 50 },
  },
  waitFor: {
    ...element,
    timeoutMs: { type: 'number', integer: true, min: 0, max: 10000 },
  },
  close: snapshot,
});
export const primitiveNames = Object.freeze(Object.keys(primitiveSchemas));
export const primitiveDescriptions = Object.freeze({
  launch:
    'Discover the named app on this machine, launch/focus it, bind its process and window, and observe its UI.',
  click:
    'Activate one observed element using its UIA/MSAA pattern; guarded mouse fallback uses freshly resolved bounds.',
  doubleClick:
    'Double-click one observed element after checking its live identity, bounds, foreground and window ownership.',
  select: 'Select one observed selectable element.',
  focus: 'Focus one observed element.',
  type: 'Type exact user-provided text into the bound input.typeTarget; native value API first, guarded keyboard fallback.',
  press: 'Press one key in the bound window. Use hotkey for a chord.',
  hotkey: 'Press one chord (e.g. ["ctrl","f"]) in the bound window.',
  scroll: 'Scroll one observed scroll container in the given direction.',
  read: 'Re-read the exact live element, returning bounded text as untrusted data.',
  find: 'Find elements in the current snapshot by literal label and optional role. No guessed locators.',
  waitFor:
    'Wait, without clicking, for the same observed element to be present and enabled; bounded to ten seconds.',
  close:
    'Request a normal close of the bound window after approval; observe any resulting save dialog. Never kill a process.',
});
