export const sensitiveField = (value) =>
  /password|passcode|credential|one.?time|\botp\b|\bpin\b|credit.?card|card.?number|\bcvv\b|\bcvc\b|security.?code|auth.?token/i.test(
    String(value || ''),
  );
export function safeBrowserUrl(value) {
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw Object.assign(new Error('Invalid browser URL.'), {
      code: 'INVALID_TARGET',
    });
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    /[\x00-\x1f]/.test(value) ||
    /^(javascript|data|file|chrome|edge|about):/i.test(value)
  )
    throw Object.assign(new Error('Only HTTP(S) navigation is allowed.'), {
      code: 'INVALID_TARGET',
    });
  if (
    /(?:logout|signout|delete|remove|purchase|checkout|payment|unsubscribe|download|upload|send|disable)(?:[/?=&_.-]|$)/i.test(
      url.pathname + url.search,
    )
  )
    throw Object.assign(
      new Error('This URL may trigger an external effect; use an approved action.'),
      { code: 'PERMISSION_REQUIRED' },
    );
  return url.href;
}
// Runs in the page. No page-provided JavaScript, selectors, or input values are returned.
export function inspectPage() {
  const sensitive =
    /password|passcode|credential|one.?time|\botp\b|\bpin\b|credit.?card|card.?number|\bcvv\b|\bcvc\b|security.?code|auth.?token/i;
  const selector =
    'a[href],button,input,textarea,select,[role="button"],[role="link"],[role="tab"],h1,h2,h3,p,li';
  const nodes = Array.from(document.querySelectorAll(selector)).slice(0, 2000);
  return nodes
    .map((e, index) => {
      const rect = e.getBoundingClientRect(),
        style = getComputedStyle(e);
      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        style.visibility === 'hidden' ||
        style.display === 'none' ||
        e.closest('[hidden],[aria-hidden="true"]')
      )
        return null;
      const label =
        e.getAttribute('aria-label') ||
        e.labels?.[0]?.textContent ||
        e.getAttribute('placeholder') ||
        '';
      const own = [e.type, e.name, e.id, e.autocomplete, label].join(' ');
      const context = e.closest('form,fieldset,[role="dialog"]');
      if (
        sensitive.test(own) ||
        (context &&
          sensitive.test(
            context.getAttribute('aria-label') ||
              context.querySelector('legend,h1,h2,label')?.textContent ||
              '',
          )) ||
        e.querySelector('input,textarea,[contenteditable="true"]')
      )
        return null;
      const input = e.matches('input,textarea,select,[contenteditable="true"]');
      const name = (input ? label : e.innerText || label).trim().slice(0, 200);
      if (sensitive.test(name)) return null;
      const role =
        e.getAttribute('role') ||
        (e.tagName === 'A'
          ? 'link'
          : e.tagName === 'BUTTON'
            ? 'button'
            : input
              ? 'textbox'
              : 'text');
      return {
        index,
        role,
        name,
        tag: e.tagName,
        type: e.type || '',
        href: e.tagName === 'A' ? e.href : null,
        searchResult:
          !!e.querySelector('h2,h3') ||
          !!e.closest('h2,h3') ||
          !!e.closest('[data-sokoban-container]'),
        download: e.hasAttribute('download'),
        enabled: !e.disabled,
        fingerprint: JSON.stringify([
          e.tagName,
          e.type || '',
          name,
          e.tagName === 'A' ? e.href : null,
        ]),
        sensitive: false,
      };
    })
    .filter(Boolean)
    .slice(0, 200);
}
export const browserSelector =
  'a[href],button,input,textarea,select,[role="button"],[role="link"],[role="tab"],h1,h2,h3,p,li';

export function publicBrowserUrl(value) {
  try {
    const u = new URL(value);
    u.username = '';
    u.password = '';
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) if (key !== 'q') u.searchParams.delete(key);
    return u.href;
  } catch {
    return 'about:blank';
  }
}
