import path from 'node:path';
// Small adapters describe argument semantics, never install locations or app existence.
export function capabilitiesFor(app) {
  const exe = path.win32.basename(app.executablePath || '').toLowerCase();
  const profile = /^(code|code - insiders)\.exe$/.test(exe)
    ? 'editor'
    : exe === 'vlc.exe'
      ? 'media'
      : /^(msedge|chrome|firefox|brave)\.exe$/.test(exe)
        ? 'browser'
        : exe === 'notepad.exe'
          ? 'text'
          : null;
  const types =
    {
      editor: ['FILE', 'DOCUMENT', 'FOLDER', 'WORKSPACE'],
      media: ['FILE', 'MEDIA', 'URL'],
      browser: ['URL', 'FILE', 'DOCUMENT'],
      text: ['FILE', 'DOCUMENT'],
    }[profile] || [];
  return {
    profile,
    types,
    openFile: types.includes('FILE'),
    openFolder: types.includes('FOLDER'),
    openUrl: types.includes('URL'),
    openMedia: types.includes('MEDIA'),
  };
}
