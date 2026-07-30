import { BrowserWindow, screen } from 'electron';
import path from 'path';
import { getPreloadPath, isPacked, rootDir } from '../utils/pathHelper.js';
import { BUBBLE_SIZE, CHAT_WIDTH, CHAT_HEIGHT, TOOLBAR_HEIGHT } from '../utils/constants.js';

let mainWindow = null;
let isExpanded = false;
let isToolbarMode = false;
let isDragging = false;
let dragOffset = { x: 0, y: 0 };
let preOcrBounds = null;

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
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false, 
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: getPreloadPath(),
      webSecurity: false
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
    let newX = currentX - (CHAT_WIDTH - currentW);
    let newY = currentY - (CHAT_HEIGHT - currentH);

    newX = Math.max(10, Math.min(screenW - CHAT_WIDTH - 10, newX));
    newY = Math.max(10, Math.min(screenH - CHAT_HEIGHT - 10, newY));

    mainWindow.setResizable(true);
    mainWindow.setBounds({ x: newX, y: newY, width: CHAT_WIDTH, height: CHAT_HEIGHT }, true);
    mainWindow.setSkipTaskbar(false);
  } else {
    let newX = currentX + (currentW - BUBBLE_SIZE);
    let newY = currentY + (currentH - BUBBLE_SIZE);

    newX = Math.max(10, Math.min(screenW - BUBBLE_SIZE - 10, newX));
    newY = Math.max(10, Math.min(screenH - BUBBLE_SIZE - 10, newY));

    mainWindow.setResizable(false);
    mainWindow.setBounds({ x: newX, y: newY, width: BUBBLE_SIZE, height: BUBBLE_SIZE }, true);
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

  const [currentX, currentY] = mainWindow.getPosition();
  const [, currentH] = mainWindow.getSize();

  if (enable) {
    const newY = currentY + currentH - TOOLBAR_HEIGHT;
    mainWindow.setResizable(true);
    mainWindow.setBounds({ x: currentX, y: Math.max(0, newY), width: BUBBLE_SIZE, height: TOOLBAR_HEIGHT }, true);
  } else {
    const newY = currentY + currentH - BUBBLE_SIZE;
    mainWindow.setResizable(false);
    mainWindow.setBounds({ x: currentX, y: newY, width: BUBBLE_SIZE, height: BUBBLE_SIZE }, true);
  }
  return isToolbarMode;
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

  const newX = Math.max(10, Math.min(screenW - BUBBLE_SIZE - 10, currentX + (currentW - BUBBLE_SIZE)));
  const newY = Math.max(10, Math.min(screenH - BUBBLE_SIZE - 10, currentY + (currentH - BUBBLE_SIZE)));

  mainWindow.setResizable(false);
  mainWindow.setBounds({ x: newX, y: newY, width: BUBBLE_SIZE, height: BUBBLE_SIZE }, true);
  mainWindow.setSkipTaskbar(true);
}

export function closeWindow() {
  if (!mainWindow || !isExpanded) return false;
  collapseToBubble();
  return false;
}
