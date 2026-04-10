'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, nativeImage, screen, dialog } = require('electron');
const path = require('path');
const http = require('http');

const PORT    = Number(process.env.PORT) || 3000;
const PI_HOST = process.env.PI_HOST || '10.0.0.57';
const PI_PORT = Number(process.env.PI_PORT) || 3000;

// Probe a host:port — returns true only if it responds like our PowerStation server
function probeOwnServer(port, host) {
  host = host || '127.0.0.1';
  return new Promise((resolve) => {
    const req = http.get(
      { host, port, path: '/api/settings', timeout: 1200 },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            resolve(res.statusCode === 200 && j && typeof j.alert_threshold !== 'undefined');
          } catch (_) { resolve(false); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

// Plain TCP probe — true if anything is listening on the port
function probePortBusy(port, host) {
  return new Promise((resolve) => {
    const net = require('net');
    const socket = new net.Socket();
    socket.setTimeout(800);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
    socket.connect(port, host || '127.0.0.1');
  });
}

// Single instance lock (prevents multiple copies of the portable exe)
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Persistent data directory (survives portable exe re-extraction)
process.env.SHELLY_DATA_DIR = app.getPath('userData');

const FULL_SIZE   = { width: 1280, height: 820 };
const WIDGET_SIZE = { width: 420, height: 460 };

let mainWindow = null;
let tray       = null;
let isWidget   = false;
let srv        = null;
let serverUrl  = '';
let backendMode = 'local'; // 'pi' or 'local'
app.isQuitting = false;

const ICON_PATH = path.join(__dirname, 'build', 'icon.ico');

async function createWindow() {
  mainWindow = new BrowserWindow({
    width:  FULL_SIZE.width,
    height: FULL_SIZE.height,
    minWidth:  900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#050810',
    show: false,
    icon: ICON_PATH,
    title: 'Power Station · Compteur Électrique',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  await mainWindow.webContents.session.clearCache();
  await mainWindow.webContents.session.clearStorageData();
  mainWindow.loadURL(`${serverUrl}/?electron=1`);

  // F5 = reload, Ctrl+R = reload
  mainWindow.webContents.on('before-input-event', (e, input) => {
    if (input.key === 'F5' || (input.control && input.key === 'r')) {
      mainWindow.webContents.reload();
      e.preventDefault();
    }
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function toggleWidgetMode(force) {
  if (!mainWindow) return;
  isWidget = typeof force === 'boolean' ? force : !isWidget;

  if (isWidget) {
    const wa = screen.getPrimaryDisplay().workArea;
    mainWindow.setResizable(false);
    mainWindow.setMinimumSize(WIDGET_SIZE.width, WIDGET_SIZE.height);
    mainWindow.setSize(WIDGET_SIZE.width, WIDGET_SIZE.height);
    mainWindow.setPosition(wa.x + wa.width - WIDGET_SIZE.width - 24, wa.y + 24);
    mainWindow.setAlwaysOnTop(true, 'floating');
    mainWindow.setSkipTaskbar(false);
  } else {
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setMinimumSize(900, 600);
    mainWindow.setResizable(true);
    mainWindow.setSize(FULL_SIZE.width, FULL_SIZE.height);
    mainWindow.center();
  }
  mainWindow.webContents.send('mode-changed', isWidget ? 'widget' : 'full');
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  let icon;
  try {
    icon = nativeImage.createFromPath(ICON_PATH);
    if (icon.isEmpty()) icon = nativeImage.createEmpty();
  } catch (_) {
    icon = nativeImage.createEmpty();
  }
  tray = new Tray(icon);
  tray.setToolTip('Power Station · Compteur Électrique');
  const menu = Menu.buildFromTemplate([
    { label: 'Afficher',     click: () => showWindow() },
    { type: 'separator' },
    { label: 'Mode complet', click: () => { toggleWidgetMode(false); showWindow(); } },
    { label: 'Mode widget',  click: () => { toggleWidgetMode(true);  showWindow(); } },
    { type: 'separator' },
    { label: 'Quitter',      click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (!mainWindow) return;
    mainWindow.isVisible() ? mainWindow.hide() : showWindow();
  });
}

app.on('second-instance', () => showWindow());

app.whenReady().then(async () => {
  // ── 1) Try Pi backend (remote, persistent data store) ──────────────
  const piOK = await probeOwnServer(PI_PORT, PI_HOST);
  if (piOK) {
    console.log(`[main] Connected to Pi backend at http://${PI_HOST}:${PI_PORT}`);
    srv = { port: PI_PORT, ready: Promise.resolve(), saveReadings: () => {} };
    serverUrl = `http://${PI_HOST}:${PI_PORT}`;
    backendMode = 'pi';
  } else {
    // ── 2) Fallback: start local embedded server ─────────────────────
    console.log(`[main] Pi not reachable (${PI_HOST}:${PI_PORT}), starting local server...`);
    const alreadyLocal = await probeOwnServer(PORT);
    if (alreadyLocal) {
      console.log(`[main] Reusing existing local server on port ${PORT}`);
      srv = { port: PORT, ready: Promise.resolve(), saveReadings: () => {} };
    } else {
      const busy = await probePortBusy(PORT);
      if (busy) {
        dialog.showErrorBox(
          'Port occupé',
          `Le Pi (${PI_HOST}) n'est pas joignable et le port ${PORT} local est déjà occupé.\n\n` +
          `Libère le port ${PORT} ou vérifie que le Pi est bien allumé sur le réseau.`
        );
        app.quit();
        return;
      }
      try {
        srv = require('./server.js');
        await srv.ready;
      } catch (e) {
        dialog.showErrorBox('Erreur démarrage serveur', String(e && e.message || e));
        app.quit();
        return;
      }
    }
    serverUrl = `http://localhost:${srv.port}`;
    backendMode = 'local';
  }

  console.log(`[main] Backend: ${backendMode} → ${serverUrl}`);
  await createWindow();
  createTray();

  globalShortcut.register('Control+Alt+E', () => {
    if (!mainWindow) return;
    mainWindow.isVisible() ? mainWindow.hide() : showWindow();
  });
  globalShortcut.register('Control+Alt+W', () => {
    toggleWidgetMode();
    showWindow();
  });
});

app.on('before-quit', () => {
  app.isQuitting = true;
  try { srv && srv.saveReadings && srv.saveReadings(); } catch (_) {}
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// Keep running in tray when all windows closed
app.on('window-all-closed', () => { /* no-op */ });

// ─── IPC ─────────────────────────────────────────────────────────────────────
ipcMain.handle('win:minimize',     () => mainWindow && mainWindow.minimize());
ipcMain.handle('win:hide',         () => mainWindow && mainWindow.hide());
ipcMain.handle('win:close',        () => { app.isQuitting = true; app.quit(); });
ipcMain.handle('win:toggle-widget',() => { toggleWidgetMode(); return isWidget; });
ipcMain.handle('win:get-mode',     () => (isWidget ? 'widget' : 'full'));
