// Fixed catalog of application "intents": documented deep links that open an app straight at a task screen
// (a pre-filled Teams meeting form, a Teams chat with a draft message). This is how an Astra-style agent does
// app-specific work reliably without clicking through menus.
//
// Security model:
//  - The model and the backend never supply a URI. They name an intentId and plain slot values; the URI is built
//    here from the fixed template, with every value validated and percent-encoded.
//  - An intent only OPENS a form. Anything that sends/saves still goes through the observed desktop loop, where
//    Send/Save controls are DANGEROUS and need a human confirmation.
//  - Mirrored by backend/src/orchestrator/AppIntents.js (INTENT_IDS); keep them in sync.
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2}|Z)$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const fail = (code, message) => Object.assign(new Error(message || code), { code });

const text = (max) => (v) =>
  typeof v === 'string' && v.trim() && v.length <= max && !CONTROL.test(v);
const multiline = (max) => (v) =>
  typeof v === 'string' &&
  v.trim() &&
  v.length <= max &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
const emails = (max) => (v) =>
  Array.isArray(v) &&
  v.length >= 1 &&
  v.length <= max &&
  v.every((e) => typeof e === 'string' && EMAIL.test(e));
const iso = (v) => typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v));

export const APP_INTENTS = Object.freeze({
  'teams.newMeeting': Object.freeze({
    scheme: 'msteams',
    path: '/l/meeting/new',
    appQuery: 'Microsoft Teams',
    processHint: /^(ms-teams|teams)$/i,
    description:
      'Open the Microsoft Teams meeting scheduling form, pre-filled. Does not send anything.',
    slots: Object.freeze({
      subject: { valid: text(200) },
      startTime: { valid: iso },
      endTime: { valid: iso },
      attendees: { valid: emails(30), join: ',' },
      content: { valid: multiline(1000) },
    }),
  }),
  'teams.newChat': Object.freeze({
    scheme: 'msteams',
    path: '/l/chat/0/0',
    appQuery: 'Microsoft Teams',
    processHint: /^(ms-teams|teams)$/i,
    description: 'Open a Microsoft Teams chat with a draft message. Does not send anything.',
    slots: Object.freeze({
      users: { valid: emails(10), join: ',', required: true },
      topicName: { valid: text(200) },
      message: { valid: multiline(1000) },
    }),
  }),
});
export const INTENT_IDS = Object.freeze(Object.keys(APP_INTENTS));

/** Validate slots and build the deep-link URI. Throws INTENT_INVALID on anything unexpected. */
export function buildIntentUri(intentId, slots = {}) {
  const intent = Object.hasOwn(APP_INTENTS, intentId) ? APP_INTENTS[intentId] : null;
  if (!intent) throw fail('INTENT_UNKNOWN', 'Unknown application intent.');
  if (!slots || typeof slots !== 'object' || Array.isArray(slots))
    throw fail('INTENT_INVALID', 'Intent slots must be an object.');
  const query = [];
  for (const [name, value] of Object.entries(slots)) {
    const spec = Object.hasOwn(intent.slots, name) ? intent.slots[name] : null;
    if (!spec) throw fail('INTENT_INVALID', `Unsupported intent field: ${name}`);
    if (value === undefined || value === null || value === '') continue;
    if (!spec.valid(value)) throw fail('INTENT_INVALID', `Invalid value for ${name}.`);
    // encodeURIComponent keeps spaces as %20 (Teams treats "+" literally); list separators stay literal commas.
    const encoded = Array.isArray(value)
      ? value.map(encodeURIComponent).join(spec.join || ',')
      : encodeURIComponent(value);
    query.push(`${name}=${encoded}`);
  }
  for (const [name, spec] of Object.entries(intent.slots))
    if (spec.required && !(name in slots)) throw fail('INTENT_INVALID', `Missing ${name}.`);
  if (slots.startTime && slots.endTime && Date.parse(slots.endTime) <= Date.parse(slots.startTime))
    throw fail('INTENT_INVALID', 'The meeting must end after it starts.');
  if (slots.startTime) {
    const delta = Date.parse(slots.startTime) - Date.now();
    if (delta < -24 * 3600e3 || delta > 400 * 24 * 3600e3)
      throw fail('INTENT_INVALID', 'The meeting time is outside the supported range.');
  }
  const uri = `${intent.scheme}:${intent.path}${query.length ? '?' + query.join('&') : ''}`;
  if (uri.length > 4000 || CONTROL.test(uri) || /["<>`]/.test(uri))
    throw fail('INTENT_INVALID', 'The intent link is not safe to open.');
  return { uri, intent };
}
