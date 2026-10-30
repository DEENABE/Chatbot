import { BrowserWindow, screen, shell } from 'electron';
import path from 'path';
import { getPreloadPath, isPacked, rootDir } from '../utils/pathHelper.js';
import { getBackendApiBaseUrl, getApiClientKey } from '../utils/runtimeEndpoint.js';
import { loadCompactBounds, saveCompactBounds } from '../utils/windowState.js';
import {
  BUBBLE_SIZE,
  CHAT_WIDTH,
  CHAT_HEIGHT,
  MIN_CHAT_WIDTH,
  MIN_CHAT_HEIGHT,
  TOOLBAR_HEIGHT,
  HOVER_WIDTH,
} from '../utils/constants.js';

export const WINDOW_MODES = ['full', 'compact', 'bubble'];

let mainWindow = null;
// full    — fills the screen's work area (where the app goes after sign-in)
// compact — the small floating chat window, at the size the user left it
// bubble  — the 80px avatar in the screen corner
let windowMode = 'bubble';
// Which of full/compact the bubble reopens into.
let lastExpandedMode = 'full';
let isToolbarMode = false;
let isDragging = false;
let dragOffset = { x: 0, y: 0 };
let preOcrBounds = null;
// The compact window's last bounds, so switching to full and back (or
// restarting the app) restores the size the user chose.
let compactBounds = null;
// Where the bubble sat before the chat opened, so collapsing puts it back
// instead of deriving a new spot from the (possibly resized) chat window.
let preExpandBubblePos = null;
let onDisplayMetricsChanged = null;

export function getMainWindow() {
  return mainWindow;
}

export function getWindowMode() {
  return windowMode;
}

function workArea() {
  return screen.getPrimaryDisplay().workArea;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** Keep a bounds rectangle inside a display's work area at a usable size. */
function fitToArea(bounds, area) {
  const width = clamp(bounds.width, Math.min(MIN_CHAT_WIDTH, area.width), area.width);
  const height = clamp(bounds.height, Math.min(MIN_CHAT_HEIGHT, area.height), area.height);
  return {
    x: clamp(bounds.x, area.x, area.x + area.width - width),
    y: clamp(bounds.y, area.y, area.y + area.height - height),
    width,
    height,
  };
}

function notifyMode() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('window-mode-changed', windowMode);
  }
}

function rememberCompactBounds() {
  if (!mainWindow || windowMode !== 'compact') return;
  compactBounds = mainWindow.getBounds();
  saveCompactBounds(compactBounds);
}

export function createWindow() {
  compactBounds = loadCompactBounds();
  const area = workArea();

  mainWindow = new BrowserWindow({
    // The app launches as the corner bubble; the renderer opens the sign-in
    // window from it and goes full screen once the user is signed in.
    x: area.x + area.width - BUBBLE_SIZE - 20,
    y: area.y + area.height - BUBBLE_SIZE - 20,
    width: BUBBLE_SIZE,
    height: BUBBLE_SIZE,
    frame: false,
    // Fixed at construction: the bubble needs a see-through window. In full and
    // compact mode the renderer paints an opaque background over all of it.
    transparent: true,
    // Without an explicit fully-transparent colour the window paints an opaque
    // frame for a beat while resizing between bubble and chat size.
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: getPreloadPath(),
      additionalArguments: [
        `--chanakya-api-base=${getBackendApiBaseUrl()}`,
        `--chanakya-api-client=${getApiClientKey()}`,
      ],
    },
  });
  windowMode = 'bubble';
  lastExpandedMode = 'full';

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(rootDir, 'dist', 'index.html'));

  // This is a single-page app that never legitimately navigates away from
  // its own loaded index.html — every screen change happens through React
  // state, not a real page load. So any 'will-navigate' at all is
  // unsolicited: an <a href> in rendered markdown (chat replies pass
  // through ReactMarkdown with no link interception — a link can originate
  // from the LLM, and by extension from RAG-retrieved or otherwise
  // injected document content per Phase 5) is the realistic trigger. Left
  // unhandled, Electron's default is to navigate this same, privileged
  // BrowserWindow to whatever URL it finds — and because contextIsolation
  // doesn't stop the preload script from being re-injected on the new
  // page, that would hand an attacker-controlled page the same
  // window.toolEngine / window.sessionAPI surface the real app has,
  // including the live session token and the (confirmation-gated, but
  // still reachable) PowerShell/CMD/file/registry tools from Phase 4.
  // http(s) targets are redirected to the user's actual default browser —
  // an ordinary, unprivileged tab — instead of just being dropped, so
  // clicking a link in chat still does something useful.
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    event.preventDefault();
    if (/^https?:\/\//i.test(navigationUrl)) {
      shell.openExternal(navigationUrl).catch(() => {});
    }
  });

  // Same reasoning for window.open()/target="_blank" — never open a second,
  // equally-privileged Electron window; hand http(s) off to the system
  // browser and deny everything else outright.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  // DevTools - Enable in dev mode only
  if (!isPacked && process.env.CHANAKYA_DEBUG_DESKTOP === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Full mode follows the screen: a resolution change or a moved taskbar would
  // otherwise leave the window covering the wrong area.
  onDisplayMetricsChanged = () => {
    if (mainWindow && windowMode === 'full') mainWindow.setBounds(workArea());
  };
  screen.on('display-metrics-changed', onDisplayMetricsChanged);

  mainWindow.on('close', rememberCompactBounds);

  mainWindow.on('closed', () => {
    if (onDisplayMetricsChanged)
      screen.removeListener('display-metrics-changed', onDisplayMetricsChanged);
    onDisplayMetricsChanged = null;
    mainWindow = null;
  });

  return mainWindow;
}

function applyFull() {
  mainWindow.setAlwaysOnTop(false);
  mainWindow.setResizable(false);
  mainWindow.setSkipTaskbar(false);
  mainWindow.setBounds(workArea());
}

function applyCompact(fromMode) {
  const area = workArea();
  const [currentX, currentY] = mainWindow.getPosition();
  const [currentW, currentH] = mainWindow.getSize();
  const width = compactBounds?.width ?? CHAT_WIDTH;
  const height = compactBounds?.height ?? CHAT_HEIGHT;

  let target;
  if (fromMode === 'bubble') {
    // Grow from the bubble's corner, then clamp so the whole chat stays on
    // screen (a bubble near an edge would otherwise open half off-screen).
    preExpandBubblePos = { x: currentX, y: currentY };
    target = {
      x: currentX - (width - currentW),
      y: currentY - (height - currentH),
      width,
      height,
    };
  } else if (compactBounds) {
    target = compactBounds;
  } else {
    target = {
      x: area.x + area.width - width - 20,
      y: area.y + area.height - height - 20,
      width,
      height,
    };
  }

  mainWindow.setAlwaysOnTop(true);
  mainWindow.setResizable(true);
  mainWindow.setBounds(fitToArea(target, area));
  mainWindow.setSkipTaskbar(false);
}

function applyBubble() {
  const area = workArea();
  const [currentX, currentY] = mainWindow.getPosition();
  const [currentW, currentH] = mainWindow.getSize();

  // Prefer the remembered position; fall back to the window's bottom-right
  // corner when there is none (e.g. the app started in full mode).
  const targetX = preExpandBubblePos
    ? preExpandBubblePos.x
    : Math.min(currentX + (currentW - BUBBLE_SIZE), area.x + area.width - BUBBLE_SIZE - 20);
  const targetY = preExpandBubblePos
    ? preExpandBubblePos.y
    : Math.min(currentY + (currentH - BUBBLE_SIZE), area.y + area.height - BUBBLE_SIZE - 20);
  preExpandBubblePos = null;

  mainWindow.setResizable(false);
  mainWindow.setAlwaysOnTop(true);
  mainWindow.setBounds({
    x: clamp(targetX, area.x + 10, area.x + area.width - BUBBLE_SIZE - 10),
    y: clamp(targetY, area.y + 10, area.y + area.height - BUBBLE_SIZE - 10),
    width: BUBBLE_SIZE,
    height: BUBBLE_SIZE,
  });
  mainWindow.setSkipTaskbar(true);
}

/** Switch between the full-screen, windowed and bubble layouts. */
export function setWindowMode(mode) {
  if (!mainWindow || !WINDOW_MODES.includes(mode)) return windowMode;
  if (mode === windowMode) return windowMode;

  const fromMode = windowMode;
  if (fromMode === 'compact') rememberCompactBounds();
  isToolbarMode = false;

  if (mode === 'full') applyFull();
  else if (mode === 'compact') applyCompact(fromMode);
  else applyBubble();

  windowMode = mode;
  if (mode !== 'bubble') lastExpandedMode = mode;
  notifyMode();
  return windowMode;
}

/** Bubble <-> chat. Opening returns to whichever of full/compact was used last. */
export function toggleExpand(expand) {
  if (!mainWindow) return false;
  setWindowMode(expand ? lastExpandedMode : 'bubble');
  return windowMode !== 'bubble';
}

export function setOcrMode(enable) {
  if (!mainWindow) return false;
  if (enable) {
    preOcrBounds = mainWindow.getBounds();
    const primaryDisplay = screen.getPrimaryDisplay();
    const { x, y, width, height } = primaryDisplay.bounds;

    mainWindow.setResizable(true);
    mainWindow.setBounds({ x, y, width, height }, true);
    mainWindow.setAlwaysOnTop(true);
  } else if (preOcrBounds) {
    mainWindow.setBounds(preOcrBounds, true);
    if (windowMode === 'full') mainWindow.setAlwaysOnTop(false);
    if (windowMode !== 'compact') {
      mainWindow.setResizable(false);
    }
    preOcrBounds = null;
  }
  return true;
}

export function setToolbarMode(enable) {
  if (!mainWindow || windowMode !== 'bubble') return false;
  if (enable === isToolbarMode) return isToolbarMode;
  isToolbarMode = enable;

  const { width: screenW } = screen.getPrimaryDisplay().workAreaSize;
  const [currentX, currentY] = mainWindow.getPosition();
  const [currentW, currentH] = mainWindow.getSize();

  const targetW = enable ? HOVER_WIDTH : BUBBLE_SIZE;
  const targetH = enable ? TOOLBAR_HEIGHT : BUBBLE_SIZE;
  const newY = Math.max(0, currentY + currentH - targetH);

  // Grow away from the nearest screen edge and keep that edge pinned, so the
  // avatar does not move. Centring the window instead looks fine mid-screen but
  // the clamp shoves it sideways at an edge — and the edge is where the bubble
  // lives by default, so the avatar jumped out from under the cursor.
  const onRightHalf = currentX + currentW / 2 > screenW / 2;
  const desiredX = onRightHalf ? currentX + currentW - targetW : currentX;
  const newX = Math.max(0, Math.min(screenW - targetW, desiredX));

  mainWindow.setResizable(enable);
  mainWindow.setBounds({ x: newX, y: newY, width: targetW, height: targetH });

  // The renderer aligns its column to the same edge, otherwise the avatar would
  // sit in the middle of the widened window instead of where it was.
  return { enabled: isToolbarMode, side: onRightHalf ? 'right' : 'left' };
}

export function handleDragStart() {
  // A full-screen window has nowhere to be dragged to.
  if (!mainWindow || windowMode === 'full') return;
  const cursor = screen.getCursorScreenPoint();
  const pos = mainWindow.getPosition();
  dragOffset = {
    x: cursor.x - pos[0],
    y: cursor.y - pos[1],
  };
  isDragging = true;
}

export function handleDragMove() {
  if (!isDragging || !mainWindow) return;
  const cursor = screen.getCursorScreenPoint();
  mainWindow.setPosition(cursor.x - dragOffset.x, cursor.y - dragOffset.y);
}

export function handleDragEnd() {
  isDragging = false;
  isToolbarMode = false;
  if (!mainWindow) return;

  if (windowMode === 'bubble') {
    const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
    const [winX, winY] = mainWindow.getPosition();

    const snapX = winX + BUBBLE_SIZE / 2 < screenW / 2 ? 20 : screenW - BUBBLE_SIZE - 20;
    const snapY = Math.max(20, Math.min(screenH - BUBBLE_SIZE - 20, winY));

    mainWindow.setBounds({ x: snapX, y: snapY, width: BUBBLE_SIZE, height: BUBBLE_SIZE }, true);
  }
}

/** Drag-resize from the renderer's corner handles; only the compact window resizes. */
export function resizeWindow(width, height) {
  if (!mainWindow || windowMode !== 'compact') return false;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  const area = workArea();
  mainWindow.setSize(
    clamp(Math.round(width), MIN_CHAT_WIDTH, area.width),
    clamp(Math.round(height), MIN_CHAT_HEIGHT, area.height),
  );
  return true;
}

// A real minimize to the taskbar. The window keeps its mode, so restoring it
// brings back exactly the layout that was minimized.
export function minimizeWindow() {
  if (!mainWindow || windowMode === 'bubble') return false;
  mainWindow.minimize();
  return true;
}

// Closing the window ends the app; the bubble button is the way to keep it
// running in the background. window-all-closed in main.js does the shutdown.
export function closeWindow() {
  if (!mainWindow || windowMode === 'bubble') return false;
  mainWindow.close();
  return true;
}
