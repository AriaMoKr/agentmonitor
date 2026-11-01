// agentmonitor as a desktop app, with Electron: the web view in a window of its own, and an icon
// in the system tray with the glyph of what matters most now, a session that needs you above
// all, or in another look the sessions' glyphs, the plan's usage round it, a turning glyph while
// one works, or how many need you. A click on it shows the flyout, the web view again, small, by
// the tray; its menu lists those sessions, and the app's switches. On Windows the window's
// taskbar button has the plan's usage as its bar and how many need you on its icon, a button for
// each session under its preview, and the sessions in its jump list; it flashes when a session
// needs you or ends its turn, or with the window in the tray the tray icon does. Closed or
// minimized, the window goes to the tray; q in it quits, as in a terminal, and so do Ctrl+Q and
// the tray's Quit. The monitor runs in this process, and serves its web view on this computer
// only, at a free port and a token of its own. The first start adds the app to the Start menu
// (Windows) or the applications menu (Linux), to start it from there with no terminal. It writes
// only its own files: its settings and icons in its folder, and those entries.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { app, BrowserWindow, Menu, nativeImage, nativeTheme, Notification, screen, session, shell, Tray } from 'electron';
import { clock } from '../src/format.js';
import { Monitor } from '../src/monitor.js';
import { serve } from '../src/serve.js';
import { sessionStates } from '../src/viewer.js';
import { appIco, appIcon, countIcon, donutIcon, glyphIco, sessionsIcon, tileIcon, trayIcon, TURNS, turningIcon, usageIcon } from './icons.js';
import { desktopEntry } from './launch.js';
import { buttonsOf, flyoutBounds, gaugeOf, jumpListOf, openArg, openSwitch, overlayOf, thumbnailClip } from './taskbar.js';
import { menuLabel, notices, trayState } from './tray.js';

/**
 * The app's ID, its name: Windows ties its taskbar button, jump list, notifications and Start
 * menu shortcut to it.
 */
const ID = app.getName();
const HOUR = 3_600_000;
/** How often the tray is brought up to date (ms): the reads are the web view's, shared. */
const EVERY = 2000;
/** How often the tray icon moves while it turns or flashes (ms): a turn takes TURNS of these. */
const TICK = 125;
/** How long the tray icon flashes (ms), and each flash. */
const FLASH_FOR = 8000;
const FLASH_STEP = 500;
/** How often the jump list is written at most (ms): Windows keeps it on disk. */
const JUMP_EVERY = 10_000;
/** The pages' IDs, which the app names to act on them: its window's and its flyout's. */
const WINDOW_PAGE = 'agentmonitor-window';
const FLYOUT_PAGE = 'agentmonitor-flyout';
/** The flyout's size, for its page at a zoom of 0. */
const FLYOUT_SIZE = { width: 600, height: 400 };
/** The images kept drawn at most: those used longest ago go first. */
const MAX_IMAGES = 200;
const platform = process.platform;
/** Started at login: in the tray, the window not shown. */
const hidden = process.argv.includes('--hidden');
/** Started to quit the one running. */
const quit = process.argv.includes('--quit');

/**
 * @typedef {import('./icons.js').Level} Level
 * @typedef {import('./tray.js').TrayState} TrayState
 * @typedef {import('./tray.js').Notice} Notice
 * @typedef {import('./taskbar.js').Gauge} Gauge
 * @typedef {import('./taskbar.js').Overlay} Overlay
 * @typedef {'glyph' | 'turning' | 'sessions' | 'usage' | 'count'} Look what the tray icon draws
 */

/** The tray icon's looks, as its menu offers them. @type {[Look, string][]} */
const LOOKS = [
  ['glyph', 'What matters most'],
  ['turning', 'What matters most, turning while one is at work'],
  ['sessions', 'A glyph for each session, up to four'],
  ['usage', 'What matters most, in a ring of the plan\'s usage'],
  ['count', 'How many need you, else what matters most'],
];

/**
 * @typedef {object} Settings what the app keeps from one run to the next, in its folder
 * @property {boolean} notify a notification when a session needs you or ends its turn
 * @property {boolean} flash then the taskbar button flashes, or with the window in the tray the
 *   tray icon does
 * @property {Look} trayIcon what the tray icon draws
 * @property {boolean} minimizeToTray the window minimized goes to the tray, off the taskbar
 * @property {number} zoom the page's zoom level: 0 as it is, each step of 1 a fifth bigger
 * @property {boolean} [launcher] in the Start menu or the applications menu; undefined until the
 *   first start puts it there
 * @property {boolean} [toldTray] whether it was said that a closed window goes on in the tray
 * @property {Electron.Rectangle} [bounds] where the window was, not maximized
 * @property {boolean} [maximized]
 */

/** @type {Settings} */
const DEFAULTS = { notify: false, flash: true, trayIcon: 'sessions', minimizeToTray: true, zoom: 0 };
/** @type {Settings} */
let settings = { ...DEFAULTS };
/** @type {BrowserWindow | undefined} */
let win;
/** @type {BrowserWindow | undefined} the tray's flyout, made at its first showing */
let flyout;
/** @type {Tray | undefined} */
let tray;
/** @type {import('../src/serve.js').Served | undefined} */
let served;
/** The web view's address: the window's page and the flyout's are it, each with its ID. */
let base = '';
let quitting = false;
let shownOnce = false;
/** Whether the flyout is to show: not after a double click that showed the window, its page drawn after. */
let flyoutWanted = false;
/** When the flyout last hid: the click on the tray icon that hid it, taking its focus, does not show it again. */
let flyoutHidAt = 0;

const folder = () => app.getPath('userData');
const settingsPath = () => join(folder(), 'settings.json');
const icoPath = () => join(folder(), 'agentmonitor.ico');
const pngPath = () => join(folder(), 'agentmonitor.png');
/** A glyph as ICO, for the jump list's items. */
const glyphIcoPath = (/** @type {Level} */ level) => join(folder(), `${level}.ico`);
/** The Start menu's shortcut on Windows; elsewhere the applications menu's entry. */
const launcherPath = () => (platform === 'win32'
  ? join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${ID}.lnk`)
  : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'applications', `${ID}.desktop`));
/** Linux's entry that starts it at login. */
const autostartPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'autostart', `${ID}.desktop`);
/** What starts the app: Electron, with this folder when it is not packaged, and `args`. */
const command = (/** @type {string[]} */ args) => [process.execPath, ...(app.isPackaged ? [] : [app.getAppPath()]), ...args];
/** The arguments that start the app, as one line: this folder in quotes where it is not packaged, then `args`. */
const launchArgs = (/** @type {string[]} */ args) => [...(app.isPackaged ? [] : [`"${app.getAppPath()}"`]), ...args].join(' ');

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
  // One runs already: started again, it shows its window (or with --quit, quits; with --open, opens
  // that session in it), and this one goes. With --quit and none running, there is nothing to do.
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const key = openArg(argv);
    if (argv.includes('--quit')) app.quit();
    else if (key) openInWindow(key);
    else if (!argv.includes('--hidden')) show();
  });
  app.on('activate', () => show());
  app.on('before-quit', () => {
    quitting = true;
    keepBounds();
    save();
    // The jump list Windows' own again: its sessions would go stale.
    if (platform === 'win32' && served) app.setJumpList(null);
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
    // q in the window or the flyout quits, as in a terminal.
    onQuit: () => app.quit(),
    // A session opened in the flyout opens in the window.
    elsewhere: { [FLYOUT_PAGE]: (key) => openInWindow(key) },
  });
  base = `http://127.0.0.1:${served.port}/${served.token}/`;
  tray = new Tray(trayImage('none'));
  tray.setToolTip('Claude agents');
  // A click shows the flyout (on a Mac, the window, as the menu is its click); a double click, the window.
  tray.on('click', () => (platform === 'darwin' ? show() : toggleFlyout()));
  tray.on('double-click', () => {
    hideFlyout();
    show();
  });
  // Started from the jump list, to open a session.
  const asked = openArg(process.argv);
  if (asked) served.open(WINDOW_PAGE, asked);
  createWindow();
  if (platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(nativeImage.createFromBuffer(appIcon(512)));
  startLauncher();
  logNow(`reading ${dir}`);
  await update();
  setInterval(() => {
    update().catch((e) => logNow(`error: ${/** @type {Error} */ (e).message}`));
  }, EVERY);
}

/**
 * A window's page kept to the web view: no other address in it, and no other window.
 * @param {Electron.WebContents} page
 */
function guard(page) {
  page.setWindowOpenHandler(() => ({ action: 'deny' }));
  page.on('will-navigate', (e, to) => {
    if (!to.startsWith(base)) e.preventDefault();
  });
  page.on('did-finish-load', () => page.setZoomLevel(settings.zoom));
  page.on('render-process-gone', (_e, d) => logNow(`a page's process ended: ${d.reason}`));
}

/** The window, with the web view's page and nothing else. */
function createWindow() {
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
  guard(win.webContents);
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
  // A taskbar button made again, the window shown from the tray, has nothing on it till drawn again.
  win.on('show', () => setTimeout(repaint, 300));
  win.on('focus', () => win?.flashFrame(false));
  win.on('resize', () => clip());
  win.loadURL(`${base}?page=${WINDOW_PAGE}`);
}

/** The window shown, in front: restored if it was minimized, maximized if it was at the last quit. */
function show() {
  if (!win) return;
  stopFlashing();
  if (win.isMinimized()) win.restore();
  win.show();
  if (!shownOnce && settings.maximized) win.maximize();
  shownOnce = true;
  win.focus();
}

/**
 * A session or an agent opened in the window: from the flyout, a button under the window's
 * preview, the jump list or the tray's menu.
 * @param {string} key
 */
function openInWindow(key) {
  hideFlyout();
  served?.open(WINDOW_PAGE, key);
  show();
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

/** The flyout shown, or hidden where it shows: a click on the tray icon. */
function toggleFlyout() {
  stopFlashing();
  if (flyout?.isVisible()) hideFlyout();
  else if (Date.now() - flyoutHidAt > 400) showFlyout();
}

/** The flyout by the tray icon, in front; made the first time, and shown once its page is drawn. */
function showFlyout() {
  if (!tray || !served) return;
  const made = !flyout;
  const f = (flyout ??= createFlyout());
  const icon = platform === 'linux' ? { x: 0, y: 0, width: 0, height: 0 } : tray.getBounds();
  const pointer = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(icon.width ? { x: icon.x, y: icon.y } : pointer).workArea;
  const z = 1.2 ** settings.zoom;
  f.setBounds(flyoutBounds(icon, area, { width: Math.round(FLYOUT_SIZE.width * z), height: Math.round(FLYOUT_SIZE.height * z) }, pointer));
  flyoutWanted = true;
  const front = () => {
    if (!flyoutWanted) return;
    f.show();
    f.focus();
  };
  if (made) f.once('ready-to-show', front);
  else front();
}

function hideFlyout() {
  flyoutWanted = false;
  if (!flyout?.isVisible()) return;
  flyout.hide();
  flyoutHidAt = Date.now();
}

/**
 * The tray's flyout: the web view's page again, small, with no frame, by the tray; a session
 * opened in it opens in the window. It goes when it loses the focus, and at Escape.
 */
function createFlyout() {
  const f = new BrowserWindow({
    ...FLYOUT_SIZE,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: 'Claude agents',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  f.removeMenu();
  guard(f.webContents);
  f.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape') return;
    e.preventDefault();
    hideFlyout();
  });
  f.on('blur', () => hideFlyout());
  // Closed (Alt+F4), it is made again at the next click.
  f.on('closed', () => {
    if (flyout === f) flyout = undefined;
  });
  f.loadURL(`${base}?page=${FLYOUT_PAGE}`);
  return f;
}

/** The menus of the window: the keys that zoom it, close it to the tray and quit; text to copy. */
function appMenu() {
  const zoom = (/** @type {number | null} */ by) => () => {
    settings.zoom = by === null ? 0 : Math.max(-4, Math.min(6, settings.zoom + by));
    win?.webContents.setZoomLevel(settings.zoom);
    flyout?.webContents.setZoomLevel(settings.zoom);
    clip();
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

/** @type {Map<string, Electron.NativeImage>} the images drawn, the one used last last */
const images = new Map();

/**
 * An image drawn for each scale a screen can have, so that one at 150% gets one drawn at that
 * size rather than one stretched; kept, MAX_IMAGES at most.
 * @param {string} name what it is kept by
 * @param {(size: number) => Buffer} make the PNG at a size
 * @param {number} size at a scale of 1
 */
function image(name, make, size) {
  let img = images.get(name);
  if (img) {
    images.delete(name);
  } else {
    img = nativeImage.createEmpty();
    for (const scaleFactor of [1, 1.25, 1.5, 2]) img.addRepresentation({ scaleFactor, buffer: make(Math.round(size * scaleFactor)) });
  }
  images.set(name, img);
  if (images.size > MAX_IMAGES) images.delete(/** @type {string} */ (images.keys().next().value));
  return img;
}

const trayImage = (/** @type {Level} */ level) => image(`tray-${level}`, (size) => trayIcon(level, size), 16);

/** The app's icon as files: ICO for the Start menu's shortcut and the window, PNG for Linux's entries; each glyph as ICO, for the jump list. */
function writeIcons() {
  mkdirSync(folder(), { recursive: true });
  writeFileSync(icoPath(), appIco());
  writeFileSync(pngPath(), appIcon(256));
  if (platform === 'win32') {
    for (const level of /** @type {Level[]} */ (['waiting', 'unread', 'working', 'background'])) writeFileSync(glyphIcoPath(level), glyphIco(level));
  }
}

/** Each session's state as the tray last saw it: a change can be worth a notification. */
let before = new Map();
/** What the tray's tooltip and menu show now, so that they are made again only when that changes. */
let drawn = '';
let lastCounts = '';
/** @type {{ state: TrayState, gauge: Gauge | undefined } | undefined} what the latest read came to */
let latest;

/**
 * The tray, the taskbar and the jump list brought up to date with the latest read; for what
 * changed, the notifications and the flashing, where they are on.
 */
async function update() {
  const snap = await served?.snapshot();
  if (!snap || !tray) return;
  const now = Date.now();
  const state = trayState(snap, now);
  latest = { state, gauge: gaugeOf(snap.usage, now) };
  const fresh = notices(before, snap);
  before = sessionStates(snap);
  const key = JSON.stringify([state.level, state.counts, state.usage, state.listed, settings.notify, settings.flash, settings.trayIcon, settings.minimizeToTray, settings.launcher]);
  if (key !== drawn) {
    drawn = key;
    tray.setToolTip(state.tooltip);
    tray.setContextMenu(trayMenu(state));
    // How many need you: next to the icon on a Mac, a badge on Linux; on Windows, the taskbar button's overlay.
    if (platform === 'darwin') tray.setTitle(state.needs ? String(state.needs) : '');
    if (platform !== 'win32') app.setBadgeCount(state.needs);
    if (state.counts !== lastCounts) logNow(state.counts);
    lastCounts = state.counts;
  }
  paintTray(now);
  paintTaskbar();
  paintJumpList(state);
  if (!fresh.length) return;
  if (settings.notify) fresh.forEach(notify);
  if (settings.flash) flash();
}

/**
 * What the tray icon draws of `state` now, in its look: its name, the same while what it draws
 * is, and how it is drawn.
 * @param {TrayState} state
 * @param {Gauge | undefined} gauge
 * @param {number} now
 * @returns {[string, (size: number) => Buffer]}
 */
function trayLook(state, gauge, now) {
  const look = settings.trayIcon;
  if (look === 'turning' && state.level === 'working') {
    const step = Math.floor(now / TICK) % TURNS;
    return [`turning-${step}`, (size) => turningIcon(step, size)];
  }
  if (look === 'sessions') {
    const levels = state.sessions.slice(0, 4).map((s) => s.level);
    return [`sessions-${levels.join('-')}`, (size) => sessionsIcon(levels, size)];
  }
  if (look === 'usage' && gauge) {
    const v = Math.round(gauge.v);
    return [`usage-${state.level}-${v}-${gauge.mode}`, (size) => usageIcon(state.level, v / 100, gauge.mode, size)];
  }
  if (look === 'count' && state.needs) {
    const n = Math.min(state.needs, 10);
    return [`count-${n}`, (size) => countIcon(n, size)];
  }
  return [`tray-${state.level}`, (size) => trayIcon(state.level, size)];
}

/** The tray icon as last drawn, by its name. */
let trayDrawn = '';
/** @type {ReturnType<typeof setInterval> | undefined} the tray icon moving: turning, or flashing */
let ticker;
/** Till when the tray icon flashes. */
let flashUntil = 0;

/** The tray icon drawn as it is now, when that changed; while it moves, drawn again every TICK. */
function paintTray(now = Date.now()) {
  if (!tray || !latest) return;
  const flashing = now < flashUntil;
  /** @type {[string, (size: number) => Buffer]} */
  const [name, make] = flashing && Math.floor((flashUntil - now) / FLASH_STEP) % 2 === 1 ? ['tile', tileIcon] : trayLook(latest.state, latest.gauge, now);
  if (name !== trayDrawn) {
    tray.setImage(image(name, make, 16));
    trayDrawn = name;
  }
  const moving = flashing || (settings.trayIcon === 'turning' && latest.state.level === 'working');
  if (moving && !ticker) {
    ticker = setInterval(() => paintTray(), TICK);
  } else if (!moving && ticker) {
    clearInterval(ticker);
    ticker = undefined;
  }
}

/**
 * A session started waiting for you or ended its turn: the window's taskbar button flashes till
 * the window is in front, where it has one and is not in front already; with the window in the
 * tray, the tray icon flashes a few seconds, unless the flyout shows.
 */
function flash() {
  if (win && !win.isDestroyed() && win.isVisible()) {
    if (!win.isFocused()) win.flashFrame(true);
    return;
  }
  if (flyout?.isVisible()) return;
  flashUntil = Date.now() + FLASH_FOR;
  paintTray();
}

/** No more flashing: the window or the flyout is shown, or flashing is turned off. */
function stopFlashing() {
  if (win && !win.isDestroyed()) win.flashFrame(false);
  if (!flashUntil) return;
  flashUntil = 0;
  paintTray();
}

/** What each part of the taskbar button shows, as last drawn: each is drawn again only when it changes. */
let taskbarDrawn = { bar: '', overlay: '', tooltip: '', buttons: '' };

/**
 * The window's taskbar button: the plan's usage, the limit used more, as its bar (on a Mac the
 * dock's), colored as the list colors it; on Windows how many need you, or the sessions by what
 * they show, on its icon; a button for each session under its preview, which opens it in the
 * window; and what the preview's tooltip says.
 */
function paintTaskbar() {
  if (!win || win.isDestroyed() || !latest) return;
  const { state, gauge } = latest;
  const drawn = taskbarDrawn;
  /** Whether a part shows something else now: then kept as drawn. @param {keyof typeof drawn} part @param {unknown} now */
  const changed = (part, now) => {
    const key = JSON.stringify(now) ?? '';
    if (drawn[part] === key) return false;
    drawn[part] = key;
    return true;
  };
  // To the percent, as the bar is too short to show less.
  const v = gauge && Math.min(100, Math.max(0, Math.round(gauge.v)));
  if (changed('bar', gauge && [v, gauge.mode])) win.setProgressBar(gauge ? (v ?? 0) / 100 : -1, { mode: gauge ? gauge.mode : 'none' });
  if (platform !== 'win32') return;
  const overlay = overlayOf(state);
  if (changed('overlay', overlay)) win.setOverlayIcon(overlay ? overlayImage(overlay) : null, overlay?.says ?? '');
  if (changed('tooltip', state.tooltip)) win.setThumbnailToolTip(state.tooltip);
  // Only on a button that is there: one made when the window shows gets them then, or where Windows
  // has not made it yet, at the next read.
  const buttons = buttonsOf(state);
  if (win.isVisible() && changed('buttons', buttons)) {
    if (!win.setThumbarButtons(buttons.map((b) => ({ icon: trayImage(b.level), tooltip: b.tooltip, click: () => openInWindow(b.key) })))) drawn.buttons = '';
  }
}

/** @param {Overlay} o */
function overlayImage(o) {
  if ('count' in o) {
    const n = Math.min(o.count, 10);
    return image(`count-${n}`, (size) => countIcon(n, size), 16);
  }
  const { parts } = o;
  return image(`ring-${parts.map(([l, n]) => `${l}${n}`).join('-')}`, (size) => donutIcon(parts, size), 16);
}

/** The part of the window its preview on the taskbar shows: the top left, for its text to be read. */
function clip() {
  if (platform !== 'win32' || !win || win.isDestroyed()) return;
  const [width, height] = win.getContentSize();
  win.setThumbnailClip(thumbnailClip({ width, height }, settings.zoom));
}

/** The taskbar button drawn again, all of it. */
function repaint() {
  taskbarDrawn = { bar: '', overlay: '', tooltip: '', buttons: '' };
  paintTaskbar();
  clip();
}

/** The jump list as last written, and when; how many items Windows shows of it at least. */
let jumped = '';
let jumpedAt = 0;
let jumpItems = 10;

/**
 * The jump list: the sessions that need you, those unread and those at work, each opened in the
 * window; then the app's tasks. Written when it changes, no more often than JUMP_EVERY, without
 * an item taken out of it by hand (Windows would leave out its category).
 * @param {TrayState} state
 */
function paintJumpList(state) {
  if (platform !== 'win32') return;
  const now = Date.now();
  if (JSON.stringify(jumpListOf(state, jumpItems)) === jumped || now - jumpedAt < JUMP_EVERY) return;
  const { minItems, removedItems } = app.getJumpListSettings();
  jumpItems = minItems || 10;
  const list = jumpListOf(state, jumpItems);
  jumped = JSON.stringify(list);
  jumpedAt = now;
  const removed = new Set(removedItems.map((i) => i.args));
  /** @type {Electron.JumpListCategory[]} */
  const categories = list
    .map(({ name, items }) => ({
      type: /** @type {const} */ ('custom'),
      name,
      items: items
        .map((s) => ({
          type: /** @type {const} */ ('task'), title: s.title, description: s.description,
          program: process.execPath, args: launchArgs([openSwitch(s.key)]), iconPath: glyphIcoPath(s.level), iconIndex: 0,
        }))
        .filter((i) => !removed.has(i.args)),
    }))
    .filter((c) => c.items.length);
  const result = app.setJumpList([...categories, tasks()]);
  if (result !== 'ok') logNow(`the jump list was not written: ${result}`);
}

/**
 * The jump list's tasks: show the window, and quit.
 * @returns {Electron.JumpListCategory}
 */
function tasks() {
  /** @param {string} title @param {string} description @param {string[]} args */
  const task = (title, description, args) => ({
    type: /** @type {const} */ ('task'), title, description, program: process.execPath, args: launchArgs(args), iconPath: icoPath(), iconIndex: 0,
  });
  return {
    type: 'tasks',
    items: [
      task('Show Claude agents', 'The window of the Claude agents on this computer', []),
      task('Quit agentmonitor', 'Quit the app, its tray icon with it', ['--quit']),
    ],
  };
}

/**
 * The tray's menu: the window; the sessions that need you, and those unread, each opened in it;
 * the counts and the plan's usage; the switches; Quit.
 * @param {TrayState} state
 */
function trayMenu(state) {
  const label = (/** @type {string} */ s) => menuLabel(s, platform);
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const items = [
    { label: 'Show Claude agents', click: () => show() },
    { type: 'separator' },
    ...state.listed.map((s) => ({ label: label(s.label), click: () => openInWindow(s.key) })),
    ...(state.listed.length ? [/** @type {Electron.MenuItemConstructorOptions} */ ({ type: 'separator' })] : []),
    { label: label(state.counts), enabled: false },
  ];
  if (state.usage) items.push({ label: label(state.usage), enabled: false });
  items.push(
    { type: 'separator' },
    { label: 'Notify when a session needs you or ends its turn', type: 'checkbox', checked: settings.notify, click: (item) => change({ notify: item.checked }) },
    { label: 'Flash when a session needs you or ends its turn', type: 'checkbox', checked: settings.flash, click: (item) => change({ flash: item.checked }) },
    {
      label: 'Tray icon',
      submenu: LOOKS.map(([look, text]) => ({ label: text, type: /** @type {const} */ ('radio'), checked: settings.trayIcon === look, click: () => change({ trayIcon: look }) })),
    },
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
  if (to.flash === false) stopFlashing();
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
      args: launchArgs([]),
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
  const s = { ...DEFAULTS };
  /** @type {any} */
  let o;
  try {
    o = JSON.parse(readFileSync(settingsPath(), 'utf8'));
  } catch {
    return s;
  }
  if (!o || typeof o !== 'object') return s;
  for (const k of /** @type {const} */ (['notify', 'flash', 'minimizeToTray', 'launcher', 'toldTray', 'maximized'])) {
    if (typeof o[k] === 'boolean') s[k] = o[k];
  }
  const look = LOOKS.find(([l]) => l === o.trayIcon);
  if (look) s.trayIcon = look[0];
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
