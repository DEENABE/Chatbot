// Astra-style multi-step application tasks: "open notepad, type hello and save it to E:\notes\hello.txt",
// "notepad open panni 'hi' type panni desktop la todo.txt nu save pannu", "vlc illana install panni open pannu".
//
// A request is split into a small fixed plan for ONE application:
//   open      find the app; when missing: provider discovery -> validated install (human approval) -> verify -> open
//   type      enter the user's exact text (multi-line supported) into the app's text field
//   save_as   save through the app's own Save As dialog to an exact path, verified on disk
//   goal      anything else ("play it", "make it bold") -> the existing grounded desktop loop
//
// Rules handle the common shapes without a model call; the local model (qwen) only plans what the rules cannot read,
// and its plan is checked against the user's own words: typed text and paths must literally appear in the request.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { appLaunchTask } from './AppLaunchTask.js';
import { expandIntents } from './AppIntents.js';

// This module is also loaded by the renderer (computerTask() -> astraTask()), where it only classifies a request. So it has
// no Node-only named imports and no model client: the backend supplies `complete` (see AstraRunner), and everything that
// needs the OS is feature-detected, with inert placeholders when there is none. Admission gives the same answer either way.
const NODE = (() => {
  try {
    return typeof os.homedir === 'function' &&
      typeof fs.existsSync === 'function' &&
      typeof crypto.createHash === 'function' &&
      path.win32
      ? {
          homedir: () => os.homedir(),
          exists: (file) => fs.existsSync(file),
          hash: (...args) => crypto.createHash(...args),
          win32: path.win32,
        }
      : null;
  } catch {
    return null;
  } // a browser build's stand-in for a Node module throws on property access
})();
// Just enough of path.win32 for the shapes used here, for environments without Node. Checked against it in rendererBundle.test.js.
const pureWin32 = {
  normalize(input) {
    const p = String(input).replace(/\//g, '\\'),
      unc = /^\\\\[^\\]+\\[^\\]+/.exec(p),
      drive = !unc && /^[A-Za-z]:/.exec(p);
    const head = unc ? unc[0] : drive ? drive[0] : '',
      rest = p.slice(head.length),
      rooted = rest.startsWith('\\') || !!unc;
    const parts = [];
    for (const part of rest.split('\\')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (parts.length && parts.at(-1) !== '..') parts.pop();
        else if (!rooted) parts.push('..');
        continue;
      }
      parts.push(part);
    }
    const body = parts.join('\\') + (parts.length && /\\$/.test(rest) ? '\\' : '');
    return head + (rooted ? '\\' : '') + body || (head ? '' : '.');
  },
  join(...parts) {
    const joined = parts.filter((part) => String(part)).join('\\');
    return joined ? pureWin32.normalize(joined) : '.';
  },
  basename(input) {
    return String(input)
      .replace(/^[A-Za-z]:/, '')
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1);
  },
  extname(input) {
    const base = pureWin32.basename(input),
      dot = base.lastIndexOf('.');
    return dot <= 0 || base === '..' ? '' : base.slice(dot);
  },
  dirname(input) {
    const p = String(input).replace(/\//g, '\\'),
      head = /^[A-Za-z]:/.exec(p)?.[0] || '',
      after = p.slice(head.length),
      rest = after.replace(/\\+$/, ''),
      cut = rest.lastIndexOf('\\');
    if (cut > 0) return head + rest.slice(0, cut);
    return cut === 0 || (!rest && after.startsWith('\\')) ? head + '\\' : head || '.'; // a root is its own parent
  },
};
export const windowsPathFallback = pureWin32;
const win32 = NODE?.win32 || pureWin32;
const defaultHome = () => (NODE ? NODE.homedir() : 'C:\\Users\\user');
const defaultExists = (file) => (NODE ? NODE.exists(file) : false);

const QUESTION =
  /^(?:how|what|why|who|when|where|which|explain|describe|tell me|is|are|does|do i|should|can i)\b/i;
const SAVE = /\b(?:save|saved|saving|store|export)\b|சேமி/i;
const INSTALL =
  /\b(?:install|download)\b|\b(?:illa(?:na|ana|ati|atti|nna)?|illaina|ilana|not installed|isn'?t installed|if missing|is missing)\b/i;
const UNINSTALL = /\buninstall|remove\s+(?:the\s+)?app\b/i;
const TYPE_WORD = '(?:type|write|enter|paste|ezhuthu|ezhudhu|ezhuthi|adichu|adi)';
const QUOTE = /["“”'‘’`]/;
const BOUNDARY =
  '(?:\\s*[,;.]\\s+|\\s+(?:and\\s+then|and|then|apram|appuram|aprm|piragu|panni(?:tu|ttu)?|pannitu|to|into|in|on|la|le|il|save|and save|then save)\\b|\\s*$)';
const STOP_APPS =
  /^(?:it|this|that|the|a|an|file|text|document|doc|folder|location|path|desktop|documents?|downloads?|pictures|music|videos|my|new|save|type|write|and|then|if|is|not|la|le|il|nu|panni|pannu|e|c|d)$/i;
const NOT_AN_APP =
  /\b(?:pip|npm|yarn|choco|apt|apt-get)\s+install\b|\b(?:install|download)\s+(?:the\s+|this\s+|that\s+|all\s+|windows\s+|pending\s+)?(?:file|files|updates?|drivers?|fonts?|packages?|modules?|librar(?:y|ies)|extensions?|plugins?|it|this|that)\b/i;
const VERB =
  /^(?:pann\w*|seiy\w*|open|launch|start|install|download|illa\w*|ilana|type|save|write|paste|enter|play|nu|endru)$/i;
const COMPOSE =
  /^(?:an?\s+|the\s+|some\s+|short\s+|small\s+|oru\s+)*(?:(?:short|small|simple|formal|funny|nice|brief)\s+)*(?:poem|kavithai|letter|email|e-mail|essay|story|kathai|summary|paragraph|note|notes|list|todo list|to-do list|code|program|script|function|speech|report|application|resume|bio|caption|message|article|blog)\b.*\b(?:about|on|for|to|regarding|pathi|patri|ku)\b/i;
const ACTIONS =
  /\b(?:play|pause|search|find|draw|create|add|make|bold|italic|underline|select|click|insert|replace|format|zoom|record|calculate|run|send|print|copy|rename|delete|open\s+(?:the\s+)?file|load)\b/i;

const clean = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const unquote = (s) => {
  s = String(s ?? '').trim();
  return /^(["“'‘`]).*(["”'’`])$/s.test(s) ? s.slice(1, -1) : s;
};
const DEFAULT_EXT = [
  [/paint/i, '.png'],
  [/wordpad/i, '.rtf'],
  [/\bword\b/i, '.docx'],
  [/excel/i, '.xlsx'],
  [/powerpoint/i, '.pptx'],
  [/code|vs ?code/i, '.txt'],
];
export const defaultExtension = (app) =>
  DEFAULT_EXT.find(([re]) => re.test(app || ''))?.[1] || '.txt';

/** A known user folder (desktop, documents...) on this PC, OneDrive-redirected or not. */
export function knownFolder(word, home = defaultHome(), exists = defaultExists) {
  const name = {
    desktop: 'Desktop',
    document: 'Documents',
    documents: 'Documents',
    download: 'Downloads',
    downloads: 'Downloads',
    pictures: 'Pictures',
    music: 'Music',
    videos: 'Videos',
  }[String(word).toLowerCase()];
  if (!name) return null;
  const local = win32.join(home, name),
    onedrive = win32.join(home, 'OneDrive', name);
  return exists(local) ? local : exists(onedrive) ? onedrive : local;
}

/** Where to save: an explicit Windows path, or a known folder + file name. Folder-only targets get a default file name. */
export function extractSavePath(message, app = '', { now = new Date(), home, exists } = {}) {
  const text = String(message ?? '');
  const m = text.match(
    /"([A-Za-z]:[\\/][^"]+)"|“([A-Za-z]:[\\/][^”]+)”|'([A-Za-z]:[\\/][^']+)'|([A-Za-z]:[\\/][^\s"'<>|?*,;]*)/,
  );
  const named =
    text.match(
      /\b(?:as|named?|called|file\s*name|peyar(?:il)?|per)\s+["“'‘]?([\w\- .()]{1,80}?\.[A-Za-z0-9]{1,6})["”'’]?(?=[\s,;!]|\.?\s*$)/i,
    )?.[1] ||
    text.match(
      /["“'‘]?([\w\-()]{1,80}\.(?:txt|md|csv|json|html?|log|py|js|ts|ini|xml|docx?|rtf|xlsx?|pptx?|png|jpe?g|bmp|gif))["”'’]?(?=[\s,;!]|\.?\s*$)/i,
    )?.[1];
  // "file name sample", "named sample", "save as sample", "sample nu save": a name without an
  // extension used to be dropped, so the save went to a generated chanakya-<date> name.
  let fileName = named;
  if (!fileName) {
    const NOT_A_NAME =
      /^(?:it|this|that|the|a|an|file|text|document|in|on|to|at|into|la|le|il|nu|drive|folder|location|path|here|there|same|new|desktop|documents?|downloads?|pictures|music|videos|[A-Za-z]|and|then|save|saved|pannu|panni)$/i;
    const bare = [
      /\b(?:file\s*-?\s*name|filename|named?|called|peyar(?:il)?)\s*(?:is\s+|as\s+|:\s*|=\s*)?["“'‘]?([\w\-()]{1,80})["”'’]?/i,
      /\bsave\s+(?:it\s+|this\s+|the\s+file\s+)?as\s+["“'‘]?([\w\-()]{1,80})["”'’]?/i,
      /["“'‘]?([\w\-()]{1,80})["”'’]?\s+(?:nu|endru)\s+(?:save|peyar)/i,
    ]
      .map((re) => text.match(re)?.[1])
      .find((name) => name && !NOT_A_NAME.test(name));
    if (bare) fileName = `${bare}${defaultExtension(app)}`;
  }
  let base = null,
    literal = null;
  if (m) {
    literal = (m[1] || m[2] || m[3] || m[4]).replace(/[.)\]]+$/, '').replace(/\//g, '\\');
    base = literal;
  } else {
    // "E drive", "E: drive", "drive E", "D drive la", "in E:" + optional "notes folder" / "folder notes".
    const drive = text.match(
      /\b([C-Zc-z])\s*:?\s*(?:drive|drv)\b|\bdrive\s+([C-Zc-z])\b|(?:^|\s)([C-Zc-z]):(?=\s|$|[,;])/,
    );
    const f = text.match(/\b(desktop|documents?|downloads?|pictures|music|videos)\b/i);
    if (drive && SAVE.test(text)) {
      // "<name> folder" first ("notes folder la"), then "folder <name>"; one word, never a Tamil/English filler.
      const FILLER =
        /^(?:the|this|that|a|new|my|same|any|oru|drive|in|to|la|le|il|nu|and|then|file|save|as|with)$/i;
      const folder = [
        /\b([\w\-]{1,60})\s+(?:folder|directory)\b/i,
        /\b(?:folder|directory)\s+(?:named?\s+|called\s+)?["“'‘]?([\w\-]{1,60})/i,
      ]
        .map((re) => text.match(re)?.[1])
        .find((name) => name && name.length > 1 && !FILLER.test(name));
      const letter = (drive[1] || drive[2] || drive[3]).toUpperCase();
      const sub = folder || '';
      base = `${letter}:\\${sub}`;
    } else if (f && SAVE.test(text)) base = knownFolder(f[1], home, exists);
  }
  if (!base) return null;
  const leaf = win32.basename(base);
  if (!literal || !win32.extname(leaf) || base.endsWith('\\') || /^[A-Za-z]:\\?$/.test(base)) {
    // A folder (or a drive root): add the requested file name, or a dated default one.
    const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    const file = fileName
      ? win32.basename(fileName.replace(/\//g, '\\'))
      : `chanakya-${stamp}${defaultExtension(app)}`;
    return { path: win32.join(base, file), literal };
  }
  return { path: win32.normalize(base), literal };
}

/** The exact text to type: quoted text next to a type/write word, else the words between "type" and the next clause. */
export function extractText(message) {
  const text = String(message ?? '');
  const quotedAfter = text.match(
    new RegExp(
      `\\b${TYPE_WORD}\\s*(?:the\\s+(?:text|words?|line)\\s*)?(?::\\s*)?(["“'‘\`])([\\s\\S]+?)(["”'’\`])`,
      'i',
    ),
  );
  if (quotedAfter) return quotedAfter[2];
  const quotedBefore = text.match(
    new RegExp(`(["“'‘\`])([\\s\\S]+?)(["”'’\`])\\s*(?:nu|endru|ah|a|ai)?\\s*${TYPE_WORD}`, 'i'),
  );
  if (quotedBefore) return quotedBefore[2];
  // Text block after "type:" on its own lines.
  const block = text.match(
    new RegExp(
      `\\b${TYPE_WORD}\\b[^\\n]*:\\s*\\n([\\s\\S]+?)(?:\\n\\s*\\n|\\n(?=\\s*(?:then|and)?\\s*save\\b)|$)`,
      'i',
    ),
  );
  if (block && block[1].trim()) return block[1].replace(/\s+$/, '');
  const after = text.match(
    new RegExp(
      `\\b${TYPE_WORD}\\s+(?!pann|seiy)(?:the\\s+(?:text|words?)\\s+)?(.+?)${BOUNDARY}`,
      'i',
    ),
  );
  if (after && after[1] && !/^(?:this|it|that|something|text)$/i.test(after[1].trim()))
    return after[1].trim();
  // Tanglish: "<text> nu type pannu" / "<text> type panni": the clause just before the verb.
  const verb = text.match(
    new RegExp(`\\s+(?:nu\\s+|endru\\s+)?${TYPE_WORD}\\s+(?:pann|seiy)`, 'i'),
  );
  if (verb) {
    const clause = text
      .slice(0, verb.index)
      .split(/,|;|\bpanni(?:tu|ttu)?\b|\bpannu\b|\bopen\b|\band\b|\bthen\b/i)
      .at(-1)
      .trim();
    if (clause && !QUOTE.test(clause)) return clause;
  }
  return null;
}

/** The application the request is about. Never a path, a folder word or a pronoun. */
export function extractApp(message) {
  const text = String(message ?? '').replace(/"[A-Za-z]:[\\/][^"]*"|[A-Za-z]:[\\/][^\s,;]*/g, ' ');
  const NAME = '([A-Za-z][\\w+.#-]*(?:\\s+[A-Za-z][\\w+.#-]*){0,2}?)';
  const tries = [
    new RegExp(
      `(?:^|[,;.]\\s*)${NAME}\\s+(?:app\\s+)?(?:illa(?:na|ana|nna)?|illaina|ilana|is not installed|isn'?t installed|not installed)\\b`,
      'i',
    ),
    new RegExp(
      `(?:^|[,;.]\\s*|\\band\\s+|\\bthen\\s+)${NAME}\\s+(?:ah?\\s+|ai\\s+|app\\s+)?(?:open|launch|start)\\s+(?:pann|seiy|karo|kar)`,
      'i',
    ),
    new RegExp(
      `\\b(?:open|launch|start|use)\\s+(?!pann|seiy)(?:up\\s+)?(?:the\\s+|my\\s+|a\\s+new\\s+)?${NAME}(?:\\s+app(?:lication)?)?(?=\\s*(?:[,;.]|\\band\\b|\\bthen\\b|\\bpanni|\\bpannitu|\\bif\\b|\\bla\\b|\\bil\\b|\\bto\\b|\\b${TYPE_WORD}\\b|\\bsave\\b|$))`,
      'i',
    ),
    new RegExp(
      `\\b(?:install|download)\\s+(?!pann|seiy)(?:the\\s+)?${NAME}(?:\\s+app)?(?=\\s*(?:[,;.]|\\band\\b|\\bthen\\b|\\bif\\b|\\bpanni|\\bpannitu|$))`,
      'i',
    ),
    new RegExp(
      `\\b(?:in|using|with|inside)\\s+(?:the\\s+|my\\s+)?${NAME}(?:\\s+app)?(?=\\s*(?:[,;.]|\\band\\b|\\bthen\\b|\\bla\\b|$))`,
      'i',
    ),
    new RegExp(`(?:^|[,;.]\\s*)${NAME}\\s+(?:la|le|il|kulla)\\s+`, 'i'),
  ];
  for (const re of tries) {
    const hit = text.match(re)?.[1];
    if (!hit) continue;
    const name = clean(hit.replace(/\b(?:app|application|and|then|please)\b/gi, ' '));
    if (
      name &&
      name.length >= 2 &&
      !STOP_APPS.test(name) &&
      !name.split(' ').every((w) => STOP_APPS.test(w)) &&
      !name.split(' ').some((w) => VERB.test(w))
    )
      return name;
  }
  return null;
}

// A name-only launch can use the same missing-app recovery as a multi-step task. Keep paths, website names,
// Windows configuration targets and incomplete references in their existing flows; they are not install requests.
function plainAppLaunch(message) {
  const launch = appLaunchTask(message);
  if (launch?.tool !== 'app' || launch.action !== 'openApp') return null;
  const app = clean(launch.params.query);
  if (
    app.length < 2 ||
    app.length > 100 ||
    !/^[\p{L}\p{N}][\p{L}\p{N} +.#()_-]*$/u.test(app) ||
    /\b(?:settings?|control panel|device manager|task manager|registry editor|command prompt|powershell|terminal|file explorer|windows explorer|programs and features|apps and features|devices and printers|windows update|windows security|windows features|optional features|performance options|internet options|folder options|power options|system properties|system configuration|services|event viewer|computer management|disk management|regedit|gpedit|msconfig|taskmgr|cmd)\b/i.test(
      app,
    ) ||
    /\b(?:it|this|that|these|those|something|anything|apps?|applications?|programs?|files?|folders?|documents?|directories|directory|paths?|locations?|websites?|webpages?|links?|urls?|browser|desktop|downloads?|pictures|music|videos)\b/i.test(
      app,
    ) ||
    /^(?:wi-?fi|wireless|bluetooth|network|internet|ethernet|vpn|proxy|airplane mode|flight mode|hotspot|mobile hotspot|display|screen|resolution|brightness|night light|sound|audio|volume|speaker|microphone|notifications|power|battery|sleep|storage|disk space|storage sense|multitasking|snap|about|pc info|system info|device specs|devices|privacy|location|personalization|taskbar|firewall|updates?|system|windows|computer|pc|printers?|keyboard|mouse|touchpad)$/i.test(
      app,
    ) ||
    /\b(?:and|then|with|using|in|into|to|as|type|write|paste|enter|save|install|download|play|click|press|select|scroll|open|launch|start|run|pannu|panni|seiyavum|schedule|book|join|call|message|chat|send|compose|reply|create|add|search|find|record|share|post|meeting|meet|la|le|kulla)\b/i.test(
      app,
    ) ||
    /(?:^|\s)(?:[^\s.]+\.)+[a-z]{2,}(?:\s|$)/i.test(app)
  )
    return null;
  return app;
}

/**
 * Admission. Returns null for anything that is not a clear app launch or multi-step application task.
 * {app, steps, install, task, rules:true} when the rules read the whole request; {needsPlanner:true, ...} otherwise.
 */
export function astraTask(message, { now, home, exists } = {}) {
  const raw = String(message ?? '').trim();
  if (
    !raw ||
    raw.length > 4000 ||
    QUESTION.test(raw) ||
    UNINSTALL.test(raw) ||
    /https?:\/\//i.test(raw)
  )
    return null;
  const plainApp = plainAppLaunch(raw);
  if (plainApp)
    return {
      app: plainApp,
      steps: [],
      install: true,
      task: raw,
      rules: true,
      plainOpen: true,
    };
  // Tanglish "teams la meeting schedule pannu", "whatsapp la amma ku hi anuppu": app + goal, installed or not.
  const local = raw.match(
    /^(?:(?:please|pls)\s+)?([\p{L}\p{N}][\p{L}\p{N} +.#-]{1,40}?)\s+(?:la|le|il|kulla|lla)\s+(.{3,400})$/iu,
  );
  if (
    local &&
    !SAVE.test(raw) &&
    /\b(?:pann\w*|podu|vai|anuppu|seiy\w*|create|schedule|send|book|join|call|start|play|search|open)\b/i.test(
      local[2],
    ) &&
    /\b(?:schedule|meeting|meet|call|message|msg|send|anuppu|chat|create|new|book|join|play|search|post)\b/i.test(
      local[2],
    )
  ) {
    const app = clean(local[1].replace(/\b(?:app|application)\b/gi, ' '));
    if (
      app.length >= 2 &&
      !STOP_APPS.test(app) &&
      !app.split(' ').some((w) => VERB.test(w) || STOP_APPS.test(w)) &&
      !/\b(?:settings?|desktop|explorer|folder|file|browser|chrome|edge|firefox|google|youtube|website|windows)\b/i.test(
        app,
      )
    )
      return {
        app,
        steps: [{ op: 'goal', goal: clean(local[2]) }],
        install: true,
        task: raw,
        rules: true,
      };
  }
  const saveTarget = SAVE.test(raw) ? extractSavePath(raw, '', { now, home, exists }) : null;
  const wantsInstall = INSTALL.test(raw);
  const typed = extractText(raw);
  // Admission needs a save destination, an install intent, or multi-line text for an app.
  if (!saveTarget && !wantsInstall && !(typed && /\n/.test(typed))) return null;
  const app = extractApp(raw);
  // "install updates", "pip install x", "download this file": not an application to open.
  if (wantsInstall && !saveTarget && (!app || NOT_AN_APP.test(raw))) return null;
  if (!app && !saveTarget) return null;
  const steps = [];
  // "write a poem about rain", "type a leave letter to my manager": the user wants content written, not those words.
  if (typed && COMPOSE.test(typed)) steps.push({ op: 'compose', about: typed });
  else if (typed) steps.push({ op: 'type', text: typed });
  if (saveTarget) {
    const fixed = extractSavePath(raw, app || '', { now, home, exists });
    steps.push({
      op: 'save_as',
      path: fixed.path,
      overwrite: /\b(?:overwrite|replace)\b/i.test(raw),
    });
  }
  // Whatever is left after removing what the rules understood decides whether the model has to plan the rest.
  let rest = raw;
  if (typed) rest = rest.split(typed).join(' ');
  if (saveTarget?.literal) rest = rest.split(saveTarget.literal).join(' ');
  const leftover = ACTIONS.test(rest.replace(/\bsave\b[^,;]*/gi, ' '));
  // Text to write and save with no application named: Notepad is the plain-text editor every Windows PC has.
  const textOnly =
    !app &&
    saveTarget &&
    steps.length > 1 &&
    steps.every((s) => ['type', 'compose', 'save_as'].includes(s.op));
  const chosen = textOnly && !leftover ? 'notepad' : app;
  if (textOnly && !leftover) {
    const save = steps.find((s) => s.op === 'save_as');
    save.path = extractSavePath(raw, chosen, { now, home, exists }).path;
  }
  const task = { app: chosen, steps, install: true, task: raw };
  if (!chosen || leftover) return { ...task, needsPlanner: true };
  return { ...task, rules: true };
}

const PLANNER_SYSTEM = `You split ONE Windows desktop request into a short plan for ONE application. Reply with JSON only:
{"app":"<application name as the user said it>","steps":[{"op":"type","text":"<exact text to type>"} | {"op":"compose","about":"<what the user wants written, in their words>"} | {"op":"save_as","path":"<full Windows path>","overwrite":false} | {"op":"goal","goal":"<the user's own words for one remaining action>"}]}
Rules:
- The app is opened (and installed through a validated provider if missing) automatically; do NOT add an open or install step.
- "text" must be copied EXACTLY from the request (keep its case and punctuation). Never invent text.
- When the user asks for content to be written FOR them (a poem, letter, email, code, summary about something), use "compose" instead of "type".
- "path" must be copied from the request. If the user names only a folder, append the file name they gave.
- Use "goal" only for actions that are not typing or saving (play, search, draw, format...). Copy the user's words into it, including any values.
- The user may write in English, Tamil-English (Tanglish) or Hindi-English. "pannu/panni" = do, "illana" = if not present, "la" = in.
- At most 6 steps, in the order the user wants them.`;
const EXAMPLES = `Examples:
REQUEST: open notepad and type "Meeting at 5" then save it as E:\\notes\\meet.txt
PLAN: {"app":"notepad","steps":[{"op":"type","text":"Meeting at 5"},{"op":"save_as","path":"E:\\\\notes\\\\meet.txt","overwrite":false}]}
REQUEST: vlc illana install panni E:\\movies\\a.mp4 play pannu
PLAN: {"app":"vlc","steps":[{"op":"goal","goal":"play E:\\\\movies\\\\a.mp4"}]}
REQUEST: install notepad++ and write hello world then save to D:\\x\\h.txt
PLAN: {"app":"notepad++","steps":[{"op":"type","text":"hello world"},{"op":"save_as","path":"D:\\\\x\\\\h.txt","overwrite":false}]}`;

const loose = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
/** Keep only plan steps that are grounded in the request; null when nothing usable remains. */
export function validatePlan(plan, request, { fallback } = {}) {
  if (!plan || typeof plan !== 'object') return null;
  const app = clean(plan.app || fallback?.app || '');
  if (!app || app.length > 60 || /[\\/:*?"<>|`$;&]/.test(app) || STOP_APPS.test(app)) return null;
  const said = loose(request),
    steps = [];
  for (const s of Array.isArray(plan.steps) ? plan.steps.slice(0, 6) : []) {
    if (
      s?.op === 'type' &&
      typeof s.text === 'string' &&
      s.text.trim() &&
      s.text.length <= 4000 &&
      said.includes(loose(s.text))
    )
      steps.push({ op: 'type', text: s.text });
    else if (s?.op === 'save_as' && typeof s.path === 'string') {
      const fixed = fallback?.steps?.find((x) => x.op === 'save_as');
      const p = s.path.replace(/\//g, '\\');
      if (/^[A-Za-z]:\\/.test(p) && said.includes(loose(win32.dirname(p)).slice(0, 3)))
        steps.push({
          op: 'save_as',
          path: said.includes(loose(p)) || !fixed ? p : fixed.path,
          overwrite: s.overwrite === true || /\b(?:overwrite|replace)\b/i.test(request),
        });
      else if (fixed) steps.push(fixed);
    } else if (
      s?.op === 'compose' &&
      typeof s.about === 'string' &&
      s.about.trim() &&
      s.about.length <= 400
    )
      steps.push({ op: 'compose', about: clean(s.about) });
    else if (
      s?.op === 'goal' &&
      typeof s.goal === 'string' &&
      s.goal.trim() &&
      s.goal.length <= 400
    )
      steps.push({ op: 'goal', goal: clean(s.goal) });
  }
  return { app, steps, install: true, task: request };
}

/** Rules first; the local model only for requests the rules could not fully read. A goal that matches a documented app
 * deep link (AppIntents.js) becomes an intent step, so the app opens straight at the pre-filled form. */
export async function planAstraTask(options = {}) {
  return expandIntents(await planAstraSteps(options), { now: options.now || new Date() });
}
async function planAstraSteps({ task, admission = astraTask(task), model, signal, complete } = {}) {
  if (!admission) return { error: 'This is not a multi-step application task.' };
  if (admission.rules)
    return {
      app: admission.app,
      steps: admission.steps,
      install: true,
      task,
      ...(admission.plainOpen === true ? { plainOpen: true } : {}),
    };
  let planned = null;
  try {
    if (typeof complete !== 'function') throw new Error('No model client is configured.');
    const answer = await complete({
      system: PLANNER_SYSTEM,
      prompt: `${EXAMPLES}\n\nREQUEST: ${task}\nPLAN:`,
      model,
      signal,
      think: false,
      temperature: 0,
    });
    planned = validatePlan(answer, task, { fallback: admission });
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  if (planned && (planned.steps.length || admission.steps.length === 0)) return planned;
  // The model was unavailable or ungrounded: run what the rules understood, and hand the rest to the desktop loop.
  if (admission.app)
    return {
      app: admission.app,
      steps: [...admission.steps, ...(ACTIONS.test(task) ? [{ op: 'goal', goal: task }] : [])],
      install: true,
      task,
    };
  return {
    error:
      'I could not tell which application to use. Please name it, e.g. "open Notepad, type hello, save to E:\\notes\\a.txt".',
  };
}

export const planKey = (...parts) =>
  (
    NODE?.hash ||
    (() => {
      throw new Error('planKey needs Node.');
    })
  )('sha256')
    .update(parts.map(String).join('\u0000'))
    .digest('hex')
    .slice(0, 32);

/** Write the content for a compose step with the local model. Plain text only; the user sees it typed into their app. */
export async function composeText({ about, app, task, model, signal, complete }) {
  if (typeof complete !== 'function')
    throw new Error('No model client is configured to write this content.');
  const answer = await complete({
    system:
      'You write content that will be typed into a Windows application for the user. Reply with JSON {"text":"..."} only. Plain text, no markdown fences, use \\n for new lines, at most 3000 characters. Write in the language the user used.',
    prompt: `Application: ${app}\nFull user request: ${task}\nWrite: ${about}`,
    model,
    signal,
    think: false,
    temperature: 0.4,
  });
  const text =
    typeof answer?.text === 'string'
      ? answer.text
          .replace(/^```\w*\n?|```$/g, '')
          .trim()
          .slice(0, 3000)
      : '';
  if (!text) throw new Error('The local model returned no text to write.');
  return text;
}
