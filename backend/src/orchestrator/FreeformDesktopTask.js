// Free-form desktop requests: "play my movie in VLC", "in Notepad++ replace hello with hi", "vlc la movie play pannu".
// Admission needs three independent signals, so ordinary chat that merely mentions a product is not taken over:
//   1. the message names an application that is actually installed (matched against the catalog the desktop app sent),
//   2. the name appears in an action context (after in/on/using/with/via..., after open/launch/use..., or before a
//      Tanglish/Hindi postposition such as "la"/"mein"),
//   3. the message is an instruction (has an action word, is not a question/explanation, is not an install request).
// Nothing here derives a path or command; the app name is resolved later by the local registry.
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}+#]+/gu, ' ').trim();
const MAX_APPS = 200;
let installed = [];

/** Accepts [{name, aliases?}] from the desktop app; anything malformed is dropped. */
export function sanitizeInstalledApps(list) {
  if (!Array.isArray(list)) return [];
  const apps = [];
  for (const item of list.slice(0, MAX_APPS)) {
    if (!item || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100) continue;
    const names = new Set([normalize(item.name)]);
    for (const alias of Array.isArray(item.aliases) ? item.aliases.slice(0, 8) : []) if (typeof alias === 'string' && alias.length <= 80) names.add(normalize(alias));
    const usable = [...names].filter(n => n.length >= 3 && n.length <= 80);
    if (usable.length) apps.push({ name: item.name.trim(), names: usable });
  }
  return apps;
}
export function setInstalledApps(list) { installed = sanitizeInstalledApps(list); return installed.length; }
export const installedAppCount = () => installed.length;

const BEFORE = /(?:^|\s)(?:in|on|using|with|via|inside|through|within|into|from|open|launch|start|run|use|switch to|go to)(?:\s+(?:the|my))?$/;
const AFTER = /^(?:\s+(?:la|le|il|ku|kulla|ulla|mein|me|par|se))(?:\s|$)/;
const ACTION = /\b(?:play|pause|stop|resume|search|find|type|write|enter|create|add|make|new|delete|remove|rename|open|close|show|go|select|click|press|set|change|edit|replace|save|export|import|convert|record|mute|unmute|zoom|scroll|switch|draw|render|apply|turn|enable|disable|increase|decrease|start|run|launch|use|read|list|copy|paste|check|look|browse|navigate|maximize|minimize|pannu|pannunga|pannungal|podu|poduga|paaru|paarunga|edu|eduka|kaattu|kaatu|maathu|thodangu|mudi|seiyunga|vai|thirakka|kholo|karo|chalao)\b/;
const NOT_A_TASK = /^(?:how|what|why|who|when|where|which|explain|describe|tell me|is|are|does|do i|should)\b/;
const OUT_OF_SCOPE = /\b(?:install|uninstall|download|upgrade)\b|```|https?:\/\//;

/** {name, goal} when the message is a free-form instruction for exactly one installed application, else null. */
export function freeformDesktopTask(message, apps = installed) {
  const raw = String(message ?? '').trim();
  if (!apps.length || !raw || raw.length > 400) return null;
  const text = normalize(raw);
  if (!text || NOT_A_TASK.test(text) || OUT_OF_SCOPE.test(raw.toLowerCase()) || !ACTION.test(text)) return null;
  const padded = ` ${text} `;
  let best = null;
  const found = new Map(); // app name -> longest matching alias length
  for (const app of apps) for (const alias of app.names) {
    let from = 0, index;
    while ((index = padded.indexOf(` ${alias} `, from)) !== -1) {
      from = index + 1;
      const before = padded.slice(0, index).trim(), after = padded.slice(index + alias.length + 1);
      if (BEFORE.test(before) || AFTER.test(after)) found.set(app.name, Math.max(found.get(app.name) || 0, alias.length));
    }
  }
  for (const [name, length] of found) if (!best || length > best.length) best = { name, length, tie: false }; else if (length === best.length) best.tie = true;
  if (!best || best.tie) return null;
  // A message that is only "open <app>" belongs to the plain launcher.
  const remainder = text.replace(/\b(?:please|can you|could you|would you|open|launch|start|run|the|my|app|application)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (apps.some(a => a.name === best.name && a.names.includes(remainder))) return null;
  return { query: best.name, goal: raw, task: raw, freeform: true };
}
