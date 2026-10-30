import { BaseToolService } from '../BaseToolService.js';
import { executionContext, checkCancellation } from '../ExecutionContext.js';
import { validateTarget } from '../apps/AppTargetPolicy.js';
import {
  safeBrowserUrl,
  inspectPage,
  browserSelector,
  sensitiveField,
  publicBrowserUrl,
} from '../browser/BrowserPolicy.js';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const fail = (code, message = code) => {
  throw Object.assign(new Error(message), { code });
};
const str = (required = false, maxLength = 200) => ({
  type: 'string',
  required,
  maxLength,
});
export const browserActions = {
  openBrowser: {},
  attachBrowser: {},
  newTab: { url: str(false, 4096) },
  closeTab: { tabId: str() },
  switchTab: { tabId: str(true) },
  navigate: { url: str(true, 4096) },
  search: { query: str(true, 1000) },
  click: { elementId: str(), semanticIntent: str() },
  type: { elementId: str(true), text: str(true, 2000) },
  readText: {},
  scroll: { direction: { type: 'enum', values: ['up', 'down'] } },
  getPageTitle: {},
  getCurrentUrl: {},
  getVisibleElements: {},
  waitForElement: { name: str(true) },
  waitForNavigation: { url: str(true, 4096) },
  back: {},
  forward: {},
  downloads: {},
  submit: { elementId: str(true) },
};
export class BrowserAutomationService extends BaseToolService {
  constructor(gate, appService, { launcher, directory, headless = false } = {}) {
    super('browser', gate);
    this.appService = appService;
    this.launcher = launcher;
    this.directory = directory || path.join(os.homedir(), '.chanakya', 'browser');
    this.headless = headless;
    this.sessions = new Map();
    this.locks = new Set();
  }
  get actions() {
    return Object.fromEntries(
      Object.entries(browserActions).map(([action, schema]) => [
        action,
        {
          schema: { browser: str(), ...schema },
          handler: (p) => this.perform(action, p),
          destructive: action === 'submit',
          description: `${action} in an owned Chromium automation session. Use opaque element/tab IDs from inspection; credentials are excluded. Submit requires approval.`,
        },
      ]),
    );
  }
  getConfirmationMessage(action, p) {
    const state = this.sessions.get(this.scope());
    const element = state?.elements.get(p.elementId);
    return action === 'submit'
      ? `Submit the visible form using “${element?.name || 'selected button'}” in ${state?.query || 'the managed browser'}? This sends form data and may change external state.`
      : null;
  }
  scope() {
    const scope = executionContext.getStore()?.scope;
    if (!scope) fail('AUTH_CONTEXT_REQUIRED');
    return scope;
  }
  async session(browser, attachOnly = false) {
    const scope = this.scope();
    let existing = this.sessions.get(scope);
    if (
      existing &&
      (!browser || existing.query === browser) &&
      existing.context.pages().some((p) => !p.isClosed())
    )
      return existing;
    if (attachOnly)
      fail(
        'BROWSER_ATTACH_FAILED',
        'No owned browser session is available. Open a managed browser first.',
      );
    const resolved = await this.appService.resolve(browser || 'Microsoft Edge');
    if (!resolved.success) fail(resolved.status, resolved.message);
    validateTarget(resolved.app);
    if (
      !/^(chrome|msedge|brave)\.exe$/i.test(path.win32.basename(resolved.app.executablePath || ''))
    )
      fail('BROWSER_ATTACH_FAILED', 'The discovered app is not a supported Chromium browser.');
    if (existing?.appId === resolved.app.id && existing.context.pages().some((p) => !p.isClosed()))
      return existing;
    if (existing) {
      await existing.context.close();
      this.sessions.delete(scope);
    }
    const { chromium } = this.launcher
      ? { chromium: this.launcher }
      : await import('playwright-core');
    const directory = path.join(
      this.directory,
      createHash('sha256').update(scope).digest('hex').slice(0, 24),
      resolved.app.id,
    );
    await fs.mkdir(directory, { recursive: true });
    const context = await chromium.launchPersistentContext(directory, {
      executablePath: resolved.app.executablePath,
      headless: this.headless,
      chromiumSandbox: true,
      acceptDownloads: false,
      serviceWorkers: 'block',
      permissions: [],
      timeout: 20000,
    });
    const state = {
      context,
      query: browser || 'Microsoft Edge',
      appId: resolved.app.id,
      elements: new Map(),
      tabs: new Map(),
      allowSubmit: false,
    };
    // External mutations are denied outside the explicitly approved submit action.
    await context.route('**/*', async (route) => {
      const r = route.request();
      if (
        !['http:', 'https:'].includes(new URL(r.url()).protocol) ||
        (!['GET', 'HEAD', 'OPTIONS'].includes(r.method()) &&
          !(
            state.allowSubmit &&
            r.isNavigationRequest() &&
            r.url() === state.allowSubmit.url &&
            r.method() === state.allowSubmit.method
          ))
      )
        return route.abort('blockedbyclient');
      if (r.isNavigationRequest()) {
        try {
          if (!(state.allowSubmit && r.url() === state.allowSubmit.url)) safeBrowserUrl(r.url());
        } catch {
          return route.abort('blockedbyclient');
        }
      }
      return route.continue();
    });
    if (context.routeWebSocket) await context.routeWebSocket('**/*', (socket) => socket.close());
    const protect = (p) => {
      p.on('dialog', (d) => d.dismiss().catch(() => {}));
      p.on('download', (d) => d.cancel().catch(() => {}));
    };
    context.on('page', protect);
    context.pages().forEach(protect);
    state.page = context.pages()[0] || (await context.newPage());
    this.sessions.set(scope, state);
    return state;
  }
  async inspect(state) {
    const rows = await state.page.evaluate(inspectPage);
    state.elements.clear();
    return rows.map((row) => {
      const id = randomUUID();
      state.elements.set(id, {
        ...row,
        page: state.page,
        url: state.page.url(),
      });
      const { index, fingerprint, href, ...safe } = row;
      return {
        ...safe,
        elementId: id,
        ...(href ? { destination: new URL(href).origin } : {}),
      };
    });
  }
  async element(state, id) {
    const old = state.elements.get(id);
    if (!old || old.page !== state.page || old.url !== state.page.url())
      fail('STALE_UI_ELEMENT', 'Inspect the page again before acting.');
    const rows = await state.page.evaluate(inspectPage),
      fresh = rows.find((r) => r.index === old.index);
    if (!fresh || fresh.fingerprint !== old.fingerprint || !fresh.enabled) fail('STALE_UI_ELEMENT');
    return {
      row: fresh,
      locator: state.page.locator(browserSelector).nth(fresh.index),
    };
  }
  async perform(action, p = {}) {
    const scope = this.scope();
    if (this.locks.has(scope)) fail('BROWSER_BUSY');
    this.locks.add(scope);
    try {
      checkCancellation();
      const s = await this.session(p.browser, action === 'attachBrowser');
      let page = s.page;
      if (page.isClosed()) page = s.page = s.context.pages()[0] || (await s.context.newPage());
      page.setDefaultTimeout(7000);
      let data = {};
      const navigate = async (url) => {
        const response = await page.goto(safeBrowserUrl(url), {
          waitUntil: 'domcontentloaded',
          timeout: 20000,
        });
        if (response && response.status() >= 400)
          fail('VERIFICATION_FAILED', 'The destination returned an error.');
      };
      if (action === 'navigate') await navigate(p.url);
      else if (action === 'search') {
        await navigate(`https://www.bing.com/search?q=${encodeURIComponent(p.query)}`);
        if (
          new URL(page.url()).searchParams.get('q') !== p.query ||
          /sorry|captcha|challenge/i.test(new URL(page.url()).pathname)
        )
          fail(
            'VERIFICATION_FAILED',
            'The search provider did not expose a verified results page.',
          );
        try {
          await page.locator('h2 a,h3').first().waitFor({ state: 'visible', timeout: 10000 });
        } catch {
          fail(
            'VERIFICATION_FAILED',
            'Search opened, but visible results are unavailable. The provider may require human interaction.',
          );
        }
      } else if (action === 'newTab') {
        page = s.page = await s.context.newPage();
        if (p.url) await navigate(p.url);
      } else if (action === 'switchTab') {
        const selected = s.tabs.get(p.tabId);
        if (!selected || selected.isClosed()) fail('PAGE_ELEMENT_NOT_FOUND');
        page = s.page = selected;
        await page.bringToFront();
      } else if (action === 'closeTab') {
        const selected = p.tabId ? s.tabs.get(p.tabId) : page;
        if (!selected || selected.isClosed()) fail('PAGE_ELEMENT_NOT_FOUND');
        await selected.close();
        page = s.page = s.context.pages()[0] || (await s.context.newPage());
      } else if (action === 'scroll') {
        await page.evaluate(
          (direction) => window.scrollBy(0, direction === 'up' ? -600 : 600),
          p.direction || 'down',
        );
      } else if (action === 'back' || action === 'forward') {
        const history = await s.context.newCDPSession(page);
        try {
          const h = await history.send('Page.getNavigationHistory');
          const next = h.entries[h.currentIndex + (action === 'back' ? -1 : 1)];
          if (!next) fail('PAGE_ELEMENT_NOT_FOUND');
          safeBrowserUrl(next.url);
          await history.send('Page.navigateToHistoryEntry', {
            entryId: next.id,
          });
          await page.waitForLoadState('domcontentloaded');
        } finally {
          await history.detach();
        }
      } else if (action === 'downloads') {
        await page.goto(/edge/i.test(s.query) ? 'edge://downloads/' : 'chrome://downloads/');
      } else if (action === 'waitForNavigation') {
        await page.waitForURL(safeBrowserUrl(p.url), { timeout: 10000 });
      } else if (action === 'waitForElement') {
        await page.getByText(p.name, { exact: true }).first().waitFor({ state: 'visible' });
      } else if (['click', 'type', 'submit'].includes(action)) {
        let id = p.elementId;
        if (action === 'click' && p.semanticIntent === 'first_relevant_result') {
          const rows = await this.inspect(s);
          const link = rows.find(
            (r) =>
              r.role === 'link' &&
              r.searchResult &&
              r.name &&
              r.destination &&
              /^https?:/.test(r.destination),
          );
          if (
            !/^(www\.|html\.)?(google\.com|bing\.com|duckduckgo\.com)$/.test(
              new URL(page.url()).hostname,
            ) ||
            !link
          )
            fail('LOW_MATCH_CONFIDENCE');
          id = link.elementId;
        }
        const { row, locator } = await this.element(s, id);
        if (action === 'click') {
          if (row.role !== 'link' || !row.href || row.download)
            fail('PERMISSION_REQUIRED', 'Only normal links can be followed without approval.');
          await navigate(row.href);
        } else if (action === 'type') {
          if (row.role !== 'textbox' || sensitiveField(p.text)) fail('SENSITIVE_FIELD');
          await locator.fill(p.text);
          if ((await locator.inputValue()) !== p.text) fail('VERIFICATION_FAILED');
        } else {
          if (row.role !== 'button' || !['submit', 'button'].includes(row.type))
            fail('PERMISSION_REQUIRED');
          const secret = await locator.evaluate((e) => {
            const form = e.closest('form');
            return (
              !form ||
              [...form.querySelectorAll('input,textarea')].some((f) =>
                /password|passcode|credential|one.?time|\botp\b|\bpin\b|card|cvv|cvc|token/i.test(
                  [
                    f.type,
                    f.name,
                    f.id,
                    f.autocomplete,
                    f.getAttribute('aria-label'),
                    f.labels?.[0]?.textContent,
                  ].join(' '),
                ),
              )
            );
          });
          if (secret) fail('SENSITIVE_FIELD');
          const submission = await locator.evaluate((e) => ({
            url: e.closest('form').action,
            method: e.closest('form').method.toUpperCase(),
          }));
          if (!['http:', 'https:'].includes(new URL(submission.url).protocol))
            fail('INVALID_TARGET');
          s.allowSubmit = submission;
          try {
            await locator.click();
            await page.waitForLoadState('domcontentloaded');
          } finally {
            s.allowSubmit = false;
          }
        }
      }
      checkCancellation();
      if (['getVisibleElements', 'readText', 'waitForElement'].includes(action)) {
        data.elements = await this.inspect(s);
        if (action === 'readText')
          data.text = data.elements
            .filter((e) => e.role === 'text')
            .map((e) => e.name)
            .join('\n')
            .slice(0, 8000);
      } else s.elements.clear();
      data.tabs = [];
      for (const tab of s.context.pages()) {
        let id = [...s.tabs].find(([, v]) => v === tab)?.[0];
        if (!id) {
          id = randomUUID();
          s.tabs.set(id, tab);
        }
        data.tabs.push({ tabId: id, active: tab === page });
      }
      return {
        success: true,
        status: 'BROWSER_ACTION_COMPLETED',
        action,
        appId: s.appId,
        ...data,
        title: sensitiveField(await page.title())
          ? '[Sensitive title omitted]'
          : (await page.title()).slice(0, 300),
        url: publicBrowserUrl(page.url()),
        verification: {
          status: 'verified',
          criterion: 'browser_dom',
          observedAt: new Date().toISOString(),
          ...(action === 'search' ? { query: p.query } : {}),
          ...(action === 'navigate' ? { requestedUrl: safeBrowserUrl(p.url) } : {}),
        },
        message:
          action === 'search'
            ? `Search results for ${p.query} are open in ${s.query}.`
            : `Browser ${action} completed.`,
      };
    } catch (error) {
      throw Object.assign(
        new Error(error.code ? error.message : 'Browser action could not be verified.'),
        {
          code: error.code || 'BROWSER_ATTACH_FAILED',
          retryable: ['STALE_UI_ELEMENT', 'PAGE_ELEMENT_NOT_FOUND'].includes(error.code),
        },
      );
    } finally {
      this.locks.delete(scope);
    }
  }
  async close() {
    for (const s of this.sessions.values()) await s.context.close();
    this.sessions.clear();
  }
}
