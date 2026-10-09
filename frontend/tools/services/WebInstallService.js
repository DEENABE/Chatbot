import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BaseToolService } from '../BaseToolService.js';
import { inspectInstaller } from '../software/InstallerMetadata.js';
import { runValidatedInstaller } from '../software/InstallerExecutor.js';
import { normalizePublisher, sameVersion } from '../software/TrustPolicy.js';
import { checkCancellation, executionContext } from '../ExecutionContext.js';

/**
 * Legacy discovery and signed native-picker compatibility. Online execution requires the typed software provider pipeline.
 *
 *   webInstall.find      READ        web search + the installer links on the result pages (nothing is downloaded)
 *   webInstall.download  SAFE_WRITE  download one found installer into a private quarantine folder and VERIFY it. The file is
 *                                    never executed here.
 *   webInstall.install   DANGEROUS   run a verified installer. The human sees the host, the publisher the file is signed by,
 *                                    its size and SHA-256 BEFORE anything runs.
 *
 * The model never supplies a URL or a command: it can only hand back ids this service issued. Discovery does not establish trust. Every hop of every request
 * is https to a public host; the file must carry a valid Authenticode signature AND identify itself as the requested
 * application; it is hashed again right before it is started; no shell, no elevation tricks (the installer asks for UAC
 * itself, as it would for the user).
 */
const QUERY_PATTERN = '^[^\\x00-\\x1f"\'`$;&|<>^%*?\\[\\]{}\\\\!]{1,100}$';
const ID_PATTERN = '^[a-f0-9]{16}$';
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const MAX_INSTALLER_BYTES = 800 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const failure = (code, message = code) => Object.assign(new Error(message), { code });

// Download aggregators and bundlers: never an official source.
const UNOFFICIAL_HOST =
  /(?:softonic|cnet|download\.com|filehippo|uptodown|malavida|majorgeeks|softpedia|filepuma|brothersoft|snapfiles|getintopc|apkpure|chip\.de|techspot|sourceforge|fosshub|crack|keygen|torrent|warez|mediafire|mega\.nz|drive\.google|dropbox|github\.io)/i;
const STOP = new Set([
  'app',
  'the',
  'for',
  'windows',
  'download',
  'installer',
  'install',
  'free',
  'software',
  'official',
  'application',
  'setup',
]);

export const appTokens = (name) =>
  String(name || '')
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((t) => t && !STOP.has(t));

/** Every app token appears (as a word or word prefix) in the text an installer says about itself. */
export function identityMatches(app, text) {
  const want = appTokens(app);
  if (!want.length) return false;
  const have = String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter(Boolean);
  return want.every((w) => have.some((h) => h === w || h.startsWith(w)));
}

/** The vendor's own domain usually carries the product or company name. Only used to rank candidates. */
export function hostLooksOfficial(host, app) {
  const labels = String(host).toLowerCase().split('.').slice(0, -1).join('');
  return appTokens(app).some((t) => t.length >= 3 && labels.includes(t));
}

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^0\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^192\.0\.0\./,
  /^198\.1[89]\./,
  /^2(2[4-9]|[3-5]\d)\./,
];
const privateAddress = (address) => {
  const a = String(address).toLowerCase();
  if (net.isIPv4(a)) return PRIVATE_V4.some((r) => r.test(a));
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return PRIVATE_V4.some((r) => r.test(mapped[1]));
  return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || a.startsWith('ff');
};

/** https, default port, a real public DNS name that is not a download aggregator. Throws UNSAFE_URL. */
export async function assertPublicUrl(raw, resolve = dns.lookup) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw failure('UNSAFE_URL', 'That is not a valid web address.');
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    (url.port && url.port !== '443') ||
    url.username ||
    url.password ||
    net.isIP(host) ||
    !host.includes('.') ||
    /\.(local|internal|lan|home|localdomain|onion)$/.test(host) ||
    UNOFFICIAL_HOST.test(host)
  )
    throw failure(
      'UNSAFE_URL',
      `${host || 'That address'} is not an acceptable source for an installer.`,
    );
  const records = await resolve(host, { all: true }).catch(() => []);
  if (!records.length || records.some((r) => privateAddress(r.address ?? r)))
    throw failure('UNSAFE_URL', `${host} does not resolve to a public internet address.`);
  return url;
}

/** Result links of DuckDuckGo's HTML endpoint. Pure, so it is unit-testable. */
export function parseSearchResults(html) {
  const out = [];
  for (const m of String(html).matchAll(/href="([^"]+)"/g)) {
    let href = m[1].replace(/&amp;/g, '&');
    try {
      if (href.startsWith('//')) href = `https:${href}`;
      const u = new URL(href);
      if (/duckduckgo\.com$/.test(u.hostname) && u.searchParams.get('uddg'))
        href = u.searchParams.get('uddg');
      else if (/duckduckgo\.com$/.test(u.hostname)) continue;
      if (/^https:\/\//i.test(href) && !out.includes(href)) out.push(href);
    } catch {
      /* not a link */
    }
  }
  return out;
}

/** Direct installer links (.exe/.msi) on a page, best Windows 64-bit candidates first. Pure. */
export function installerLinks(html, base) {
  const found = new Map();
  for (const m of String(html).matchAll(/(?:href|data-href|data-url)=["']([^"']+)["']/gi)) {
    let url;
    try {
      url = new URL(m[1].replace(/&amp;/g, '&'), base);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || !/\.(exe|msi)$/i.test(url.pathname)) continue;
    const text = decodeURIComponent(url.pathname).toLowerCase();
    let score = 0;
    if (/x64|amd64|64-?bit|win64/.test(text)) score += 2;
    if (/win|windows/.test(text)) score += 1;
    if (/setup|install/.test(text)) score += 1;
    // Other platforms, portable builds, pre-releases and uninstallers are never what "install this app" means.
    if (
      /(?:^|[^a-z])(?:arm\d*|aarch64|mac|macos|osx|linux|portable|source|src|debug|beta|nightly|uninstall)(?:[^a-z]|$)/.test(
        text,
      )
    )
      continue;
    if (!found.has(url.href)) found.set(url.href, score);
  }
  return [...found].sort((a, b) => b[1] - a[1]).map(([url]) => url);
}

/** Authenticode status plus the file's own product/company metadata. The path travels in the environment, never in code. */
export async function verifySignature(file) {
  const metadata = await inspectInstaller(file);
  return {
    ...metadata,
    signer: metadata.signerSubject,
    product: metadata.productName,
    company: metadata.manufacturer,
    version: metadata.productVersion,
  };
}

/** Run through a fixed native Windows launch protocol with normal UAC. */
export function runInstaller(file, metadata = {}) {
  return runValidatedInstaller({
    installer: { path: file, format: path.extname(file).slice(1).toLowerCase() },
    privileges:
      metadata.privileges ||
      (['requireAdministrator', 'administrator'].includes(metadata.elevation)
        ? 'administrator'
        : 'unknown'),
  });
}

async function readLimited(response, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    size += chunk.length;
    if (size > limit) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/octet-stream;q=0.9,*/*;q=0.5',
};

/** GET with manual redirects: every hop is validated before it is requested. */
async function fetchValidated(url, { resolve, timeout = 20_000 } = {}) {
  let current = await assertPublicUrl(url, resolve);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    checkCancellation();
    const response = await fetch(current, {
      redirect: 'manual',
      headers: HEADERS,
      signal: AbortSignal.any([
        ...(executionContext.getStore()?.signal ? [executionContext.getStore().signal] : []),
        AbortSignal.timeout(timeout),
      ]),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get('location');
      if (!next) throw failure('DOWNLOAD_FAILED', 'Redirect without a target.');
      current = await assertPublicUrl(new URL(next, current).href, resolve);
      continue;
    }
    return { response, url: current };
  }
  throw failure('DOWNLOAD_FAILED', 'Too many redirects.');
}

export async function fetchText(url, options) {
  const { response, url: finalUrl } = await fetchValidated(url, options);
  if (!response.ok) throw failure('DOWNLOAD_FAILED', `HTTP ${response.status}`);
  return {
    text: await readLimited(response, MAX_PAGE_BYTES),
    url: finalUrl.href,
  };
}

export async function webSearch(query, options) {
  const { text } = await fetchText(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    options,
  );
  return parseSearchResults(text);
}

/** Streams a validated URL into `directory`; size-capped, hashed while it is written. */
export async function downloadInstaller(url, directory, options = {}) {
  const { response, url: finalUrl } = await fetchValidated(url, {
    ...options,
    timeout: 15 * 60_000,
  });
  if (!response.ok) throw failure('DOWNLOAD_FAILED', `HTTP ${response.status}`);
  const type = response.headers.get('content-type') || '';
  if (/text\/html/i.test(type))
    throw failure('NOT_AN_INSTALLER', 'The link returned a web page, not an installer.');
  const announced = Number(response.headers.get('content-length'));
  if (announced > MAX_INSTALLER_BYTES)
    throw failure('DOWNLOAD_TOO_LARGE', 'The installer is larger than the 800 MB limit.');
  const base = path
    .basename(decodeURIComponent(finalUrl.pathname))
    .replace(/[^A-Za-z0-9._ +-]/g, '_');
  if (!/\.(exe|msi)$/i.test(base))
    throw failure('UNSUPPORTED_INSTALLER', 'Only .exe and .msi installers are supported.');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, base);
  const hash = crypto.createHash('sha256');
  let size = 0;
  const source = Readable.fromWeb(response.body);
  source.on('data', (chunk) => {
    size += chunk.length;
    hash.update(chunk);
    if (size > MAX_INSTALLER_BYTES) source.destroy(failure('DOWNLOAD_TOO_LARGE'));
  });
  try {
    await pipeline(source, fs.createWriteStream(file, { flags: 'wx' }));
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    file,
    size,
    sha256: hash.digest('hex'),
    host: finalUrl.hostname,
    fileName: base,
  };
}

export async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

const MAGIC = {
  exe: Buffer.from([0x4d, 0x5a]),
  msi: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]),
};
export function hasInstallerHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    const kind = /\.msi$/i.test(file) ? MAGIC.msi : MAGIC.exe;
    return head.subarray(0, kind.length).equals(kind);
  } finally {
    fs.closeSync(fd);
  }
}

const signerName = (subject) =>
  String(subject || '')
    .match(/(?:^|,\s*)O=("?)([^,"]+)\1/)?.[2]
    ?.trim() ||
  String(subject || '')
    .match(/(?:^|,\s*)CN=("?)([^,"]+)\1/)?.[2]
    ?.trim() ||
  '';

export class WebInstallService extends BaseToolService {
  /**
   * @param gate ConfirmationGate
   * @param options  appService (registry refresh + resolver), and injectable seams for tests:
   *   search(query) -> urls, fetchPage(url) -> {text,url}, download(url,dir) -> {file,size,sha256,host,fileName},
   *   verify(file) -> signature info, run(file) -> {code,timedOut}, resolve (dns), sleep, root (quarantine folder)
   */
  constructor(gate, options = {}) {
    super('webInstall', gate);
    this.appService = options.appService;
    this.search = options.search || ((q) => webSearch(q, { resolve: options.resolve }));
    this.fetchPage = options.fetchPage || ((u) => fetchText(u, { resolve: options.resolve }));
    this.download =
      options.download || ((u, d) => downloadInstaller(u, d, { resolve: options.resolve }));
    this.verify = options.verify || verifySignature;
    this.run = options.run || runInstaller;
    this.resolve = options.resolve || dns.lookup;
    this.sleep = options.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.waits = options.waits ?? [0, 5000, 10000, 15000, 20000];
    this.root =
      options.root ||
      path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
        'Chanakya',
        'installer-quarantine',
      );
    this.candidates = new Map();
    this.downloads = new Map();
  }

  get actions() {
    return {
      find: {
        schema: {
          query: {
            type: 'string',
            required: true,
            minLength: 1,
            maxLength: 100,
            pattern: QUERY_PATTERN,
          },
        },
        destructive: true,
        handler: (p) => this.find(p),
        description:
          'Discover unverified software links. Search results cannot authorize downloads; use approved software providers or the native offline picker.',
      },
      download: {
        schema: {
          candidateId: { type: 'string', required: true, pattern: ID_PATTERN },
        },
        destructive: true,
        handler: (p) => this.downloadCandidate(p),
        description:
          'Download one installer returned by webInstall.find into a private quarantine folder and verify its signature and identity. The file is not run.',
      },
      install: {
        schema: {
          downloadId: { type: 'string', required: true, pattern: ID_PATTERN },
        },
        destructive: true,
        handler: (p) => this.install(p),
        description:
          'Run an installer that webInstall.download verified. Requires explicit human confirmation showing the website, publisher and SHA-256.',
      },
    };
  }

  prune() {
    const old = Date.now() - 60 * 60_000;
    for (const [id, c] of this.candidates) if (c.at < old) this.candidates.delete(id);
    for (const [id, d] of this.downloads)
      if (d.at < old) {
        this.downloads.delete(id);
        fs.rmSync(path.dirname(d.file), { recursive: true, force: true });
      }
  }

  /** An id this service never issued is refused BEFORE a human is asked anything. */
  async execute(action, params = {}) {
    if (
      action === 'install' &&
      typeof params.downloadId === 'string' &&
      new RegExp(ID_PATTERN).test(params.downloadId) &&
      !this.downloads.has(params.downloadId)
    )
      throw failure(
        'DOWNLOAD_NOT_FOUND',
        'That installer was not verified by webInstall.download.',
      );
    return super.execute(action, params);
  }

  async find({ query }) {
    checkCancellation();
    this.prune();
    let urls;
    try {
      urls = await this.search(`${query} official download Windows installer`);
    } catch (error) {
      if (error.name === 'AbortError' && !error.code) throw error;
      return {
        success: false,
        status: 'WEB_UNAVAILABLE',
        message: 'The web search could not be reached.',
      };
    }
    const pages = [];
    for (const raw of urls) {
      try {
        const url = await assertPublicUrl(raw, this.resolve);
        pages.push(url);
      } catch {
        /* aggregator, private or non-https result */
      }
      if (pages.length >= 8) break;
    }
    pages.sort(
      (a, b) =>
        Number(hostLooksOfficial(b.hostname, query)) - Number(hostLooksOfficial(a.hostname, query)),
    );
    const found = [];
    for (const page of pages.slice(0, 4)) {
      checkCancellation();
      const links = /\.(exe|msi)$/i.test(page.pathname)
        ? [page.href]
        : await this.fetchPage(page.href).then(
            (r) => installerLinks(r.text, r.url),
            () => [],
          );
      for (const link of links.slice(0, 2)) {
        if (found.some((f) => f.url === link)) continue;
        try {
          await assertPublicUrl(link, this.resolve);
        } catch {
          continue;
        }
        const host = new URL(link).hostname;
        found.push({
          url: link,
          host,
          pageHost: page.hostname,
          official: hostLooksOfficial(host, query) || hostLooksOfficial(page.hostname, query),
          fileName: decodeURIComponent(path.basename(new URL(link).pathname)),
        });
      }
      if (found.length >= 3) break;
    }
    found.sort((a, b) => Number(b.official) - Number(a.official));
    const results = found.slice(0, 3).map((c) => {
      const candidateId = crypto.randomBytes(8).toString('hex');
      this.candidates.set(candidateId, {
        ...c,
        query,
        owner: executionContext.getStore()?.scope,
        at: Date.now(),
      });
      return {
        candidateId,
        host: c.host,
        pageHost: c.pageHost,
        fileName: c.fileName,
        official: false,
        discoveryOnly: true,
      };
    });
    return {
      success: true,
      status: results.length ? 'INSTALLERS_FOUND' : 'NO_INSTALLER_FOUND',
      query,
      results,
      message: results.length
        ? `Found ${results.length} unverified discovery link(s). Register an approved source before downloading; nothing was downloaded.`
        : 'No direct installer link was found on the web pages for this application.',
    };
  }

  async downloadCandidate({ candidateId }) {
    checkCancellation();
    const candidate = this.candidates.get(candidateId);
    if (!candidate || candidate.owner !== executionContext.getStore()?.scope)
      throw failure('CANDIDATE_NOT_FOUND', 'That installer was not returned by webInstall.find.');
    // A search result and a matching hostname are discovery clues, not approved publisher distribution evidence.
    throw failure(
      'SOURCE_NOT_APPROVED',
      'Web search cannot authorize an executable source. Register a verified source in Software sources, or choose a signed local installer.',
    );
  }

  getConfirmationMessage(action, params) {
    if (action === 'find')
      return `Connect to the internet to find installation sources for “${params.query}”? Offline mode stays in effect until you approve this lookup. No installer will be downloaded or run.`;
    if (action === 'download') {
      const c = this.candidates.get(params.candidateId);
      return c
        ? `Download “${c.fileName}” from ${c.host} for “${c.query}” and check its identity and digital signature? This requires internet access. The installer will not run without a separate approval.`
        : 'Approve an internet download only after selecting a verified installation candidate.';
    }
    const d = this.downloads.get(String(params.downloadId));
    if (!d) return 'Run a downloaded installer?';
    if (d.source === 'offline')
      return `Install “${d.product}” from the offline file you selected (${d.fileName}, ${(d.size / 1048576).toFixed(1)} MB), digitally signed by ${d.publisher}, SHA-256 ${d.sha256}? This changes installed software and may show the installer's window and Windows administrator prompt. No download is required.`;
    return `Run the installer for “${d.product}”? Downloaded from ${d.host} (${d.fileName}, ${(d.size / 1048576).toFixed(1)} MB), digitally signed by ${d.publisher}, SHA-256 ${d.sha256}. The installer opens its own window and may show a Windows administrator (UAC) prompt, and it changes the software installed on this PC.`;
  }

  async install({ downloadId }) {
    checkCancellation();
    const d = this.downloads.get(downloadId);
    if (!d || d.owner !== executionContext.getStore()?.scope)
      throw failure(
        'DOWNLOAD_NOT_FOUND',
        'That installer was not verified by webInstall.download.',
      );
    // The file sat on disk while a human decided: prove it is still the exact verified file before starting it.
    if ((await hashFile(d.file)) !== d.sha256)
      throw failure(
        'INSTALLER_CHANGED',
        'The downloaded file changed after it was verified, so I did not run it.',
      );
    const sig = await this.verify(d.file);
    if (sig?.status !== 'Valid')
      throw failure(
        'UNSIGNED_INSTALLER',
        "The installer's signature is no longer valid, so I did not run it.",
      );
    const started = Date.now();
    if (
      normalizePublisher(signerName(sig.signer)) !== normalizePublisher(d.publisher) ||
      (d.version && !sameVersion(sig.version, d.version))
    )
      throw failure(
        'INSTALLER_CHANGED',
        "The installer's publisher or version changed after approval.",
      );
    const r = await this.run(d.file, sig);
    this.downloads.delete(downloadId);
    const reboot = [3010, 1641].includes(r.code);
    const cancelled = [1223, 1602].includes(r.code);
    const ok = !r.timedOut && !r.uncertain && !cancelled && (r.code === 0 || reboot);
    let appDetected = false;
    if (ok) {
      for (const wait of this.waits) {
        if (wait) await this.sleep(wait);
        try {
          await this.appService?.registry?.refresh?.();
          const registry = this.appService?.registry;
          const normalizeName = (value) =>
            String(value || '')
              .toLowerCase()
              .replace(/[^\p{L}\p{N}]/gu, '');
          const hit = (registry?.apps || []).find(
            (app) =>
              app.available !== false &&
              normalizeName(app.productName || app.name) === normalizeName(d.product) &&
              normalizePublisher(app.publisher) === normalizePublisher(d.publisher) &&
              Boolean(d.version) &&
              Boolean(app.version) &&
              sameVersion(app.version, d.version),
          );
          if (hit) {
            appDetected = true;
            break;
          }
        } catch {
          /* detection is best effort; the caller verifies by opening the app */
        }
      }
    }
    fs.rmSync(path.dirname(d.file), { recursive: true, force: true });
    return {
      success: ok && appDetected && !reboot,
      status: r.uncertain
        ? 'EXECUTION_UNCERTAIN'
        : r.timedOut
          ? 'INSTALL_TIMEOUT'
          : cancelled
            ? 'INSTALL_CANCELLED'
            : reboot
              ? 'INSTALL_PENDING_RESTART'
              : ok
                ? appDetected
                  ? 'INSTALLER_COMPLETED'
                  : 'INSTALL_UNVERIFIED'
                : 'INSTALL_FAILED',
      downloadId,
      name: d.product,
      publisher: d.publisher,
      host: d.host,
      sha256: d.sha256,
      exitCode: r.code,
      needsReboot: reboot,
      appDetected,
      durationMs: Date.now() - started,
      message: reboot
        ? 'Windows requires a restart; installation is pending and has not been reported as complete.'
        : r.uncertain
          ? 'The installer may still be active; inspect the application inventory before retrying.'
          : ok
            ? appDetected
              ? `${d.product} was installed and found on this PC.`
              : `The installer finished, but ${d.product} was not found on this PC yet.`
            : cancelled
              ? 'The installation was cancelled.'
              : r.timedOut
                ? 'The installer did not finish in time.'
                : `The installer failed (exit code ${r.code}).`,
      verification: {
        status: appDetected ? 'verified' : 'unverified',
        criterion: appDetected ? 'app_registry' : 'exit_code_only',
        observedAt: new Date().toISOString(),
      },
    };
  }

  /** Called only by the main-process native picker. No tool accepts model-supplied paths. */
  async stageOffline(selectedPath, query) {
    checkCancellation();
    this.prune();
    if (!new RegExp(QUERY_PATTERN).test(query))
      throw failure('INVALID_APP_NAME', 'Enter the application name.');
    const selected = await fs.promises.lstat(selectedPath);
    if (
      !selected.isFile() ||
      selected.isSymbolicLink() ||
      !/\.(exe|msi)$/i.test(selectedPath) ||
      selected.size < 4 ||
      selected.size > MAX_INSTALLER_BYTES
    )
      throw failure(
        'INVALID_INSTALLER',
        'Choose a regular EXE or MSI installer smaller than 800 MB.',
      );
    const directory = path.join(this.root, crypto.randomBytes(8).toString('hex'));
    const fileName = path.basename(selectedPath).replace(/[^A-Za-z0-9._ -]/g, '_');
    const file = path.join(directory, fileName);
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await fs.promises.copyFile(selectedPath, file, fs.constants.COPYFILE_EXCL);
      const size = (await fs.promises.stat(file)).size;
      if (size > MAX_INSTALLER_BYTES || !hasInstallerHeader(file))
        throw failure(
          'NOT_AN_INSTALLER',
          'The selected file is not a supported Windows installer.',
        );
      const signature = await this.verify(file);
      if (signature?.status !== 'Valid')
        throw failure(
          'UNSIGNED_INSTALLER',
          'The offline installer does not have a valid digital signature. It was not run.',
        );
      const publisher = signerName(signature.signer);
      if (
        !publisher ||
        !identityMatches(
          query,
          [
            signature.product,
            signature.company,
            signature.description,
            signature.original,
            publisher,
          ].join(' '),
        )
      )
        throw failure(
          'IDENTITY_MISMATCH',
          "The signed installer's product identity does not match the application name you entered. It was not run.",
        );
      const sha256 = await hashFile(file),
        downloadId = crypto.randomBytes(8).toString('hex'),
        product = signature.product || signature.description || query;
      this.downloads.set(downloadId, {
        file,
        fileName,
        size,
        sha256,
        publisher,
        product,
        version: signature.version || '',
        query,
        source: 'offline',
        host: 'selected offline file',
        owner: executionContext.getStore()?.scope,
        at: Date.now(),
      });
      return {
        success: true,
        downloadId,
        product,
        publisher,
        size,
        sha256,
        fileName,
        source: 'offline',
        message: `Verified ${product}, signed by ${publisher}. It has not been run.`,
      };
    } catch (error) {
      await fs.promises
        .rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        .catch((cleanupError) =>
          console.warn('[install] Private quarantine cleanup deferred:', cleanupError.code),
        );
      throw error;
    }
  }
}
