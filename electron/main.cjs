const { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, safeStorage, screen, shell, Tray } = require('electron');
const { autostartDir, autostartFilePath, buildAutostartDesktopEntry, isEntryEnabled } = require('./autostart.cjs');
const fs = require('node:fs');
const path = require('node:path');

const isDev = !!process.env.ELECTRON_START_URL;
const DEBUG_LOGGING = isDev || !!process.env.INSPECT_IT_DEBUG;
const BUBBLE_WIDTH = 64;
const BUBBLE_HEIGHT = 64;
const POPUP_WIDTH = 460;
const POPUP_HEIGHT = 640;
const MIN_PANEL_WIDTH = 380;
const MIN_PANEL_HEIGHT = 440;
const statePath = path.join(app.getPath('userData'), 'window-state.json');
const logDir = path.join(app.getPath('userData'), 'logs');
const logPath = path.join(logDir, 'main.log');

// Minimal, local, best-effort logger. NEVER log secrets, API keys, file
// contents, or extracted text. Debug output is only printed when running in
// development or when INSPECT_IT_DEBUG is set.
function writeLog(level, message) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
    fs.appendFileSync(logPath, line);
    if (DEBUG_LOGGING) {
      process.stdout.write(line);
    }
  } catch {
    // Logging is best-effort and must never crash the application.
  }
}
const log = {
  info: (message) => writeLog('info', message),
  warn: (message) => writeLog('warn', message),
  error: (message) => writeLog('error', message)
};
let bubbleState = {
  x: undefined,
  y: undefined,
  width: BUBBLE_WIDTH,
  height: BUBBLE_HEIGHT
};
let panelSize = {
  width: POPUP_WIDTH,
  height: POPUP_HEIGHT
};
let panelPosition = {
  x: undefined,
  y: undefined
};

function clampPanelSize(width, height) {
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const nextWidth = Math.max(MIN_PANEL_WIDTH, Math.min(width || POPUP_WIDTH, workArea.width));
  const nextHeight = Math.max(MIN_PANEL_HEIGHT, Math.min(height || POPUP_HEIGHT, workArea.height));
  return { width: Math.round(nextWidth), height: Math.round(nextHeight) };
}

function writeState() {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify(
        {
          ...bubbleState,
          panelWidth: panelSize.width,
          panelHeight: panelSize.height,
          panelX: panelPosition.x,
          panelY: panelPosition.y,
          expanded
        },
        null,
        2
      ),
      'utf8'
    );
  } catch {
    // Persisting the bubble is best-effort.
  }
}

let windowRef = null;
let expanded = false;
let restoredExpanded = false;
let dragOrigin = null;

function getLoadUrl() {
  if (isDev) {
    return process.env.ELECTRON_START_URL;
  }
  return `file://${path.join(__dirname, '..', 'dist', 'index.html')}`;
}

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

/**
 * Where the panel should open. If the panel was moved/resized before, restore
 * that exact position (clamped to the display it is on); otherwise fall back
 * to placing it next to the bubble.
 */
function restoredPanelBounds() {
  const width = panelSize.width;
  const height = panelSize.height;
  if (typeof panelPosition.x === 'number' && typeof panelPosition.y === 'number') {
    const point = { x: Math.round(panelPosition.x + width / 2), y: Math.round(panelPosition.y + height / 2) };
    const display = screen.getDisplayNearestPoint(point);
    const workArea = display.workArea;
    const x = Math.max(workArea.x, Math.min(panelPosition.x, workArea.x + workArea.width - width));
    const y = Math.max(workArea.y, Math.min(panelPosition.y, workArea.y + workArea.height - height));
    return { x, y, width, height };
  }
  return null;
}

function popupBoundsNear(bubble) {
  const display = screen.getDisplayNearestPoint({ x: bubble.x + Math.round(bubble.width / 2), y: bubble.y + Math.round(bubble.height / 2) });
  const workArea = display.workArea;
  const width = panelSize.width;
  const height = panelSize.height;
  let x = bubble.x + bubble.width + 14;
  let y = bubble.y + bubble.height - height;
  if (x + width > workArea.x + workArea.width) {
    x = bubble.x - width - 14;
  }
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width));
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height));
  return { x, y, width, height };
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    bubbleState = {
      x: parsed.x,
      y: parsed.y,
      width: BUBBLE_WIDTH,
      height: BUBBLE_HEIGHT
    };
    panelSize = clampPanelSize(parsed.panelWidth, parsed.panelHeight);
    panelPosition = { x: parsed.panelX, y: parsed.panelY };
    restoredExpanded = Boolean(parsed.expanded);
  } catch {
    // Defaults apply (right edge, vertically centered).
  }
}

/**
 * Keep the renderer from navigating anywhere. Analyzed HTML and AI output are
 * untrusted; the Inspect It window must never become a browser. External
 * http/https links are opened in the user's default browser instead.
 */
function preventNavigation(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (url === contents.getURL()) {
      return;
    }
    event.preventDefault();
    if (/^https?:/i.test(url)) {
      shell.openExternal(url);
    }
  });
}

let trayRef = null;

function destroyTray() {
  if (trayRef) {
    trayRef.destroy();
    trayRef = null;
  }
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, '..', 'build', 'tray.png');
    let image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
      log.warn('Tray icon not found; using empty icon.');
    }
    trayRef = new Tray(image);
    trayRef.setToolTip('Inspect It');
    const menu = Menu.buildFromTemplate([
      { label: 'Open Inspect It', click: () => openPanel() },
      { label: 'Show bubble', click: () => collapseToBubble() },
      { type: 'separator' },
      {
        label: 'About',
        click: () => {
          dialog.showMessageBox({
            type: 'info',
            title: 'About Inspect It',
            message: 'Inspect It',
            detail: `${app.getName()} ${app.getVersion()}\n\nDrop anything. Understand it.\nLocal-first, read-only analysis. Optional AI.`,
            buttons: ['OK']
          });
        }
      },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
    ]);
    trayRef.setContextMenu(menu);
    trayRef.on('click', () => {
      if (expanded) {
        collapseToBubble();
      } else {
        openPanel();
      }
    });
    log.info('System tray initialized.');
  } catch (error) {
    log.warn(`System tray unavailable: ${error ? error.message : 'unknown error'}`);
  }
}

function openPanel() {
  if (!windowRef) {
    createWindow();
  }
  focusWindow();
  if (!expanded) {
    setExpanded(true);
  }
}

function collapseToBubble() {
  if (windowRef && expanded) {
    setExpanded(false);
  }
  focusWindow();
}

function getAutoLaunch() {
  try {
    if (process.platform === 'linux') {
      // XDG autostart .desktop entry (setLoginItemSettings is not supported on Linux).
      const file = autostartFilePath(autostartDir());
      const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      return isEntryEnabled(content);
    }
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}

function setAutoLaunch(enabled) {
  try {
    if (process.platform === 'linux') {
      const enabledFlag = Boolean(enabled);
      const dir = autostartDir();
      const file = autostartFilePath(dir);
      if (enabledFlag) {
        // Prefer the AppImage when running from one; otherwise the packaged binary.
        const execPath = process.env.APPIMAGE || (app.isPackaged ? process.execPath : null);
        if (!execPath) {
          log.warn('Auto-launch unavailable: no packaged binary or AppImage path (development mode).');
          return false;
        }
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, buildAutostartDesktopEntry(execPath), { mode: 0o644 });
      } else if (fs.existsSync(file)) {
        fs.rmSync(file, { force: true });
      }
      return getAutoLaunch();
    }
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
    return getAutoLaunch();
  } catch (error) {
    log.warn(`Auto-launch setting failed: ${error ? error.message : 'unknown error'}`);
    return getAutoLaunch();
  }
}

function createWindow() {
  // Default to the last placement; first launch falls back to right-middle.
  readState();
  const bounds = clampBubbleBounds(bubbleState);
  bubbleState = bounds;
  windowRef = new BrowserWindow({
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
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  });

  preventNavigation(windowRef.webContents);
  windowRef.loadURL(getLoadUrl());
  windowRef.once('ready-to-show', () => {
    windowRef.showInactive();
    if (restoredExpanded) {
      setExpanded(true);
    }
  });

  windowRef.on('move', () => {
    if (!windowRef) {
      return;
    }
    const [x, y] = windowRef.getPosition();
    if (expanded) {
      panelPosition = { x, y };
    } else {
      bubbleState = { x, y, width: BUBBLE_WIDTH, height: BUBBLE_HEIGHT };
    }
    writeState();
  });

  windowRef.on('resize', () => {
    if (!expanded || !windowRef) {
      return;
    }
    const [width, height] = windowRef.getSize();
    panelSize = clampPanelSize(width, height);
    const [x, y] = windowRef.getPosition();
    panelPosition = { x, y };
    writeState();
  });

  windowRef.on('closed', () => {
    windowRef = null;
  });

  return windowRef;
}

function setExpanded(nextExpanded) {
  if (!windowRef) {
    return;
  }
  expanded = nextExpanded;
  if (expanded) {
    const [x, y] = windowRef.getPosition();
    const [width, height] = windowRef.getSize();
    bubbleState = { x, y, width, height };
    writeState();
    const popup = restoredPanelBounds() ?? popupBoundsNear(bubbleState);
    windowRef.setAlwaysOnTop(true, 'screen-saver');
    windowRef.setResizable(true);
    // Hide first so the bubble never flashes at the panel's location while the
    // window moves, then reveal the panel exactly where it belongs.
    windowRef.hide();
    windowRef.setBounds(popup, false);
    windowRef.webContents.send('inspect-it-mode', 'panel');
    windowRef.show();
    windowRef.focus();
  } else {
    const bounds = clampBubbleBounds(bubbleState);
    windowRef.hide();
    windowRef.webContents.send('inspect-it-mode', 'bubble');
    windowRef.setResizable(false);
    windowRef.setBounds(bounds, false);
    windowRef.show();
  }
}

function focusWindow() {
  if (!windowRef) {
    createWindow();
  }
  if (!windowRef.isVisible()) {
    windowRef.show();
  }
  windowRef.setAlwaysOnTop(true, 'screen-saver');
  windowRef.focus();
}

app.whenReady().then(() => {
  // Windows-only: associates the app with its taskbar identity (no-op elsewhere).
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.inspectit.desktop');
  }
  createWindow();
  createTray();
  registerAiIpc();
  registerOcrIpc();

  ipcMain.handle('inspect-it:get-window-state', () => ({
    expanded,
    bubbleState,
    panelSize
  }));

  ipcMain.handle('inspect-it:set-expanded', (_event, nextExpanded) => {
    setExpanded(Boolean(nextExpanded));
    return { expanded };
  });

  ipcMain.handle('inspect-it:set-bounds', (_event, nextBounds) => {
    if (!windowRef || expanded) {
      return;
    }
    const bounds = clampBubbleBounds(nextBounds ?? {});
    bubbleState = bounds;
    writeState();
    windowRef.setBounds(bounds, false);
  });

  ipcMain.handle('inspect-it:focus', () => {
    focusWindow();
  });

  ipcMain.handle('inspect-it:begin-drag', () => {
    dragOrigin = { x: bubbleState.x, y: bubbleState.y };
    return dragOrigin;
  });

  ipcMain.handle('inspect-it:drag-by', (_event, dx, dy) => {
    if (!windowRef || expanded || !dragOrigin) {
      return;
    }
    const bounds = clampBubbleBounds({
      x: dragOrigin.x + (dx ?? 0),
      y: dragOrigin.y + (dy ?? 0)
    });
    bubbleState = bounds;
    writeState();
    windowRef.setBounds(bounds, false);
  });

  ipcMain.handle('inspect-it:panel-resize-by', (_event, dx, dy) => {
    if (!windowRef || !expanded) {
      return;
    }
    const safeDx = Number.isFinite(dx) ? Math.round(dx) : 0;
    const safeDy = Number.isFinite(dy) ? Math.round(dy) : 0;
    const [width, height] = windowRef.getSize();
    const next = clampPanelSize(width + safeDx, height + safeDy);
    panelSize = next;
    const [x, y] = windowRef.getPosition();
    panelPosition = { x, y };
    windowRef.setBounds({ x, y, width: next.width, height: next.height }, false);
    writeState();
  });

  ipcMain.handle('inspect-it:end-drag', () => {
    dragOrigin = null;
  });

  // Cmd+Space is reserved by Spotlight on macOS, so macOS defaults to
  // Control+Space (and falls back to Cmd+Shift+Space if that is also taken).
  const primaryShortcut = process.platform === 'darwin' ? 'Control+Space' : 'CommandOrControl+Space';
  const fallbackShortcut = process.platform === 'darwin' ? 'CommandOrControl+Shift+Space' : null;
  const toggleAction = () => {
    if (expanded) {
      collapseToBubble();
    } else {
      openPanel();
    }
  };
  let shortcutRegistered = globalShortcut.register(primaryShortcut, toggleAction);
  if (!shortcutRegistered && fallbackShortcut) {
    log.warn(`Global shortcut ${primaryShortcut} could not be registered on macOS (Spotlight may own it); trying ${fallbackShortcut}.`);
    shortcutRegistered = globalShortcut.register(fallbackShortcut, toggleAction);
  }
  if (!shortcutRegistered) {
    // Another application owns the shortcut. Never crash; keep the app usable
    // through the bubble and the tray.
    log.warn('Global shortcut could not be registered (another application may own it).');
  }

  ipcMain.handle('inspect-it:get-auto-launch', () => getAutoLaunch());
  ipcMain.handle('inspect-it:set-auto-launch', (_event, enabled) => setAutoLaunch(Boolean(enabled)));
});

app.on('window-all-closed', () => {
  // Standard macOS menu-bar/tray app convention: keep running so the bubble,
  // tray, and global shortcut stay available. The window is normally hidden,
  // not closed, so this only fires on unusual teardown.
  if (process.platform !== 'darwin' && !app.isQuitting) {
    app.quit();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  destroyTray();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('activate', () => {
  if (!windowRef) {
    createWindow();
  }
  focusWindow();
});


/* ---------------------------------------------------------------------------
 * Optional LLM layer: secure credential storage + OpenAI-compatible chat IPC.
 *
 * The API key is encrypted at rest via Electron safeStorage and is only ever
 * read inside the main process; requests are made here, so the key never
 * appears in renderer memory, logs, or results. Provider responses are treated
 * as untrusted data: only their text content is streamed back over IPC.
 * ------------------------------------------------------------------------- */

const aiCredentialFile = () => path.join(app.getPath('userData'), 'ai-credentials.json');
const activeAiRequests = new Map(); // requestId -> { controller, timeout }

function readAiKey() {
  try {
    const raw = fs.readFileSync(aiCredentialFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== 1) return null;
    if (parsed.enc && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(parsed.enc, 'base64'));
    }
    return parsed.plain || null;
  } catch {
    return null;
  }
}

function writeAiKey(key) {
  try {
    const file = aiCredentialFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const record =
      safeStorage.isEncryptionAvailable() && key
        ? { v: 1, enc: safeStorage.encryptString(key).toString('base64') }
        : { v: 1, plain: key || '' };
    fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function safeErrorKind(status) {
  if (status === 401 || status === 403) return 'invalid-key';
  if (status === 404) return 'invalid-base-url';
  if (status === 408) return 'timeout';
  if (status === 413) return 'oversized-request';
  if (status === 429) return 'rate-limit';
  if (status >= 500) return 'provider-unavailable';
  return 'unknown';
}

async function* readSseLines(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        yield line;
      }
    }
    if (buffer) yield buffer;
  } finally {
    reader.releaseLock?.();
  }
}

function extractSseDelta(line) {
  if (!line.startsWith('data:')) return null;
  const data = line.slice(5).replace(/^ /, '');
  if (data === '[DONE]') return { done: true };
  if (!data) return null;
  try {
    const parsed = JSON.parse(data);
    const choice = parsed?.choices?.[0];
    const content = choice?.message?.content ?? choice?.delta?.content;
    if (typeof content === 'string') return { content };
  } catch {
    // Ignore malformed SSE frames (provider output is untrusted).
  }
  return null;
}

function extractPlainContent(json) {
  try {
    const choice = json?.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content === 'string' && content.trim()) return content;
  } catch {
    // Fall through.
  }
  return null;
}

async function performAiChat(sender, requestId, payload) {
  const key = readAiKey();
  if (!key) {
    sender.send('inspect-it:ai-event', {
      requestId,
      type: 'error',
      error: { kind: 'invalid-key', message: 'No API key configured.' }
    });
    return;
  }
  const baseUrl = String(payload.baseUrl || '').trim().replace(/\/+$/, '');
  let endpoint;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
    endpoint = `${baseUrl}/chat/completions`;
  } catch {
    sender.send('inspect-it:ai-event', {
      requestId,
      type: 'error',
      error: { kind: 'configuration', message: 'The provider base URL is invalid.' }
    });
    return;
  }
  const model = String(payload.model || '').trim();
  if (!model) {
    sender.send('inspect-it:ai-event', {
      requestId,
      type: 'error',
      error: { kind: 'configuration', message: 'No model is configured.' }
    });
    return;
  }
  const controller = new AbortController();
  const timeoutMs = Math.min(300000, Math.max(3000, Number(payload.timeoutMs) || 60000));
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  activeAiRequests.set(requestId, { controller, timeout });
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${key}`
  };
  if (payload.organization) headers['openai-organization'] = String(payload.organization);
  if (payload.project) headers['openai-project'] = String(payload.project);
  const body = {
    model,
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    stream: Boolean(payload.stream)
  };
  if (Number.isFinite(Number(payload.maxTokens)) && Number(payload.maxTokens) > 0) {
    body.max_tokens = Number(payload.maxTokens);
  }
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) {
      const kind = safeErrorKind(response.status);
      let detail = '';
      try {
        const text = await response.text();
        const parsed = JSON.parse(text);
        if (typeof parsed?.error?.message === 'string') detail = parsed.error.message;
      } catch {
        // Ignore: provider error bodies are untrusted and optional.
      }
      sender.send('inspect-it:ai-event', {
        requestId,
        type: 'error',
        error: { kind, message: detail ? `${kind}: ${detail}` : kind }
      });
      return;
    }
    if (payload.stream && response.body) {
      let content = '';
      for await (const line of readSseLines(response.body)) {
        const event = extractSseDelta(line);
        if (event?.done) break;
        if (event?.content) {
          content += event.content;
          sender.send('inspect-it:ai-event', { requestId, type: 'delta', text: event.content });
        }
      }
      sender.send('inspect-it:ai-event', { requestId, type: 'done', content });
      return;
    }
    const json = await response.json().catch(() => null);
    const content = extractPlainContent(json);
    if (!content) {
      sender.send('inspect-it:ai-event', {
        requestId,
        type: 'error',
        error: { kind: 'empty-response', message: 'The provider returned an empty response.' }
      });
      return;
    }
    sender.send('inspect-it:ai-event', { requestId, type: 'done', content });
  } catch (error) {
    if (controller.signal.aborted && error?.message === 'timeout') {
      sender.send('inspect-it:ai-event', {
        requestId,
        type: 'error',
        error: { kind: 'timeout', message: 'The AI request timed out.' }
      });
    } else if (controller.signal.aborted) {
      sender.send('inspect-it:ai-event', {
        requestId,
        type: 'error',
        error: { kind: 'cancelled', message: 'The AI request was cancelled.' }
      });
    } else {
      sender.send('inspect-it:ai-event', {
        requestId,
        type: 'error',
        error: { kind: 'connection', message: 'Could not reach the AI provider.' }
      });
    }
  } finally {
    clearTimeout(timeout);
    activeAiRequests.delete(requestId);
  }
}

/* ---------------------------------------------------------------------------
 * Local OCR (tesseract.js) run in the main process (Node). Running OCR here
 * avoids file:// fetch restrictions in the packaged renderer: the worker,
 * WASM, and language data are read from disk / node_modules. Language data is
 * shipped at dist/ocr (copied from public/ocr by Vite); in development the
 * source public/ocr is used.
 * ------------------------------------------------------------------------- */

const ocrLangPath = () => {
  const distPath = path.join(__dirname, '..', 'dist', 'ocr');
  const publicPath = path.join(__dirname, '..', 'public', 'ocr');
  return fs.existsSync(distPath) ? distPath : publicPath;
};

async function runOcr(bytes) {
  try {
    const Tesseract = require('tesseract.js');
    const worker = await Tesseract.createWorker('eng', 1, { langPath: ocrLangPath(), cachePath: path.join(app.getPath('userData'), 'ocr-cache'), errorHandler: () => undefined });
    try {
      const result = await worker.recognize(Buffer.from(bytes ?? []));
      return {
        ok: true,
        text: result?.data?.text ?? '',
        confidence: typeof result?.data?.confidence === 'number' ? result.data.confidence : undefined,
        words: Array.isArray(result?.data?.words) ? result.data.words : undefined
      };
    } finally {
      await worker.terminate().catch(() => undefined);
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'OCR failed' };
  }
}

function registerOcrIpc() {
  ipcMain.handle('inspect-it:ocr', (_event, bytes) => runOcr(bytes));
}

function registerAiIpc() {
  ipcMain.handle('inspect-it:ai-get-key', () => readAiKey());
  ipcMain.handle('inspect-it:ai-set-key', (_event, key) => writeAiKey(typeof key === 'string' ? key : ''));
  ipcMain.handle('inspect-it:ai-clear-key', () => {
    writeAiKey('');
    return true;
  });
  ipcMain.handle('inspect-it:ai-has-key', () => Boolean(readAiKey()));
  ipcMain.handle('inspect-it:ai-chat', (event, payload) => {
    const requestId = String(payload?.requestId || `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    void performAiChat(event.sender, requestId, payload ?? {});
    return { requestId };
  });
  ipcMain.handle('inspect-it:ai-abort', (_event, requestId) => {
    const active = activeAiRequests.get(String(requestId));
    if (active) active.controller.abort();
    return true;
  });
}


