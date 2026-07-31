/**
 * @module widget/greetings
 * @description The lines Chanakya says when you hover the bubble.
 *
 * The point is to answer "what can this thing do for me?" without the user
 * having to open the chat first. Lines are short enough to read in the second
 * or two a hover lasts, and they rotate so the avatar does not feel canned.
 */

/** Time-aware opener, so the first line of a session feels present. */
function timeGreeting(hour) {
  if (hour < 5) return 'Still up?';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  if (hour < 21) return 'Good evening';
  return 'Working late?';
}

/**
 * What Chanakya can actually do — phrased as an offer, not a feature list.
 * Keep each under ~70 characters so it fits the speech bubble on one or two
 * lines without truncation.
 */
const CAPABILITIES = [
  'Wi-Fi acting up? I can diagnose and fix it.',
  'I can repair Bluetooth, audio and printer problems.',
  'PC feeling slow? Let me find what is eating it.',
  'Ask me about anything in your uploaded documents.',
  'I can read your screen and explain what is on it.',
  'Stuck Windows Update? I can reset it for you.',
  'I can free up disk space safely.',
  'Talk to me — press the mic and just say it.',
  'I can check your security and firewall settings.',
  'Something broken? Describe it and I will investigate.',
];

/**
 * The name to greet the signed-in user by: their display name's first word,
 * falling back to the username when no display name was set. Capitalised, since
 * usernames are stored lowercased.
 *
 * @param {{displayName?: string, username?: string}} [user]
 * @returns {string} A first name, or '' when there is nobody to greet.
 */
export function firstNameOf(user) {
  const raw = (user?.displayName || user?.username || '').trim();
  if (!raw) return '';
  const first = raw.split(/\s+/)[0];
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** Shown the first time the user hovers in a session. */
export function openingLine(name) {
  const hour = new Date().getHours();
  const who = name ? `, ${name}` : '';
  return `${timeGreeting(hour)}${who}. How can I help?`;
}

/**
 * Pick a capability line, avoiding an immediate repeat of the previous one.
 *
 * @param {string} [previous] - The line shown last time.
 * @returns {string}
 */
export function capabilityLine(previous) {
  const pool = CAPABILITIES.filter((line) => line !== previous);
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * The line to show for a hover.
 *
 * @param {Object} args
 * @param {boolean} args.isFirstHover - True for the first hover of the session.
 * @param {string} [args.displayName] - The signed-in user's name, if any.
 * @param {string} [args.previous] - The previously shown line.
 * @returns {string}
 */
export function nextLine({ isFirstHover, displayName, previous }) {
  return isFirstHover ? openingLine(displayName) : capabilityLine(previous);
}
