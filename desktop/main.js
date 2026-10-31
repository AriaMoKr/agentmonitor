// agentmonitor as a desktop app, with Electron: the web view in a window of its own, and an icon
// in the system tray with the glyph of what matters most now, a session that needs you above
// all; its menu lists those sessions, and the app's switches. Closed or minimized, the window
// goes to the tray; q in it quits, as in a terminal, and so do Ctrl+Q and the tray's Quit. The
// monitor runs in this process, and serves its web view on this computer only, at a free port
// and a token of its own. The first start adds the app to the Start menu (Windows) or the
// applications menu (Linux), to start it from there with no terminal. It writes only its own
// files: its settings and icons in its folder, and those entries.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { app, BrowserWindow, Menu, nativeImage, nativeTheme, Notification, screen, session, shell, Tray } from 'electron';
import { clock } from '../src/format.js';
import { Monitor } from '../src/monitor.js';
import { serve } from '../src/serve.js';
import { sessionStates } from '../src/viewer.js';
import { appIcon, ico, trayIcon } from './icons.js';
import { desktopEntry } from './launch.js';
import { menuLabel, notices, trayState } from './tray.js';

/** The app's ID: Windows ties its notifications and its Start menu shortcut to it. */
const ID = 'agentmonitor';
const HOUR = 3_600_000;
/** How often the tray is brought up to date (ms): the reads are the web view's, shared. */
const EVERY = 2000;
const platform = process.platform;
/** Started at login: in the tray, the window not shown. */
const hidden = process.argv.includes('--hidden');
/** Started to quit the one running. */
const quit = process.argv.includes('--quit');

/**
 * @typedef {import('./icons.js').Level} Level
 * @typedef {import('./tray.js').TrayState} TrayState
 * @typedef {import('./tray.js').Notice} Notice
 */

/**
 * @typedef {object} Settings what the app keeps from one run to the next, in its folder
 * @property {boolean} notify a notification when a session needs you or ends its turn
 * @property {boolean} minimizeToTray the window minimized goes to the tray, off the taskbar
 * @property {number} zoom the page's zoom level: 0 as it is, each step of 1 a fifth bigger
 * @property {boolean} [launcher] in the Start menu or the applications menu; undefined until the
 *   first start puts it there
 * @property {boolean} [toldTray] whether it was said that a closed window goes on in the tray
 * @property {Electron.Rectangle} [bounds] where the window was, not maximized
 * @property {boolean} [maximized]
 */

/** @type {Settings} */
let settings = { notify: false, minimizeToTray: true, zoom: 0 };
/** @type {BrowserWindow | undefined} */
let win;
/** @type {Tray | undefined} */
let tray;
/** @type {import('../src/serve.js').Served | undefined} */
let served;
let quitting = false;
let shownOnce = false;

const folder = () => app.getPath('userData');
const settingsPath = () => join(folder(), 'settings.json');
const icoPath = () => join(folder(), 'agentmonitor.ico');
const pngPath = () => join(folder(), 'agentmonitor.png');
/** The Start menu's shortcut on Windows; elsewhere the applications menu's entry. */
const launcherPath = () => (platform === 'win32'
  ? join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'agentmonitor.lnk')
  : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'applications', 'agentmonitor.desktop'));
/** Linux's entry that starts it at login. */
const autostartPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'autostart', 'agentmonitor.desktop');
/** What starts the app: Electron, with this folder when it is not packaged, and `args`. */
const command = (/** @type {string[]} */ args) => [process.execPath, ...(app.isPackaged ? [] : [app.getAppPath()]), ...args];

/** @param {string} line */
function log(line) {
  try {
    process.stdout.write(`${line}\n`);
  } catch {
    // Started with no terminal.
  }
}
/** @param {string} what */
const logNow = (what) => log(`${clock(Date.now(), Date.now())}  ${what}`);

process.stdout.on('error', () => {});
if (platform === 'win32') app.setAppUserModelId(ID);
if (!app.requestSingleInstanceLock() || quit) {
  // One runs already: started again, it shows its window (or with --quit, quits), and this one
  // goes. With --quit and none running, there is nothing to do.
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (argv.includes('--quit')) app.quit();
    else if (!argv.includes('--hidden')) show();
  });
  app.on('activate', () => show());
  app.on('before-quit', () => {
    quitting = true;
    keepBounds();
    save();
  });
  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) process.on(signal, () => app.quit());
  app.whenReady().then(start).catch((e) => {
    log(`agentmonitor: could not start: ${/** @type {Error} */ (e).message}`);
    app.exit(1);
  });
}

async function start() {
  settings = load();
  writeIcons();
  Menu.setApplicationMenu(appMenu());
  // The page asks for nothing: no camera, no notifications of its own, no clipboard to read.
  session.defaultSession.setPermissionRequestHandler((_page, _what, answer) => answer(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const dir = resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));
  served = await serve(new Monitor({ dir, windowMs: 24 * HOUR }), {
    host: '127.0.0.1', port: 0, intervalMs: 1000, ascii: false, agents: 'running', showEnded: true, log,
    // q in the window quits, as in a terminal.
    onQuit: () => app.quit(),
  });
  tray = new Tray(trayImage('none'));
  tray.setToolTip('Claude agents');
  tray.on('click', () => show());
  createWindow(`http://127.0.0.1:${served.port}/${served.token}/`);
  if (platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(nativeImage.createFromBuffer(appIcon(512)));
  startLauncher();
  logNow(`reading ${dir}`);
  await update();
  setInterval(() => {
    update().catch((e) => logNow(`error: ${/** @type {Error} */ (e).message}`));
  }, EVERY);
}

/**
 * The window, with the web view's page and nothing else.
 * @param {string} url
 */
function createWindow(url) {
  win = new BrowserWindow({
    width: 1100,
    height: 700,
    ...keptBounds(),
    minWidth: 360,
    minHeight: 200,
    show: false,
    // Started in the tray, the page starts out of sight, and asks only for its title till shown.
    paintWhenInitiallyHidden: !hidden,
    title: 'Claude agents',
    icon: platform === 'win32' ? icoPath() : platform === 'linux' ? pngPath() : undefined,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  const page = win.webContents;
  // No other address in it, and no other window.
  page.setWindowOpenHandler(() => ({ action: 'deny' }));
  page.on('will-navigate', (e, to) => {
    if (!to.startsWith(url)) e.preventDefault();
  });
  page.on('did-finish-load', () => page.setZoomLevel(settings.zoom));
  page.on('render-process-gone', (_e, d) => logNow(`the page's process ended: ${d.reason}`));
  win.once('ready-to-show', () => {
    if (!hidden) show();
  });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    toTray();
  });
  win.on('minimize', () => {
    if (settings.minimizeToTray && platform !== 'darwin') toTray();
  });
  win.loadURL(url);
}

/** The window shown, in front: restored if it was minimized, maximized if it was at the last quit. */
function show() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  if (!shownOnce && settings.maximized) win.maximize();
  shownOnce = true;
  win.focus();
}

/** The window hidden, the app going on in the tray; on Windows, said once. */
function toTray() {
  if (!win) return;
  keepBounds();
  win.hide();
  if (!settings.toldTray && tray && platform === 'win32') {
    tray.displayBalloon({ iconType: 'info', title: 'agentmonitor goes on here', content: 'Its icon shows when a session needs you. Quit is in its menu.' });
  }
  settings.toldTray = true;
  save();
}

/** Where the window was, to open there again: when a screen still shows enough of it. */
function keptBounds() {
  const b = settings.bounds;
  if (!b) return {};
  const area = screen.getDisplayMatching(b).workArea;
  const w = Math.min(b.x + b.width, area.x + area.width) - Math.max(b.x, area.x);
  const h = Math.min(b.y + b.height, area.y + area.height) - Math.max(b.y, area.y);
  return w >= 100 && h >= 60 ? b : {};
}

function keepBounds() {
  if (!win || win.isDestroyed() || win.isFullScreen()) return;
  settings.maximized = win.isMaximized();
  settings.bounds = win.getNormalBounds();
}

/** The menus of the window: the keys that zoom it, close it to the tray and quit; text to copy. */
function appMenu() {
  const zoom = (/** @type {number | null} */ by) => () => {
    settings.zoom = by === null ? 0 : Math.max(-4, Math.min(6, settings.zoom + by));
    win?.webContents.setZoomLevel(settings.zoom);
    save();
  };
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...(platform === 'darwin' ? [/** @type {Electron.MenuItemConstructorOptions} */ ({ role: 'appMenu' })] : []),
    {
      label: '&File',
      submenu: [
        { label: 'Close to the Tray', accelerator: 'CmdOrCtrl+W', click: () => toTray() },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    { role: 'editMenu' },
    {
      label: '&View',
      submenu: [
        { label: 'Bigger', accelerator: 'CmdOrCtrl+=', click: zoom(0.5) },
        { label: 'Smaller', accelerator: 'CmdOrCtrl+-', click: zoom(-0.5) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: zoom(null) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

/** @type {Map<string, Electron.NativeImage>} */
const images = new Map();

/**
 * An image drawn for each scale a screen can have, so that one at 150% gets one drawn at that
 * size rather than one stretched.
 * @param {string} name what it is kept by
 * @param {(size: number) => Buffer} make the PNG at a size
 * @param {number} size at a scale of 1
 */
function image(name, make, size) {
  let img = images.get(name);
  if (!img) {
    img = nativeImage.createEmpty();
    for (const scaleFactor of [1, 1.25, 1.5, 2]) img.addRepresentation({ scaleFactor, buffer: make(Math.round(size * scaleFactor)) });
    images.set(name, img);
  }
  return img;
}

const trayImage = (/** @type {Level} */ level) => image(`tray-${level}`, (size) => trayIcon(level, size), 16);

/** The app's icon as files: ICO for the Start menu's shortcut and the window, PNG for Linux's entries. */
function writeIcons() {
  mkdirSync(folder(), { recursive: true });
  writeFileSync(icoPath(), ico([16, 20, 24, 32, 40, 48, 64, 128, 256].map((size) => ({ size, png: appIcon(size) }))));
  writeFileSync(pngPath(), appIcon(256));
}

/** Each session's state as the tray last saw it: a change can be worth a notification. */
let before = new Map();
/** What the tray shows now, so that it is drawn again only when that changes. */
let drawn = '';
let lastCounts = '';

/** The tray brought up to date with the latest read; the notifications, when on, of what changed. */
async function update() {
  const snap = await served?.snapshot();
  if (!snap || !tray) return;
  const state = trayState(snap, Date.now());
  const fresh = notices(before, snap);
  before = sessionStates(snap);
  const key = JSON.stringify([state, settings.notify, settings.minimizeToTray, settings.launcher]);
  if (key !== drawn) {
    drawn = key;
    showState(state);
  }
  if (settings.notify) fresh.forEach(notify);
}

/** @param {TrayState} state */
function showState(state) {
  if (!tray) return;
  tray.setImage(trayImage(state.level));
  tray.setToolTip(state.tooltip);
  tray.setContextMenu(trayMenu(state));
  // How many need you: next to the icon on a Mac, on the taskbar's button on Windows, a badge elsewhere.
  if (platform === 'darwin') tray.setTitle(state.needs ? String(state.needs) : '');
  if (platform === 'win32') win?.setOverlayIcon(state.needs ? trayImage('waiting') : null, state.needs ? `${state.needs} need you` : '');
  else app.setBadgeCount(state.needs);
  if (state.counts !== lastCounts) logNow(state.counts);
  lastCounts = state.counts;
}

/**
 * The tray's menu: the window; the sessions that need you, and those unread; the counts and the
 * plan's usage; the switches; Quit.
 * @param {TrayState} state
 */
function trayMenu(state) {
  const label = (/** @type {string} */ s) => menuLabel(s, platform);
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const items = [
    { label: 'Show Claude agents', click: () => show() },
    { type: 'separator' },
    ...state.listed.map((s) => ({ label: label(s.label), click: () => show() })),
    ...(state.listed.length ? [/** @type {Electron.MenuItemConstructorOptions} */ ({ type: 'separator' })] : []),
    { label: label(state.counts), enabled: false },
  ];
  if (state.usage) items.push({ label: label(state.usage), enabled: false });
  items.push(
    { type: 'separator' },
    { label: 'Notify when a session needs you or ends its turn', type: 'checkbox', checked: settings.notify, click: (item) => change({ notify: item.checked }) },
  );
  if (platform !== 'darwin') {
    items.push(
      { label: 'Minimize to the tray', type: 'checkbox', checked: settings.minimizeToTray, click: (item) => change({ minimizeToTray: item.checked }) },
      { label: 'Start at login, in the tray', type: 'checkbox', checked: startsAtLogin(), click: (item) => startAtLogin(item.checked) },
      { label: platform === 'win32' ? 'In the Start menu' : 'In the applications menu', type: 'checkbox', checked: existsSync(launcherPath()), click: (item) => setLauncher(item.checked) },
    );
  }
  items.push({ type: 'separator' }, { label: 'Quit', click: () => app.quit() });
  return Menu.buildFromTemplate(items);
}

/**
 * Settings changed from the menu: kept, and the menu drawn again.
 * @param {Partial<Settings>} to
 */
function change(to) {
  Object.assign(settings, to);
  save();
  drawn = '';
  update().catch(() => {});
}

/** @type {Set<Notification>} the notifications shown, kept from the garbage collector till they close */
const notes = new Set();

/** @param {Notice} n */
function notify(n) {
  if (!Notification.isSupported()) return;
  const note = new Notification({ title: n.title, body: n.body, icon: image('app', appIcon, 32) });
  notes.add(note);
  note.on('click', () => show());
  note.on('close', () => notes.delete(note));
  note.on('failed', (_e, error) => {
    notes.delete(note);
    logNow(`a notification failed: ${error}`);
  });
  note.show();
  logNow(`notified: ${n.title}: ${n.body}`);
  // Not every one says when it closed.
  setTimeout(() => notes.delete(note), 10 * 60_000).unref();
}

/**
 * Whether it starts at login: Windows' Run key, as Electron keeps it, or Linux's autostart entry.
 * On a Mac it would start Electron alone, not packaged, so it is not offered there.
 */
function startsAtLogin() {
  if (platform !== 'win32') return existsSync(autostartPath());
  const [path, ...args] = command(['--hidden']);
  return app.getLoginItemSettings({ path, args }).openAtLogin;
}

/** @param {boolean} on */
function startAtLogin(on) {
  if (platform === 'win32') {
    const [path, ...args] = command(['--hidden']);
    app.setLoginItemSettings({ openAtLogin: on, path, args });
  } else {
    writeOrRemove(autostartPath(), on ? desktopEntry(command(['--hidden']), pngPath()) : '');
  }
  change({});
}

/**
 * Into the Start menu or the applications menu, or out of it.
 * @param {boolean} on
 */
function setLauncher(on) {
  if (platform === 'win32' && on) {
    const ok = shell.writeShortcutLink(launcherPath(), 'create', {
      target: process.execPath,
      args: app.isPackaged ? '' : `"${app.getAppPath()}"`,
      cwd: app.isPackaged ? dirname(process.execPath) : app.getAppPath(),
      description: 'The Claude agents on this computer',
      icon: icoPath(),
      iconIndex: 0,
      appUserModelId: ID,
    });
    if (!ok) logNow(`could not write ${launcherPath()}`);
  } else if (platform === 'win32') {
    rmSync(launcherPath(), { force: true });
  } else {
    writeOrRemove(launcherPath(), on ? desktopEntry(command([]), pngPath()) : '');
  }
  change({ launcher: on });
}

/**
 * At a start: into the menu the first time; after, kept up to date there (where Electron is, the
 * icon), unless it was taken out.
 */
function startLauncher() {
  if (platform === 'darwin') return;
  if (settings.launcher === undefined || (settings.launcher && existsSync(launcherPath()))) setLauncher(true);
  else if (settings.launcher) change({ launcher: false });
}

/**
 * @param {string} path
 * @param {string} text written there; when '', the file taken out
 */
function writeOrRemove(path, text) {
  if (!text) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** The settings as kept, those that are not as they should be left as they start. */
function load() {
  /** @type {Settings} */
  const s = { notify: false, minimizeToTray: true, zoom: 0 };
  /** @type {any} */
  let o;
  try {
    o = JSON.parse(readFileSync(settingsPath(), 'utf8'));
  } catch {
    return s;
  }
  if (!o || typeof o !== 'object') return s;
  for (const k of /** @type {const} */ (['notify', 'minimizeToTray', 'launcher', 'toldTray', 'maximized'])) {
    if (typeof o[k] === 'boolean') s[k] = o[k];
  }
  if (Number.isFinite(o.zoom)) s.zoom = Math.max(-4, Math.min(6, o.zoom));
  const b = o.bounds;
  if (b && ['x', 'y', 'width', 'height'].every((k) => Number.isInteger(b[k])) && b.width >= 200 && b.height >= 120) {
    s.bounds = { x: b.x, y: b.y, width: b.width, height: b.height };
  }
  return s;
}

function save() {
  try {
    mkdirSync(folder(), { recursive: true });
    writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`);
  } catch (e) {
    logNow(`could not keep the settings: ${/** @type {Error} */ (e).message}`);
  }
}
