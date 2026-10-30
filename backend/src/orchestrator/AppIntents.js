// Astra-style app intents: when a goal matches a documented deep link of the target app, the plan opens the app
// straight at that task screen (pre-filled) instead of asking a small local model to click through menus.
//   "open teams schedule meeting tomorrow 3pm with ravi@x.com about sprint sync"
//     -> open Teams (install if missing) -> teams.newMeeting {subject, startTime, endTime, attendees}
//     -> desktop loop: press Send (needs your confirmation)
// Slot values come only from the user's own words; dates/times are computed here, deterministically, in local time.
// Mirrors frontend/tools/apps/AppIntentCatalog.js (INTENT_IDS). Renderer-safe: no Node-only imports.
export const INTENT_IDS = Object.freeze(['teams.newMeeting', 'teams.newChat']);

const TEAMS = /\b(?:ms|microsoft)?\s*teams\b/i;
const MEETING_NOUN = /\b(?:meeting|meet(?:ing)?s?|catch[- ]?up|sync|standup|stand-up|call)\b/i;
const SCHEDULE_VERB =
  /\b(?:schedule|book|set\s*up|setup|arrange|create|new|plan|fix|organi[sz]e|podu|vai|pannu|pannunga|ready)\b/i;
const MESSAGE_VERB = /\b(?:message|msg|chat|text|ping|send|anuppu)\b/i;
const EMAIL_G = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}/g;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const pad = (n) => String(Math.abs(Math.trunc(n))).padStart(2, '0');

/** Local wall-clock time as long ISO 8601 with offset, e.g. 2026-10-30T15:00:00+05:30 (the format Teams documents). */
export function isoLocal(d) {
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`;
}

function parseDay(text, now) {
  const t = text.toLowerCase();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const plus = (n) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + n);
  if (/\bday after tomorrow\b|\bnaal?ai\s+marunaal\b/.test(t)) return plus(2);
  if (/\b(?:tomorrow|tmrw|tmr|tomo|naal?ai(?:ku|kku)?|naale|naalaikku)\b/.test(t)) return plus(1);
  if (/\b(?:today|tonight|indru|innaiku|inniku|innaikku)\b/.test(t)) return plus(0);
  let m = t.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = t.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+(20\d{2}))?\b/,
  );
  if (!m) {
    const r = t.match(
      /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/,
    );
    if (r) m = [r[0], r[2], r[1], r[3]];
  }
  if (m) {
    let d = new Date(m[3] ? +m[3] : base.getFullYear(), MONTHS.indexOf(m[2]), +m[1]);
    if (!m[3] && d < base) d = new Date(d.getFullYear() + 1, d.getMonth(), d.getDate());
    return d;
  }
  // dd/mm or dd/mm/yyyy (day first, as written in India).
  m = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}))?\b/);
  if (m && +m[2] >= 1 && +m[2] <= 12) {
    let d = new Date(m[3] ? +m[3] : base.getFullYear(), +m[2] - 1, +m[1]);
    if (!m[3] && d < base) d = new Date(d.getFullYear() + 1, d.getMonth(), d.getDate());
    return d;
  }
  m = t.match(/\b(next\s+)?(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/);
  if (m) {
    let ahead = (DAYS.indexOf(m[2]) - base.getDay() + 7) % 7 || 7;
    return plus(ahead);
  }
  return null;
}

function hour24(h, min, meridiem, hint) {
  h = +h;
  min = +(min || 0);
  if (h > 23 || min > 59) return null;
  const mer = (meridiem || '').replace(/\./g, '').toLowerCase();
  if (mer === 'pm' && h < 12) h += 12;
  else if (mer === 'am' && h === 12) h = 0;
  else if (!mer && h <= 12) {
    if (/\b(?:evening|night|afternoon|maalai|saayangalam|iravu|mathiyam|madhiyam)\b/i.test(hint)) {
      if (h < 12) h += 12;
    } else if (!/\b(?:morning|kaalai|kalai)\b/i.test(hint) && h >= 1 && h <= 7) h += 12;
  }
  return { h, min };
}

/** {start, end} Dates in local time, or null when the user gave no time of day. */
export function parseWhen(text, now = new Date()) {
  const t = String(text).replace(EMAIL_G, ' ');
  const day = parseDay(t, now);
  const MER = '(am|pm|a\\.m\\.|p\\.m\\.)';
  let start, end;
  let m = t.match(
    new RegExp(
      `\\b(\\d{1,2})(?:[:.](\\d{2}))?\\s*${MER}?\\s*(?:-|–|to|till|until)\\s*(\\d{1,2})(?:[:.](\\d{2}))?\\s*${MER}`,
      'i',
    ),
  );
  if (m) {
    const b = hour24(m[4], m[5], m[6], t);
    let a = hour24(m[1], m[2], m[3] || m[6], t);
    // "11-12pm" means 11am to 12pm: the shared meridiem must not put the start after the end.
    if (a && b && !m[3] && a.h * 60 + a.min >= b.h * 60 + b.min) a = hour24(m[1], m[2], 'am', t);
    if (a && b) [start, end] = [a, b];
  }
  if (!start) {
    m =
      t.match(new RegExp(`\\b(\\d{1,2})(?:[:.](\\d{2}))?\\s*${MER}(?=\\W|$)`, 'i')) ||
      t.match(
        /\b(?:at|@|by)\s+(\d{1,2})(?:[:.](\d{2}))?\b(?!\s*(?:min|hour|hr|day|week|people|person))/i,
      ) ||
      t.match(/\b(\d{1,2}):(\d{2})\b/) ||
      t.match(
        /\b(?:morning|evening|night|afternoon|maalai|kaalai|kalai|saayangalam|mathiyam|madhiyam|iravu)\s+(\d{1,2})(?:[:.](\d{2}))?\b/i,
      ) ||
      t.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(?:mani|manikku|manikki)\b/i);
    if (m) start = hour24(m[1], m[2], /am|pm/i.test(m[3] || '') ? m[3] : '', t);
  }
  if (!start) return null;
  let date = day;
  const at = (d, hm) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), hm.h, hm.min);
  if (!date) {
    date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (at(date, start) <= now)
      date = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  }
  const s = at(date, start);
  let e = end ? at(date, end) : null;
  if (!e || e <= s) {
    let minutes = 30;
    const d = t.match(/\bfor\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i);
    if (d) minutes = Math.round(+d[1] * (/^h/i.test(d[2]) ? 60 : 1));
    else if (/\b(?:an|one|1)\s+hour\b/i.test(t)) minutes = 60;
    else if (/\bhalf\s+(?:an\s+)?hour\b/i.test(t)) minutes = 30;
    minutes = Math.min(Math.max(minutes, 5), 12 * 60);
    e = new Date(s.getTime() + minutes * 60000);
  }
  return { start: s, end: e };
}

const STOP_AFTER =
  '(?=\\s+(?:with|at|on|tomorrow|today|tonight|for\\s+\\d|for\\s+(?:an?|one|half)\\b|from|by|in|next|this|naal?ai|indru|innaiku|at)\\b|\\s+\\d|[,.;!]|$)';
export function parseSubject(text) {
  const q = String(text).match(/["“”'‘’]([^"“”'‘’\n]{2,120})["“”'‘’]/);
  if (q) return q[1].trim();
  const m =
    String(text).match(
      new RegExp(
        `\\b(?:about|regarding|re:|on the topic of|titled|called|named|subject:?|topic:?)\\s+(.+?)${STOP_AFTER}`,
        'i',
      ),
    ) || String(text).match(/\b(.{2,60}?)\s+(?:pathi|patri|kuritha)\b/i);
  const s = m?.[1]?.replace(EMAIL_G, '').trim();
  return s && s.length >= 2 && s.length <= 120 ? s : null;
}
const NOT_NAMES =
  /^(?:me|you|us|team|the team|everyone|all|them|him|her|a|an|the|my|our|teams|meeting|link)$/i;
export function parseInvitees(text) {
  const emails = [...new Set(String(text).match(EMAIL_G) || [])].slice(0, 30);
  // Emails are taken out first: their dots must not end the "with ..." clause.
  const m = String(text)
    .replace(EMAIL_G, ' ')
    .match(
      /\bwith\s+(.+?)(?=\s+(?:at|on|tomorrow|today|tonight|about|regarding|for|from|by|in|next|naal?ai|indru|titled|called)\b|[.;!]|$)/i,
    );
  const names = m
    ? m[1]
        .replace(EMAIL_G, ' ')
        .split(/\s*(?:,|&|\band\b)\s*/i)
        .map((n) => n.trim())
        .filter((n) => /^[\p{L}][\p{L} .'-]{0,39}$/u.test(n) && !NOT_NAMES.test(n))
        .slice(0, 5)
    : [];
  return { emails, names };
}

/** The intent for one goal in one app, or null. `task` is the user's whole request (slot values come from it). */
export function appIntentFor({ app, goal, task, now = new Date() }) {
  if (!TEAMS.test(String(app || ''))) return null;
  const said = `${goal || ''} ${task || ''}`;
  if (MEETING_NOUN.test(said) && SCHEDULE_VERB.test(said) && !/\bjoin\b/i.test(said)) {
    const when = parseWhen(task || goal, now);
    const subject = parseSubject(task || goal);
    const { emails, names } = parseInvitees(task || goal);
    const slots = {
      subject: subject || 'Meeting',
      ...(when ? { startTime: isoLocal(when.start), endTime: isoLocal(when.end) } : {}),
      ...(emails.length ? { attendees: emails } : {}),
    };
    const followUp = [];
    if (names.length)
      followUp.push({
        op: 'goal',
        goal: `add ${names.join(', ')} as required attendees`,
        fresh: true,
      });
    // Never auto-send an invite for a time the user did not give.
    if (when)
      followUp.push({
        op: 'goal',
        goal: `send the meeting invite (press Send, or Save if there is no Send button)`,
        fresh: !names.length,
      });
    return {
      intent: { op: 'intent', intentId: 'teams.newMeeting', slots, app: 'Microsoft Teams' },
      followUp,
      note: when
        ? null
        : 'No meeting time was given, so the form is open and nothing was sent. Pick a time and press Send.',
    };
  }
  if (MESSAGE_VERB.test(said)) {
    const { emails } = parseInvitees(task || goal);
    const q = String(task || goal).match(/["“”'‘’]([^"“”'‘’\n]{1,1000})["“”'‘’]/);
    if (!emails.length) return null;
    return {
      intent: {
        op: 'intent',
        intentId: 'teams.newChat',
        slots: { users: emails, ...(q ? { message: q[1] } : {}) },
        app: 'Microsoft Teams',
      },
      followUp: q ? [{ op: 'goal', goal: `send the message “${q[1]}”`, fresh: true }] : [],
      note: q ? null : 'The chat is open; type your message there.',
    };
  }
  return null;
}

/** Replace a matching goal step of an Astra plan with [intent, ...follow-up goals]. Returns the plan unchanged otherwise. */
export function expandIntents(plan, { now = new Date() } = {}) {
  if (!plan || plan.error || !Array.isArray(plan.steps)) return plan;
  const steps = [];
  let used = false;
  for (const step of plan.steps) {
    const hit =
      !used && step.op === 'goal'
        ? appIntentFor({ app: plan.app, goal: step.goal, task: plan.task, now })
        : null;
    if (!hit) {
      steps.push(step);
      continue;
    }
    used = true;
    steps.push({ ...hit.intent, ...(hit.note ? { note: hit.note } : {}) }, ...hit.followUp);
  }
  return used ? { ...plan, steps } : plan;
}
