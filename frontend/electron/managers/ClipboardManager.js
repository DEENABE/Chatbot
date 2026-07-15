import { clipboard } from 'electron';

let intervalId = null;

export function startClipboardPolling(sendCallback) {
  if (intervalId) return;

  let lastClipboardText = clipboard.readText();

  intervalId = setInterval(() => {
    try {
      const text = clipboard.readText();
      if (text && text.trim() && text !== lastClipboardText) {
        lastClipboardText = text;
        sendCallback(text);
      }
    } catch (err) {
      // prevent clipboard locks from crashing
    }
  }, 1500);
}

export function stopClipboardPolling() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
