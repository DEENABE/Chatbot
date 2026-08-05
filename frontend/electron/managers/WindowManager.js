import { BrowserWindow, screen } from 'electron';
import path from 'path';
import { getPreloadPath, isPacked, rootDir } from '../utils/pathHelper.js';
import { BUBBLE_SIZE, CHAT_WIDTH, CHAT_HEIGHT, TOOLBAR_HEIGHT, HOVER_WIDTH } from '../utils/constants.js';

let mainWindow = null;
let isExpanded = false;
let isToolbarMode = false;
let isDragging = false;
let dragOffset = { x: 0, y: 0 };
let preOcrBounds = null;
// Where the bubble sat before the chat opened, so collapsing puts it back
// instead of deriving a new spot from the (possibly resized) chat window.
let preExpandBubblePos = null;

export function getMainWindow() {
  return mainWindow;
}

export function createWindow() {
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  
  const startX = screenW - BUBBLE_SIZE - 20;
  const startY = screenH - BUBBLE_SIZE - 20;

  mainWindow = new BrowserWindow({
    width: BUBBLE_SIZE,
    height: BUBBLE_SIZE,
    x: startX,
    y: startY,
    frame: false,
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
      preload: getPreloadPath()
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(rootDir, "dist", "index.html"));
  
  // DevTools - Enable in dev mode only
  if (!isPacked) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow;
}

export function toggleExpand(expand) {
  if (!mainWindow) return false;
  if (expand === isExpanded) return isExpanded;
  isToolbarMode = false;
  isExpanded = expand;

  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  const [currentX, currentY] = mainWindow.getPosition();
  const [currentW, currentH] = mainWindow.getSize();

  if (isExpanded) {
    // Remember the bubble's spot so collapsing returns it there.
    preExpandBubblePos = { x: currentX, y: currentY };

    // Grow from the bubble's corner, then clamp so the whole chat stays on
    // screen (a bubble near an edge would otherwise open half off-screen).
    const newX = Math.max(10, Math.min(screenW - CHAT_WIDTH - 10, currentX - (CHAT_WIDTH - currentW)));
    const newY = Math.max(10, Math.min(screenH - CHAT_HEIGHT - 10, currentY - (CHAT_HEIGHT - currentH)));

    mainWindow.setResizable(true);
    mainWindow.setBounds({ x: newX, y: newY, width: CHAT_WIDTH, height: CHAT_HEIGHT });
    mainWindow.setSkipTaskbar(false);
  } else {
    // Prefer the remembered position; fall back to the chat's bottom-right
    // corner when there is none (e.g. the app started expanded).
    const fallbackX = currentX + (currentW - BUBBLE_SIZE);
    const fallbackY = currentY + (currentH - BUBBLE_SIZE);
    const targetX = preExpandBubblePos ? preExpandBubblePos.x : fallbackX;
    const targetY = preExpandBubblePos ? preExpandBubblePos.y : fallbackY;
    preExpandBubblePos = null;

    const newX = Math.max(10, Math.min(screenW - BUBBLE_SIZE - 10, targetX));
    const newY = Math.max(10, Math.min(screenH - BUBBLE_SIZE - 10, targetY));

    mainWindow.setResizable(false);
    mainWindow.setBounds({ x: newX, y: newY, width: BUBBLE_SIZE, height: BUBBLE_SIZE });
    mainWindow.setSkipTaskbar(true);
  }

  return isExpanded;
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
    if (!isExpanded) {
      mainWindow.setResizable(false);
    }
    preOcrBounds = null;
  }
  return true;
}

export function setToolbarMode(enable) {
  if (!mainWindow || isExpanded) return false;
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
  if (!mainWindow) return;
  const cursor = screen.getCursorScreenPoint();
  const pos = mainWindow.getPosition();
  dragOffset = {
    x: cursor.x - pos[0],
    y: cursor.y - pos[1]
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
  
  if (!isExpanded) {
    const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
    const [winX, winY] = mainWindow.getPosition();

    const snapX = (winX + BUBBLE_SIZE / 2 < screenW / 2) ? 20 : (screenW - BUBBLE_SIZE - 20);
    const snapY = Math.max(20, Math.min(screenH - BUBBLE_SIZE - 20, winY));

    mainWindow.setBounds({ x: snapX, y: snapY, width: BUBBLE_SIZE, height: BUBBLE_SIZE }, true);
  }
}

// Collapse back to the bubble before minimizing. Without this the window is
// restored at chat size while the renderer still thinks it is expanded, so the
// bubble and the chat state disagree and the UI comes back in a broken layout.
export function minimizeWindow() {
  if (!mainWindow) return false;
  if (isExpanded) collapseToBubble();
  mainWindow.minimize();
  return isExpanded;
}

/** Shrink the window back to the corner bubble and reset the mode flags. */
function collapseToBubble() {
  isExpanded = false;
  isToolbarMode = false;
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  const [currentX, currentY] = mainWindow.getPosition();
  const [currentW, currentH] = mainWindow.getSize();

  // Same rule as toggleExpand: go back to where the bubble was, or the chat's
  // bottom-right corner if we never recorded one.
  const targetX = preExpandBubblePos ? preExpandBubblePos.x : currentX + (currentW - BUBBLE_SIZE);
  const targetY = preExpandBubblePos ? preExpandBubblePos.y : currentY + (currentH - BUBBLE_SIZE);
  preExpandBubblePos = null;

  const newX = Math.max(10, Math.min(screenW - BUBBLE_SIZE - 10, targetX));
  const newY = Math.max(10, Math.min(screenH - BUBBLE_SIZE - 10, targetY));

  mainWindow.setResizable(false);
  mainWindow.setBounds({ x: newX, y: newY, width: BUBBLE_SIZE, height: BUBBLE_SIZE });
  mainWindow.setSkipTaskbar(true);
}

export function closeWindow() {
  if (!mainWindow || !isExpanded) return false;
  collapseToBubble();
  return false;
}
