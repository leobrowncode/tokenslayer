import path from 'node:path';
import {
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  app,
  clipboard,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  shell,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron';
import { AlertTracker, topLevel } from '../core/advisor';
import { type Config, loadConfig, saveConfig } from '../core/config';
import { formatTokens } from '../core/format';
import { iconPNG } from '../core/icon';
import { collectSnapshot, createProviders } from '../core/snapshot';
import { type Rect, snapToTaskbar, stripPosition } from '../core/taskbar';
import type { Advice, AlertLevel, OverlaySnapshot } from '../core/types';
import type { OverlayMode, OverlayUpdate } from '../shared/api';

const APP_ID = 'com.tokenslayer.overlay';
const configFile = process.env.TOKENSLAYER_CONFIG || path.join(app.getPath('userData'), 'config.json');
const STRIP_SIZE = { width: 160, height: 26 };

let config: Config;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let timer: NodeJS.Timeout | null = null;
let topmostTimer: NodeJS.Timeout | null = null;
let busy = false;
let quitting = false;
let last: OverlaySnapshot | null = null;
/** Where the panel's top-left should stay while its height follows the content. */
let anchor = { x: 0, y: 0 };
/** Size of the rendered content, reported by the renderer. */
let content = { width: 0, height: 0 };
let drag: { x: number; y: number; moved: boolean } | null = null;
const providers = createProviders();
const tracker = new AlertTracker();
const iconCache = new Map<string, NativeImage>();

const mode = (): OverlayMode => (config.overlay.mode === 'panel' ? 'panel' : 'taskbar');

function icon(size: number, level: AlertLevel | 'idle'): NativeImage {
  const key = `${size}:${level}`;
  let img = iconCache.get(key);
  if (!img) {
    img = nativeImage.createFromBuffer(iconPNG(size, level));
    iconCache.set(key, img);
  }
  return img;
}

function persist(): void {
  try {
    saveConfig(configFile, config);
  } catch (err) {
    console.error('[tokenslayer] failed to save config', err);
  }
}

function payload(): OverlayUpdate {
  const o = config.overlay;
  return {
    snapshot: last,
    ui: {
      mode: mode(),
      expanded: o.expanded,
      clickThrough: o.clickThrough,
      showUndetected: o.showUndetected,
      toggleShortcut: o.toggleShortcut,
      clickThroughShortcut: o.clickThroughShortcut,
    },
  };
}

function pushUpdate(): void {
  if (win && !win.isDestroyed()) win.webContents.send('overlay:update', payload());
}

function panelPosition(width: number): { x: number; y: number } {
  const { x, y } = config.overlay;
  if (x !== null && y !== null) {
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return x >= a.x - width + 40 && x <= a.x + a.width - 40 && y >= a.y && y <= a.y + a.height - 30;
    });
    if (visible) return { x, y };
  }
  const a = screen.getPrimaryDisplay().workArea;
  return { x: a.x + a.width - width - 16, y: a.y + 16 };
}

/** The strip may sit on the taskbar, so it is checked against full display bounds, not work areas. */
function stripPlacement(size: { width: number; height: number }): { x: number; y: number } {
  const t = config.overlay.taskbar;
  if (t.right !== null && t.y !== null) {
    const right = t.right;
    const y = t.y;
    const visible = screen.getAllDisplays().some((d) => {
      const b = d.bounds;
      return right >= b.x + 40 && right - size.width <= b.x + b.width - 40 && y >= b.y && y + size.height <= b.y + b.height;
    });
    if (visible) return { x: right - size.width, y };
  }
  const d = screen.getPrimaryDisplay();
  return stripPosition(d.bounds, d.workArea, size, t.rightMargin);
}

function stripSize(): { width: number; height: number } {
  return {
    width: Math.round(Math.max(40, Math.min(1200, content.width || STRIP_SIZE.width))),
    height: Math.round(Math.max(18, Math.min(60, content.height || STRIP_SIZE.height))),
  };
}

function targetBounds(): Rect {
  if (mode() === 'taskbar') {
    const size = stripSize();
    return { ...stripPlacement(size), ...size };
  }
  const height = Math.round(Math.max(36, Math.min(900, content.height || 120)));
  return { ...anchor, width: config.overlay.width, height };
}

function placeWindow(): void {
  if (!win || drag) return;
  const b = targetBounds();
  const cur = win.getBounds();
  if (cur.x === b.x && cur.y === b.y && cur.width === b.width && cur.height === b.height) return;
  // setSize is ignored for non-resizable windows on some platforms; setBounds is not.
  win.setBounds(b);
}

function raiseToTop(): void {
  if (!win || !win.isVisible()) return;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.moveTop();
}

/** Clicking the Windows taskbar lifts it above other topmost windows, so the strip re-asserts itself. */
function updateTopmostTimer(): void {
  if (topmostTimer) clearInterval(topmostTimer);
  topmostTimer = null;
  if (process.platform === 'win32' && mode() === 'taskbar') topmostTimer = setInterval(() => {
      if (!drag) raiseToTop();
    }, 1500);
}

function createWindow(): void {
  anchor = panelPosition(config.overlay.width);
  const initial = mode() === 'taskbar' ? { ...stripPlacement(STRIP_SIZE), ...STRIP_SIZE } : { ...anchor, width: config.overlay.width, height: 120 };
  win = new BrowserWindow({
    ...initial,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    title: 'TokenSlayer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setOpacity(Math.max(0.3, Math.min(1, config.overlay.opacity)));
  applyClickThrough();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win?.showInactive());

  let moveTimer: NodeJS.Timeout | null = null;
  win.on('moved', () => {
    if (mode() !== 'panel') return;
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (!win || mode() !== 'panel') return;
      const [x, y] = win.getPosition();
      if (Math.abs(x - anchor.x) <= 2 && Math.abs(y - anchor.y) <= 2) return;
      anchor = { x, y };
      config.overlay.x = x;
      config.overlay.y = y;
      persist();
    }, 400);
  });
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
      rebuildMenu();
    }
  });
}

function applyClickThrough(): void {
  win?.setIgnoreMouseEvents(config.overlay.clickThrough, { forward: true });
}

function setClickThrough(v: boolean): void {
  config.overlay.clickThrough = v;
  applyClickThrough();
  persist();
  pushUpdate();
  rebuildMenu();
}

function setMode(m: OverlayMode): void {
  if (mode() === m) return;
  config.overlay.mode = m;
  persist();
  content = { width: 0, height: 0 };
  if (m === 'panel') anchor = panelPosition(config.overlay.width);
  updateTopmostTimer();
  placeWindow();
  pushUpdate();
  rebuildMenu();
}

function showOverlay(): void {
  if (!win) return;
  win.showInactive();
  raiseToTop();
  rebuildMenu();
}

function toggleOverlay(): void {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else showOverlay();
  rebuildMenu();
}

function modeItems(): MenuItemConstructorOptions[] {
  return [
    { label: 'Taskbar strip (tokens only)', type: 'radio', checked: mode() === 'taskbar', click: () => setMode('taskbar') },
    { label: 'Detailed panel', type: 'radio', checked: mode() === 'panel', click: () => setMode('panel') },
  ];
}

function rebuildMenu(): void {
  if (!tray) return;
  const o = config.overlay;
  const login = process.platform === 'win32' || process.platform === 'darwin' ? app.getLoginItemSettings().openAtLogin : false;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show overlay', type: 'checkbox', checked: Boolean(win?.isVisible()), accelerator: o.toggleShortcut, click: toggleOverlay },
      ...modeItems(),
      {
        label: 'Expanded panel',
        type: 'checkbox',
        checked: o.expanded,
        visible: mode() === 'panel',
        click: (item) => {
          config.overlay.expanded = item.checked;
          persist();
          pushUpdate();
        },
      },
      { type: 'separator' },
      {
        label: 'Click-through (lock overlay)',
        type: 'checkbox',
        checked: o.clickThrough,
        accelerator: o.clickThroughShortcut,
        click: (item) => setClickThrough(item.checked),
      },
      {
        label: 'Desktop notifications',
        type: 'checkbox',
        checked: config.notifications,
        click: (item) => {
          config.notifications = item.checked;
          persist();
        },
      },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: login,
        visible: process.platform === 'win32' || process.platform === 'darwin',
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
      },
      { type: 'separator' },
      { label: 'Refresh now', click: () => void tick(true) },
      { label: 'Reset position', click: resetPosition },
      { label: 'Open config file', click: () => void shell.openPath(configFile) },
      { label: 'Reload config', click: reloadConfig },
      { type: 'separator' },
      {
        label: 'Quit TokenSlayer',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function resetPosition(): void {
  config.overlay.x = null;
  config.overlay.y = null;
  config.overlay.taskbar.right = null;
  config.overlay.taskbar.y = null;
  persist();
  anchor = panelPosition(config.overlay.width);
  placeWindow();
  showOverlay();
}

function reloadConfig(): void {
  config = loadConfig(configFile);
  win?.setOpacity(Math.max(0.3, Math.min(1, config.overlay.opacity)));
  anchor = panelPosition(config.overlay.width);
  content = { width: 0, height: 0 };
  applyClickThrough();
  registerShortcuts();
  schedule();
  updateTopmostTimer();
  placeWindow();
  pushUpdate();
  rebuildMenu();
  void tick(true);
}

function registerShortcuts(): void {
  globalShortcut.unregisterAll();
  const reg = (accel: string, fn: () => void) => {
    if (!accel) return;
    try {
      if (!globalShortcut.register(accel, fn)) console.warn(`[tokenslayer] shortcut ${accel} is taken`);
    } catch (err) {
      console.warn(`[tokenslayer] invalid shortcut ${accel}`, err);
    }
  };
  reg(config.overlay.toggleShortcut, toggleOverlay);
  reg(config.overlay.clickThroughShortcut, () => setClickThrough(!config.overlay.clickThrough));
}

function trayTooltip(s: OverlaySnapshot): string {
  const used = s.providers.filter((p) => p.inUse);
  const lines = ['TokenSlayer: tokens today'];
  for (const p of used) {
    const c = p.chats[0];
    lines.push(`${p.name}: ${formatTokens(p.tokensToday)}${c ? ` (${Math.round(c.contextPercent)}% context)` : ''}`);
  }
  if (!used.length) lines.push('No AI tool in use');
  if (s.advice[0]) lines.push(s.advice[0].level === 'newChat' ? 'Start a new chat!' : 'Compact your chat');
  const text = lines.join('\n');
  return text.length > 127 ? `${text.slice(0, 124)}...` : text;
}

function notifyAdvice(a: Advice): void {
  if (!Notification.isSupported()) return;
  const title = a.level === 'newChat' ? `${a.providerName}: start a new chat` : `${a.providerName}: compact this chat`;
  const n = new Notification({
    title,
    body: `${a.chatTitle ? `${a.chatTitle}: ` : ''}${a.message}`,
    icon: icon(64, a.level),
  });
  n.on('click', () => {
    showOverlay();
    win?.webContents.send('overlay:open-advice');
  });
  n.show();
}

async function tick(force = false): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const snap = await collectSnapshot(providers, config, { forceNetwork: force });
    const { visible, notify } = tracker.process(snap.advice);
    snap.advice = visible;
    snap.topLevel = topLevel(visible);
    last = snap;
    pushUpdate();
    if (tray) {
      const anyChat = snap.providers.some((p) => p.chats.length);
      tray.setImage(icon(32, snap.topLevel !== 'ok' ? snap.topLevel : anyChat ? 'ok' : 'idle'));
      tray.setToolTip(trayTooltip(snap));
    }
    if (config.notifications) notify.forEach(notifyAdvice);
  } catch (err) {
    console.error('[tokenslayer] collect failed', err);
  } finally {
    busy = false;
  }
}

function schedule(): void {
  if (timer) clearInterval(timer);
  timer = setInterval(() => void tick(), Math.max(2, config.pollIntervalSeconds) * 1000);
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function onDrag(phase: unknown, dx: unknown, dy: unknown): void {
  if (!win || mode() !== 'taskbar' || config.overlay.clickThrough) return;
  if (phase === 'start') {
    const [x, y] = win.getPosition();
    drag = { x, y, moved: false };
    return;
  }
  if (!drag || !finite(dx) || !finite(dy)) return;
  if (phase === 'move') {
    if (!drag.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    drag.moved = true;
    win.setPosition(Math.round(drag.x + dx), Math.round(drag.y + dy));
    return;
  }
  if (phase === 'end') {
    const moved = drag.moved;
    drag = null;
    if (!moved) return;
    const b = win.getBounds();
    const d = screen.getDisplayMatching(b);
    config.overlay.taskbar.right = b.x + b.width;
    config.overlay.taskbar.y = snapToTaskbar(d.bounds, d.workArea, b);
    persist();
    placeWindow();
  }
}

function registerIpc(): void {
  ipcMain.on('overlay:ready', () => pushUpdate());
  ipcMain.on('overlay:resize', (_e, width: unknown, height: unknown) => {
    if (!finite(width) || !finite(height)) return;
    content = { width: Math.ceil(width), height: Math.ceil(height) };
    placeWindow();
  });
  ipcMain.on('overlay:drag', (_e, phase: unknown, dx: unknown, dy: unknown) => onDrag(phase, dx, dy));
  ipcMain.on('overlay:copy', (_e, text: unknown) => {
    if (typeof text === 'string' && text.length < 200) clipboard.writeText(text);
  });
  ipcMain.on('overlay:set-expanded', (_e, v: unknown) => {
    config.overlay.expanded = Boolean(v);
    persist();
    pushUpdate();
    rebuildMenu();
  });
  ipcMain.on('overlay:dismiss', (_e, a: any) => {
    if (!a || typeof a.chatId !== 'string') return;
    tracker.dismiss(a);
    if (last) {
      last.advice = last.advice.filter((x) => !(x.provider === a.provider && x.chatId === a.chatId));
      last.topLevel = topLevel(last.advice);
      pushUpdate();
    }
  });
  ipcMain.on('overlay:hide', () => {
    win?.hide();
    rebuildMenu();
  });
  ipcMain.on('overlay:menu', () => {
    if (!tray || !win) return;
    const menu = Menu.buildFromTemplate([
      ...modeItems(),
      { type: 'separator' },
      { label: 'Refresh now', click: () => void tick(true) },
      { label: 'Click-through (lock overlay)', click: () => setClickThrough(true) },
      { label: 'Reset position', click: resetPosition },
      { label: 'Hide overlay', click: () => toggleOverlay() },
      { label: 'Open config file', click: () => void shell.openPath(configFile) },
      { type: 'separator' },
      { label: 'Quit TokenSlayer', click: () => ((quitting = true), app.quit()) },
    ]);
    menu.popup({ window: win });
  });
}

if (process.platform === 'linux') app.commandLine.appendSwitch('enable-transparent-visuals');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showOverlay);
  app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID);
    config = loadConfig(configFile);
    registerIpc();
    createWindow();
    tray = new Tray(icon(32, 'idle'));
    tray.setToolTip('TokenSlayer');
    tray.on('click', toggleOverlay);
    rebuildMenu();
    registerShortcuts();
    schedule();
    updateTopmostTimer();
    screen.on('display-metrics-changed', placeWindow);
    screen.on('display-added', placeWindow);
    screen.on('display-removed', placeWindow);
    void tick(true);
  });
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => {
    /* keep running in the tray */
  });
}
