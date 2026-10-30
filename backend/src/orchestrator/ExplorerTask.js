/**
 * Drives and folders: "open D drive", "list drives", "open desktop", "documents folder
 * open pannu", "open D: drive then list out the folders size".
 *
 * These used to fall through to application-name matching ("No confident match was
 * found among the available application sources"). They are parsed here by rules and
 * executed with the explorer tool service step by step; a local model is never asked
 * to invent paths. Reading inside a drive/folder needs the user's read-only approval
 * (explorer.approveRoot), opening a window does not.
 */

const KNOWN = {
  desktop: 'desktop',
  document: 'documents',
  documents: 'documents',
  docs: 'documents',
  download: 'downloads',
  downloads: 'downloads',
  picture: 'pictures',
  pictures: 'pictures',
  photos: 'pictures',
  music: 'music',
  video: 'videos',
  videos: 'videos',
};
const LABEL = {
  desktop: 'Desktop',
  documents: 'Documents',
  downloads: 'Downloads',
  pictures: 'Pictures',
  music: 'Music',
  videos: 'Videos',
  thisPC: 'This PC',
};

const OPEN =
  /\b(?:open|opens|opening|go\s*to|goto|navigate|browse|launch|take\s+me|explore)\b|\bopen\s*(?:pannu|panni|pannunga|karo)\b/i;
const LIST =
  /\b(?:list|lists|listing|contents?|what(?:'s|s|\s+is|\s+are)?\s+(?:in|inside)|inside|show\s+(?:me\s+)?(?:the\s+|all\s+)?(?:folders|files|items|contents?))\b|\blist\s*out\b|\b(?:folders|files)\s+(?:list|kaatu|show)\b/i;
const SIZES =
  /\b(?:sizes?|space\s+(?:used|taken|usage)|largest|biggest|heaviest|how\s+(?:big|large|much\s+space))\b/i;
const DRIVES =
  /\b(?:list|show|display|get|check|all|available|my|how\s+many)\b[^.?!]{0,30}\bdrives\b|\bdrives?\s+(?:list|lists|details|info|space)\b|\blist\s+(?:out\s+)?(?:the\s+)?drives?\b|\bdrives?\s+(?:kaatu|show)\b/i;
// Work that belongs to other agents (Astra save/type, software, file agent, coding).
const OTHER =
  /\b(?:save|type|write|notepad|install|uninstall|copy|move|delete|remove|rename|organi[sz]e|sort\s+out|create|make|zip|unzip|extract|compress|format|code|website|app\s+in)\b|\bdownload\s+(?!folder)/i;
const QUESTION = /^(?:explain|what\s+is\s+(?:a|an|the)\b|how\s+(?:do|can|to)\b|why\b|define\b)/i;
const FILE_EXT = /\.[a-z0-9]{1,5}(?:["'\s]|$)/i;

/** Every drive/folder named in the request, in order. */
function locations(text) {
  const found = [];
  const add = (item) => {
    if (!found.some((x) => x.key === item.key)) found.push(item);
  };
  const explicit =
    /\b([C-Zc-z]:\\[^"'<>|?*\r\n]*?)(?=\s+(?:and|then|folder|la|le|il)\b|[,;"']|\s*$)/g;
  for (const match of text.matchAll(explicit)) {
    const raw = match[1].replace(/[\\/]+$/, '').replace(/^[a-z]/, (c) => c.toUpperCase());
    const value = raw.length === 2 ? `${raw}\\` : raw;
    add({ kind: 'path', path: value, key: value.toLowerCase(), label: value });
  }
  const drive =
    /\b([C-Zc-z])\s*:?\s*(?:drive|drv)\b|\bdrive\s+([C-Zc-z])\b(?!\s*:?\s*drive)|(?:^|\s)([C-Zc-z]):(?=[\s,;.]|$)/g;
  for (const match of text.matchAll(drive)) {
    const letter = (match[1] || match[2] || match[3]).toUpperCase();
    const value = `${letter}:\\`;
    add({ kind: 'path', path: value, key: value.toLowerCase(), label: `${letter}: drive` });
  }
  for (const match of text.matchAll(
    /\b(desktop|documents?|docs|downloads?|pictures?|photos|music|videos?)\b/gi,
  )) {
    const location = KNOWN[match[1].toLowerCase()];
    add({ kind: 'known', location, key: location, label: LABEL[location] });
  }
  if (/\b(?:this\s*pc|my\s*computer|my\s*pc)\b/i.test(text))
    add({ kind: 'thisPC', location: 'thisPC', key: 'thispc', label: 'This PC' });
  return found.slice(0, 4);
}

/** Admission: null when the request is not about drives/folders. */
export function explorerTask(message) {
  const text = String(message || '').trim();
  if (!text || text.length > 300 || QUESTION.test(text) || OTHER.test(text)) return null;
  // "open D:\notes.txt" or "open report.pdf" is a file for an application, not a folder.
  const withoutDrives = text.replace(/\b[C-Zc-z]:\\?(?=\s|$)/g, '');
  if (FILE_EXT.test(withoutDrives) && !/\bfolder\b/i.test(text)) return null;
  // "... in VLC / with Notepad": the user named another application.
  if (
    /\b(?:in|with|using)\s+(?!(?:my|the|this|that|it|your|all|a|file\s+explorer|windows\s+explorer|explorer|folders?|drives?|desktop|documents?|docs|downloads?|pictures?|photos|music|videos?)\b|[C-Zc-z]\b|[C-Zc-z]:)[a-z]/i.test(
      text,
    )
  )
    return null;
  const where = locations(text);
  const drives = DRIVES.test(text) && !where.some((item) => item.kind === 'path');
  if (!where.length && !drives) return null;
  let open = OPEN.test(text);
  const sizes = SIZES.test(text) && where.length > 0;
  const list = (LIST.test(text) || sizes) && where.length > 0;
  // "D drive" / "desktop folder" with no other verb: show it.
  if (where.length && !open && !list && !drives) {
    if (!/\b(?:folder|drive|explorer)\b/i.test(text)) return null;
    open = true;
  }
  if (where.length > 1 && (list || sizes))
    // One listing at a time keeps the answer readable and approvals clear.
    return { locations: where.slice(0, 1), open, list, sizes, drives };
  return { locations: where, open, list, sizes, drives };
}

const success = (event) => event?.success === true;
const named = (events, action) => events.filter((e) => e.toolName === `explorer_${action}`);
const found = (events, action, test) =>
  named(events, action).findLast((e) => success(e) && test(e.data || {}));

function driveLines(data) {
  const drives = Array.isArray(data?.drives) ? data.drives : [];
  if (!drives.length) return 'No drives were reported by Windows.';
  return [
    `**Drives on this PC (${drives.length}):**`,
    ...drives.map((d) => {
      const name = d.letter ? `${d.letter}:` : d.root;
      const label = d.label ? ` (${d.label})` : '';
      const space =
        d.free && d.total ? ` — ${d.free} free of ${d.total}` : d.total ? ` — ${d.total}` : '';
      const extra = [d.type, d.fileSystem].filter(Boolean).join(', ');
      const state = d.accessible === false ? ' — not accessible' : '';
      return `- ${name}${label}${space}${extra ? ` · ${extra}` : ''}${state}`;
    }),
  ].join('\n');
}

function listingLines(label, listing, sizes) {
  const entries = Array.isArray(listing?.entries) ? listing.entries : [];
  const bySize = new Map(
    (sizes?.largestChildren || []).map((child) => [String(child.name).toLowerCase(), child]),
  );
  const folders = entries.filter((e) => e.type === 'directory');
  const files = entries.filter((e) => e.type === 'file');
  if (sizes)
    folders.sort(
      (a, b) =>
        (bySize.get(b.name.toLowerCase())?.bytes || 0) -
        (bySize.get(a.name.toLowerCase())?.bytes || 0),
    );
  const counts = listing?.counts || {};
  const lines = [
    `**${label}** — ${counts.directories ?? folders.length} folder${(counts.directories ?? folders.length) === 1 ? '' : 's'}, ${counts.files ?? files.length} file${(counts.files ?? files.length) === 1 ? '' : 's'}${sizes?.total ? `, ${sizes.total} in total` : ''}`,
  ];
  const show = (items, render, limit) => {
    for (const item of items.slice(0, limit)) lines.push(render(item));
    if (items.length > limit) lines.push(`- …and ${items.length - limit} more`);
  };
  if (folders.length) {
    lines.push('', '**Folders:**');
    show(
      folders,
      (f) => {
        const size = bySize.get(f.name.toLowerCase())?.size;
        return `- ${f.name}${f.protected ? ' (system, not scanned)' : size ? ` — ${size}` : ''}`;
      },
      60,
    );
  }
  if (files.length) {
    lines.push('', '**Files:**');
    show(files, (f) => `- ${f.name}${f.size ? ` — ${f.size}` : ''}`, 40);
  }
  if (!folders.length && !files.length) lines.push('', 'This folder is empty.');
  if (listing?.nextOffset)
    lines.push('', `Showing the first ${listing.returned} of ${listing.total} items.`);
  if (sizes && sizes.complete === false)
    lines.push(
      '',
      `Sizes are partial: the scan stopped (${sizes.stoppedBy || 'limit'}) after ${sizes.files} files. Ask for one folder at a time for exact sizes.`,
    );
  if (sizes?.skipped?.length)
    lines.push('', `${sizes.skipped.length} item(s) could not be read (no permission).`);
  return lines.join('\n');
}

/** The next step the request needs, judged only from successful results. */
function plan(admission, events) {
  const parts = [];
  if (admission.drives) {
    const listed = found(events, 'listDrives', () => true);
    if (!listed) return { next: { action: 'listDrives', params: {}, label: 'the drive list' } };
    parts.push(driveLines(listed.data));
  }
  for (const item of admission.locations || []) {
    let path = item.kind === 'path' ? item.path : null;
    if (item.kind === 'known' && (admission.list || admission.sizes)) {
      // Ask Windows where the folder really is (OneDrive redirection etc.).
      const resolved = found(events, 'resolveLocation', (d) => d.location === item.location);
      if (!resolved)
        return {
          next: {
            action: 'resolveLocation',
            params: { location: item.location },
            label: item.label,
          },
        };
      path = resolved.data.path;
    }
    if (admission.open) {
      const opened = found(events, 'openLocation', (d) =>
        item.kind === 'path' ? d.path === item.path : d.location === item.location,
      );
      if (!opened)
        return {
          next: {
            action: 'openLocation',
            params: item.kind === 'path' ? { path: item.path } : { location: item.location },
            label: item.label,
          },
        };
      parts.push(opened.data.message || `Opened ${item.label} in File Explorer.`);
    }
    if (!path) continue;
    const title = item.kind === 'path' && item.label === path ? path : `${item.label} (${path})`;
    let listing = null;
    let sizes = null;
    if (admission.list) {
      listing = found(events, 'listDirectory', (d) => d.path === path);
      if (!listing)
        return {
          next: {
            action: 'listDirectory',
            params: { path, limit: 200, sortBy: 'name', order: 'asc' },
            label: title,
            root: path,
          },
        };
    }
    if (admission.sizes) {
      sizes = found(events, 'calculateFolderSize', (d) => d.path === path);
      if (!sizes)
        return {
          next: {
            action: 'calculateFolderSize',
            params: { path, breakdown: true, deadlineSeconds: 120 },
            label: title,
            root: path,
          },
        };
    }
    if (listing || sizes) parts.push(listingLines(title, listing?.data, sizes?.data));
  }
  return { parts };
}

/**
 * Next explorer step from the tool evidence of this request, or the final answer.
 * Deterministic and bounded; it only ever sends paths taken from the user's words or
 * returned by explorer.resolveLocation.
 */
export function nextExplorerDecision({ admission, evidence = [] } = {}) {
  if (!admission)
    return { success: false, message: 'This request has no drive or folder to open.' };
  const events = evidence.filter((event) => /^explorer_/.test(event?.toolName || ''));
  if (events.length > 14)
    return { success: false, message: 'The File Explorer request reached its step limit.' };
  const last = events.at(-1);
  if (last?.needsConfirmation)
    return {
      waiting: true,
      message: last.confirmationMessage || 'Allow read-only access to this location to continue.',
    };
  if (last?.toolName === 'explorer_approveRoot' && success(last) && last.data?.approved !== true)
    return { success: false, message: 'Access was not approved, so nothing inside it was read.' };
  const { next, parts } = plan(admission, events);
  if (!next) return { success: true, message: parts.join('\n\n') || 'Done.' };
  if (last && !success(last)) {
    // The step we are on failed. Reading a drive/folder the user has not approved yet:
    // ask once (read-only), then retry the same step.
    const code = last.error?.code || last.data?.code;
    if (
      code === 'ROOT_NOT_APPROVED' &&
      next.root &&
      last.toolName === `explorer_${next.action}` &&
      !found(events, 'approveRoot', (d) => d.root === next.root) &&
      !named(events, 'approveRoot').some((e) => !success(e))
    )
      return {
        call: { tool: 'explorer', action: 'approveRoot', params: { path: next.root, hours: 8 } },
        status: `Asking to read ${next.root} (read-only)`,
      };
    return {
      success: false,
      message:
        last.error?.message ||
        last.data?.message ||
        'The File Explorer action failed. Nothing was changed.',
    };
  }
  return {
    call: { tool: 'explorer', action: next.action, params: next.params },
    status: `${next.action === 'openLocation' ? 'Opening' : 'Reading'} ${next.label}`,
  };
}
