// Dev helper: capture the bubble (or panel) window to a PNG so we can verify
// rendering (e.g. that the bubble is a pure circle with no box).
// Usage: npx electron scripts/capture-bubble.cjs        -> bubble
//        $env:CAPTURE_PANEL='1'; npx electron scripts/capture-bubble.cjs -> panel
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const BUBBLE_WIDTH = 64;
const BUBBLE_HEIGHT = 64;
const PANEL_WIDTH = 460;
const PANEL_HEIGHT = 620;
const expanded = process.env.CAPTURE_PANEL === '1';

function clampBubbleBounds(bounds) {
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const width = BUBBLE_WIDTH;
  const height = BUBBLE_HEIGHT;
  let x = bounds.x ?? workArea.x + workArea.width - width - 28;
  let y = bounds.y ?? workArea.y + Math.round(workArea.height / 2 - height / 2);
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width));
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height));
  return { x, y, width, height };
}

app.whenReady().then(async () => {
  const bubbleBounds = clampBubbleBounds({});
  const bounds = expanded ? { x: bubbleBounds.x, y: bubbleBounds.y, width: PANEL_WIDTH, height: PANEL_HEIGHT } : bubbleBounds;
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    title: 'Inspect It',
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  ipcMain.handle('inspect-it:get-window-state', () => ({ expanded, bubbleState: bounds }));
  ipcMain.handle('inspect-it:set-expanded', () => ({ expanded }));
  ipcMain.handle('inspect-it:set-bounds', () => undefined);
  ipcMain.handle('inspect-it:focus', () => undefined);
  ipcMain.handle('inspect-it:begin-drag', () => ({ x: bubbleBounds.x, y: bubbleBounds.y }));
  ipcMain.handle('inspect-it:drag-by', () => undefined);
  ipcMain.handle('inspect-it:end-drag', () => undefined);
  ipcMain.handle('inspect-it:panel-resize-by', () => undefined);
  ipcMain.handle('inspect-it:get-auto-launch', () => false);
  ipcMain.handle('inspect-it:set-auto-launch', () => false);
  ipcMain.handle('inspect-it:ai-get-key', () => null);
  ipcMain.handle('inspect-it:ai-set-key', () => true);
  ipcMain.handle('inspect-it:ai-clear-key', () => true);
  ipcMain.handle('inspect-it:ai-has-key', () => false);
  ipcMain.handle('inspect-it:ai-chat', () => ({ requestId: 'stub' }));
  ipcMain.handle('inspect-it:ai-abort', () => true);

  await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  await new Promise((resolve) => setTimeout(resolve, 1800));
  const image = await win.webContents.capturePage();
  const out = path.join(process.env.TEMP || '/tmp', expanded ? 'inspect-panel.png' : 'inspect-bubble.png');
  fs.writeFileSync(out, image.toPNG());
  console.log('CAPTURED', out, image.getSize());
  app.quit();
});
