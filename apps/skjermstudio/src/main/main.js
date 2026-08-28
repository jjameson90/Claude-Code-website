'use strict';
// Hovedprosessen: vinduer, global hurtigtast, systemstatusikon og all
// filbehandling. Renderer-vinduene har ingen direkte tilgang til disken —
// alt går gjennom de eksplisitte IPC-kanalene nederst i denne filen.

const { app, BrowserWindow, ipcMain, globalShortcut, desktopCapturer, session, screen, shell, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ffmpeg = require('./ffmpeg');
const { Settings } = require('./settings');
const storage = require('./storage');

const ROOT = path.join(__dirname, '..', '..');
const isDev = process.argv.includes('--dev');

// Loopback-opptak av systemlyden finnes på Windows og nyere macOS.
const STOTTER_LOOPBACK = process.platform === 'win32' || process.platform === 'darwin';
// `setContentProtection` holder et vindu utenfor skjermdeling. Ikke på Linux.
const STOTTER_SKJERMBESKYTTELSE = process.platform === 'win32' || process.platform === 'darwin';

let settings;
let controlWindow = null;
let overlayWindow = null;
let bubbleWindow = null;
let editorWindow = null;
let tray = null;

// Tilstanden for et pågående opptak lever her, ikke i renderer, slik at
// hurtigtasten virker uansett hvilket vindu som har fokus.
const recording = {
  active: false,
  paused: false,
  startedAt: 0,
  dir: null,
  name: null,
  writers: new Map(), // 'skjerm' | 'kamera' -> ChunkWriter
  firstChunkAt: new Map(),
  expected: new Set(),  // sporene vi venter på før etterbehandling
  done: new Set(),
  finalizing: false,
  meta: null,
};

// Kilden brukeren har valgt, som display-media-håndtereren under plukker opp.
let pendingDisplayRequest = null;

/* ------------------------------------------------------------------ vinduer */

function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 820,
    minHeight: 600,
    backgroundColor: '#101216',
    title: 'Skjermstudio',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Uten dette struper Chromium opptaket når vinduet skjules.
      backgroundThrottling: false,
    },
  });
  controlWindow.loadFile(path.join(ROOT, 'src', 'renderer', 'recorder', 'index.html'));
  controlWindow.once('ready-to-show', () => controlWindow.show());
  controlWindow.on('closed', () => { controlWindow = null; });
  if (isDev) controlWindow.webContents.openDevTools({ mode: 'detach' });
  return controlWindow;
}

function createOverlayWindow() {
  const display = screen.getPrimaryDisplay();
  const width = 260;
  const height = 64;
  overlayWindow = new BrowserWindow({
    width,
    height,
    x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
    y: display.workArea.y + 16,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Indikatoren skal aldri stjele museklikk fra det brukeren tar opp.
  overlayWindow.setIgnoreMouseEvents(true);
  // ... og den skal ikke havne i selve opptaket. Virker på Windows og macOS.
  overlayWindow.setContentProtection(true);
  overlayWindow.loadFile(path.join(ROOT, 'src', 'renderer', 'overlay', 'index.html'));
  overlayWindow.on('closed', () => { overlayWindow = null; });
  return overlayWindow;
}

function createBubbleWindow() {
  const display = screen.getPrimaryDisplay();
  const { workArea } = display;
  const b = settings.get('bubble');
  const size = Math.round(b.size * workArea.height);
  bubbleWindow = new BrowserWindow({
    width: size,
    height: size,
    x: Math.round(workArea.x + b.x * workArea.width - size / 2),
    y: Math.round(workArea.y + b.y * workArea.height - size / 2),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  bubbleWindow.setAlwaysOnTop(true, 'screen-saver');
  bubbleWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Boblen er en forhåndsvisning for brukeren, ikke en del av skjermopptaket.
  // Kameraet legges på som eget spor i redigeringen. På Windows og macOS
  // holdes vinduet utenfor skjermdelingen; på Linux finnes ikke dette, og
  // da kan boblen skjules under opptak (se innstillingen «skjulBobleUnderOpptak»).
  bubbleWindow.setContentProtection(true);
  bubbleWindow.loadFile(path.join(ROOT, 'src', 'renderer', 'bubble', 'index.html'));

  // Når brukeren drar boblen, lagrer vi den normaliserte plasseringen.
  // Den blir kameraets første nøkkelpunkt i editoren.
  bubbleWindow.on('moved', () => {
    if (!bubbleWindow || bubbleWindow.isDestroyed()) return;
    const b = bubbleWindow.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    settings.set({
      bubble: {
        x: Math.min(1, Math.max(0, (b.x + b.width / 2 - area.x) / area.width)),
        y: Math.min(1, Math.max(0, (b.y + b.height / 2 - area.y) / area.height)),
        size: Math.min(0.6, Math.max(0.1, b.height / area.height)),
      },
    });
  });

  bubbleWindow.on('closed', () => { bubbleWindow = null; });
  return bubbleWindow;
}

function openEditorWindow(projectFile) {
  if (editorWindow && !editorWindow.isDestroyed()) {
    editorWindow.webContents.send('editor:open-project', projectFile);
    editorWindow.focus();
    return editorWindow;
  }
  editorWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#101216',
    title: 'Skjermstudio – redigering',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  editorWindow.loadFile(path.join(ROOT, 'src', 'renderer', 'editor', 'index.html'), {
    query: projectFile ? { project: projectFile } : {},
  });
  editorWindow.once('ready-to-show', () => editorWindow.show());
  editorWindow.on('closed', () => { editorWindow = null; });
  if (isDev) editorWindow.webContents.openDevTools({ mode: 'detach' });
  return editorWindow;
}

/* ------------------------------------------------------- opptaksorkestrering */

/**
 * Venter til et vindu er ferdig lastet. Uten dette kan en beskjed sendes før
 * vinduet har rukket å registrere lytteren sin, og da forsvinner den sporløst.
 */
function ventPaLastet(win) {
  if (!win || win.isDestroyed()) return Promise.resolve();
  if (!win.webContents.isLoading()) return Promise.resolve();
  return new Promise((resolve) => {
    const ferdig = () => { clearTimeout(tidsur); resolve(); };
    const tidsur = setTimeout(ferdig, 5000);
    win.webContents.once('did-finish-load', ferdig);
  });
}

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

async function startRecording(options = {}) {
  if (recording.active) return { ok: false, error: 'Et opptak pågår allerede.' };
  if (!controlWindow) createControlWindow();

  const { dir, name } = storage.createRecordingFolder(settings);
  recording.active = true;
  recording.paused = false;
  recording.startedAt = Date.now();
  recording.dir = dir;
  recording.name = name;
  recording.writers.clear();
  recording.firstChunkAt.clear();
  recording.expected = new Set(['skjerm']);
  recording.done = new Set();
  recording.finalizing = false;
  recording.meta = { ...options };
  // Tomt enhets-ID betyr «bruk standardkameraet» — det er ikke det samme
  // som at kameraet er slått av.
  if (options.camera) recording.expected.add('kamera');

  pendingDisplayRequest = options.display || null;

  // Kameraet tas opp i boblevinduet, som samtidig er den levende
  // forhåndsvisningen brukeren kan dra rundt før og under opptak.
  if (options.camera) {
    if (!bubbleWindow) createBubbleWindow();
    await ventPaLastet(bubbleWindow);
    // På plattformer uten beskyttelse mot skjermdeling kan boblen flyttes
    // utenfor skjermen, slik at den ikke brennes inn i opptaket. Kameraet
    // tas fortsatt opp, og legges på som eget spor i redigeringen.
    if (!STOTTER_SKJERMBESKYTTELSE && settings.get('skjulBobleUnderOpptak')) {
      const { workArea } = screen.getPrimaryDisplay();
      bubbleWindow.setPosition(workArea.x + workArea.width + 50, workArea.y);
    }
    bubbleWindow.showInactive();
    bubbleWindow.webContents.send('bubble:start-recording', {
      deviceId: options.cameraDeviceId || '',
      dir,
    });
  }

  if (!overlayWindow) createOverlayWindow();
  await ventPaLastet(overlayWindow);
  overlayWindow.showInactive();
  overlayWindow.webContents.send('overlay:state', { active: true, paused: false, startedAt: recording.startedAt });

  await ventPaLastet(controlWindow);
  controlWindow.webContents.send('record:start', { ...options, dir });
  broadcast('recording:state', publicState());
  updateTrayMenu();
  return { ok: true, dir, name };
}

async function stopRecording() {
  if (!recording.active) return { ok: false, error: 'Ingen opptak pågår.' };
  recording.active = false;
  recording.stoppingAt = Date.now();

  if (controlWindow) controlWindow.webContents.send('record:stop');
  if (bubbleWindow && !bubbleWindow.isDestroyed()) bubbleWindow.webContents.send('bubble:stop-recording');
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay:state', { active: false, processing: true });
  }
  broadcast('recording:state', publicState());
  updateTrayMenu();
  return { ok: true };
}

function togglePause() {
  if (!recording.active) return { ok: false };
  recording.paused = !recording.paused;
  broadcast('record:pause', { paused: recording.paused });
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay:state', { active: true, paused: recording.paused, startedAt: recording.startedAt });
  }
  broadcast('recording:state', publicState());
  return { ok: true, paused: recording.paused };
}

function publicState() {
  return {
    active: recording.active,
    paused: recording.paused,
    startedAt: recording.startedAt,
    dir: recording.dir,
    name: recording.name,
  };
}

/**
 * Kalles når begge opptakerne har skrevet ferdig. Konverterer de rå
 * WebM-filene til MP4, regner ut forskyvningen mellom sporene og skriver
 * prosjektfilen. Originalene beholdes som egne spor.
 */
async function finalizeRecording(payload) {
  const dir = recording.dir || payload.dir;
  if (!dir) return { ok: false, error: 'Mangler opptaksmappe.' };

  const report = (step, progress) => broadcast('recording:progress', { step, progress });

  const rawScreen = path.join(dir, 'skjerm.webm');
  const rawCamera = path.join(dir, 'kamera.webm');
  const screenMp4 = path.join(dir, 'skjerm.mp4');
  const cameraMp4 = path.join(dir, 'kamera.mp4');

  if (!fs.existsSync(rawScreen) || fs.statSync(rawScreen).size < 1024) {
    return { ok: false, error: 'Skjermopptaket ble tomt. Sjekk at skjermdeling ble tillatt.' };
  }

  report('Konverterer skjermopptak til MP4', 0.1);
  await ffmpeg.toMp4(rawScreen, screenMp4, { fps: settings.get('fps') });

  const hasCamera = fs.existsSync(rawCamera) && fs.statSync(rawCamera).size > 1024;
  if (hasCamera) {
    report('Konverterer kameraopptak til MP4', 0.55);
    await ffmpeg.toMp4(rawCamera, cameraMp4, { fps: settings.get('fps') });
  }

  report('Leser metadata', 0.8);
  const screenInfo = await ffmpeg.probe(screenMp4);

  // Forskyvningen mellom sporene måles på når den aller første databiten kom
  // fra hver opptaker. Positiv verdi = kameraet startet etter skjermen.
  const screenT0 = recording.firstChunkAt.get('skjerm');
  const cameraT0 = recording.firstChunkAt.get('kamera');
  const cameraOffset = hasCamera && screenT0 && cameraT0 ? (cameraT0 - screenT0) / 1000 : 0;

  const { createProject } = await import('../shared/project.mjs');
  const bubble = settings.get('bubble');
  const project = createProject({
    name: recording.name || path.basename(dir),
    dir,
    screenFile: screenMp4,
    cameraFile: hasCamera ? cameraMp4 : null,
    duration: screenInfo.duration,
    width: screenInfo.width || 1920,
    height: screenInfo.height || 1080,
    cameraOffset,
    cameraStart: payload.bubble || bubble,
  });

  const projectFile = path.join(dir, 'prosjekt.json');
  storage.writeProject(projectFile, project);

  // De rå WebM-filene har gjort jobben sin; MP4-ene er nå originalene.
  for (const raw of [rawScreen, hasCamera ? rawCamera : null]) {
    if (raw && fs.existsSync(raw)) { try { fs.unlinkSync(raw); } catch { /* beholdes hvis låst */ } }
  }

  report('Ferdig', 1);
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
  if (bubbleWindow && !bubbleWindow.isDestroyed()) bubbleWindow.hide();
  if (controlWindow && !controlWindow.isDestroyed()) controlWindow.show();

  recording.dir = null;
  recording.name = null;
  broadcast('recording:done', { projectFile, dir });
  if (global.__roykttestFerdig) global.__roykttestFerdig({ projectFile, dir });
  openEditorWindow(projectFile);
  return { ok: true, projectFile, dir, cameraOffset };
}

/* ----------------------------------------------------- hurtigtaster og tray */

function registerShortcuts() {
  globalShortcut.unregisterAll();
  const toggle = settings.get('hotkeyToggle');
  const pause = settings.get('hotkeyPause');
  const results = {};

  results.toggle = toggle ? globalShortcut.register(toggle, () => {
    if (recording.active) stopRecording();
    else if (controlWindow) controlWindow.webContents.send('record:request-start');
  }) : false;

  results.pause = pause ? globalShortcut.register(pause, () => togglePause()) : false;
  return results;
}

function trayIcon(active) {
  // Enkelt ikon tegnet i minnet, så appen ikke er avhengig av bildefiler.
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const cx = 7.5;
  const cy = 7.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const d = Math.hypot(x - cx, y - cy);
      const inside = d < 6.2;
      const alpha = inside ? 255 : 0;
      buf[i] = active ? 60 : 220;      // B
      buf[i + 1] = active ? 60 : 220;  // G
      buf[i + 2] = active ? 240 : 220; // R
      buf[i + 3] = alpha;
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setToolTip(recording.active ? 'Skjermstudio – tar opp' : 'Skjermstudio');
  tray.setImage(trayIcon(recording.active));
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: recording.active ? 'Stopp opptak' : 'Start opptak',
      click: () => {
        if (recording.active) stopRecording();
        else if (controlWindow) { controlWindow.show(); controlWindow.webContents.send('record:request-start'); }
      },
    },
    { label: recording.paused ? 'Fortsett' : 'Pause', enabled: recording.active, click: () => togglePause() },
    { type: 'separator' },
    { label: 'Vis Skjermstudio', click: () => { if (controlWindow) controlWindow.show(); else createControlWindow(); } },
    { label: 'Åpne opptaksmappen', click: () => shell.openPath(storage.rootFolder(settings)) },
    { type: 'separator' },
    { label: 'Avslutt', click: () => { app.quit(); } },
  ]));
}

function createTray() {
  tray = new Tray(trayIcon(false));
  updateTrayMenu();
  tray.on('click', () => { if (controlWindow) controlWindow.show(); else createControlWindow(); });
}

/* ------------------------------------------------------------------- oppstart */

// Røyktesten (`npm run roykttest`) kjører appen med syntetiske medieenheter
// og kontrollerer hele veien fra opptak til ferdig prosjektfil.
const roykttest = process.argv.includes('--roykttest') ? require('./roykttest') : null;
if (roykttest) roykttest.forOppstart(app);

app.whenReady().then(() => {
  settings = new Settings(app.getPath('userData'));

  // Skjermdeling uten systemets egen velger: brukeren har allerede valgt
  // kilde i appen. Systemlyd hentes med loopback der plattformen støtter det
  // — på Linux finnes det ikke, og da må en monitor-enhet velges som «mikrofon».
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const req = pendingDisplayRequest;
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      const chosen = (req && sources.find((s) => s.id === req.sourceId)) || sources[0];
      const vilHaLyd = req?.systemAudio !== false && STOTTER_LOOPBACK;
      callback(vilHaLyd ? { video: chosen, audio: 'loopback' } : { video: chosen });
    }).catch(() => callback({}));
  }, { useSystemPicker: false });

  createControlWindow();
  createTray();
  registerShortcuts();

  if (roykttest) {
    roykttest.kjor({ app, startRecording, stopRecording, settings, hentVindu: () => controlWindow });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createControlWindow();
  });
});

app.on('window-all-closed', () => {
  // Appen lever videre i systemstatusfeltet slik at hurtigtasten fortsatt virker.
  if (process.platform !== 'darwin' && !tray) app.quit();
});

app.on('will-quit', () => globalShortcut.unregisterAll());

/* ------------------------------------------------------------------------ IPC */

ipcMain.handle('settings:get', () => settings.get());
ipcMain.handle('settings:set', (_e, patch) => {
  const data = settings.set(patch);
  if (patch.hotkeyToggle || patch.hotkeyPause) registerShortcuts();
  return data;
});

ipcMain.handle('sources:list', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: false,
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.id.startsWith('screen') ? 'skjerm' : 'vindu',
    thumbnail: s.thumbnail?.toDataURL?.() || null,
  }));
});

ipcMain.handle('screens:info', () => screen.getAllDisplays().map((d) => ({
  id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor, primary: d.id === screen.getPrimaryDisplay().id,
})));

ipcMain.handle('recording:start', (_e, options) => startRecording(options));
ipcMain.handle('recording:stop', () => stopRecording());
ipcMain.handle('recording:pause-toggle', () => togglePause());
ipcMain.handle('recording:state', () => publicState());

ipcMain.handle('recording:open-writer', (_e, { which }) => {
  if (!recording.dir) return { ok: false, error: 'Ingen aktiv opptaksmappe.' };
  const file = path.join(recording.dir, `${which}.webm`);
  recording.writers.set(which, new storage.ChunkWriter(file));
  return { ok: true, file };
});

ipcMain.handle('recording:chunk', async (_e, { which, data }) => {
  const writer = recording.writers.get(which);
  if (!writer) return { ok: false, error: `Ingen åpen fil for «${which}».` };
  if (!recording.firstChunkAt.has(which)) recording.firstChunkAt.set(which, Date.now());
  await writer.write(Buffer.from(data));
  return { ok: true, bytes: writer.bytes };
});

ipcMain.handle('recording:close-writer', async (_e, { which, firstFrameAt }) => {
  const writer = recording.writers.get(which);
  if (writer) { await writer.close(); recording.writers.delete(which); }
  // Renderer kjenner tidspunktet for sitt første bilde bedre enn hovedprosessen.
  if (firstFrameAt) recording.firstChunkAt.set(which, firstFrameAt);
  recording.done.add(which);

  // Etterbehandlingen starter først når alle spor er skrevet ferdig.
  const alleFerdige = [...recording.expected].every((t) => recording.done.has(t));
  if (!recording.active && alleFerdige && !recording.finalizing) {
    recording.finalizing = true;
    try {
      const res = await finalizeRecording({ bubble: settings.get('bubble') });
      if (!res.ok) broadcast('recording:error', { error: res.error });
    } catch (err) {
      broadcast('recording:error', { error: String(err.message || err) });
    } finally {
      recording.finalizing = false;
    }
  }
  return { ok: true };
});

// Skjermopptaket er obligatorisk: klarer det ikke å starte, avbryter vi alt.
ipcMain.handle('recording:abort', (_e, { error } = {}) => {
  recording.active = false;
  recording.expected.clear();
  recording.done.clear();
  for (const [, w] of recording.writers) { w.close().catch(() => {}); }
  recording.writers.clear();
  if (bubbleWindow && !bubbleWindow.isDestroyed()) bubbleWindow.webContents.send('bubble:stop-recording');
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
  if (controlWindow && !controlWindow.isDestroyed()) controlWindow.show();
  broadcast('recording:state', publicState());
  broadcast('recording:error', { error: error || 'Opptaket ble avbrutt.' });
  if (global.__roykttestFeil) global.__roykttestFeil(error || 'Opptaket ble avbrutt.');
  updateTrayMenu();
  return { ok: true };
});

ipcMain.handle('recording:finalize', async (_e, payload) => {
  try {
    return await finalizeRecording(payload || {});
  } catch (err) {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
    if (controlWindow && !controlWindow.isDestroyed()) controlWindow.show();
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.on('bubble:geometry', (_e, geo) => {
  // Boblens plassering lagres normalisert, slik at den blir startpunktet
  // for kameraets første nøkkelpunkt i editoren.
  settings.set({ bubble: geo });
  if (!bubbleWindow || bubbleWindow.isDestroyed()) return;
  const { workArea } = screen.getPrimaryDisplay();
  const size = Math.round(geo.size * workArea.height);
  bubbleWindow.setBounds({
    width: size,
    height: size,
    x: Math.round(workArea.x + geo.x * workArea.width - size / 2),
    y: Math.round(workArea.y + geo.y * workArea.height - size / 2),
  });
});

ipcMain.handle('bubble:preview', async (_e, { show, deviceId }) => {
  if (show) {
    if (!bubbleWindow) createBubbleWindow();
    bubbleWindow.showInactive();
    bubbleWindow.webContents.send('bubble:preview', { deviceId });
  } else if (bubbleWindow && !bubbleWindow.isDestroyed()) {
    bubbleWindow.hide();
  }
  return { ok: true };
});

ipcMain.handle('plattform:info', () => ({
  platform: process.platform,
  loopback: STOTTER_LOOPBACK,
  skjermbeskyttelse: STOTTER_SKJERMBESKYTTELSE,
}));

ipcMain.handle('ffmpeg:check', () => ffmpeg.check());
ipcMain.handle('ffmpeg:probe', (_e, file) => ffmpeg.probe(file));

ipcMain.handle('analyze:silence', async (_e, { file, noiseDb, minDuration, duration }) => {
  const stderr = await ffmpeg.detectSilence(file, {
    noiseDb: noiseDb ?? settings.get('silenceNoiseDb'),
    minDuration: minDuration ?? settings.get('silenceMinDuration'),
  });
  const { parseSilenceDetect } = await import('../shared/silence.mjs');
  return parseSilenceDetect(stderr, duration);
});

ipcMain.handle('analyze:waveform', (_e, { file, buckets }) => ffmpeg.waveformPeaks(file, { buckets }));

ipcMain.handle('project:load', (_e, file) => {
  const raw = storage.readProject(file);
  return { file, project: raw };
});
ipcMain.handle('project:save', (_e, { file, project }) => ({ ok: true, file: storage.writeProject(file, project) }));
ipcMain.handle('project:list', () => storage.listProjects(settings).map((file) => {
  try {
    const p = storage.readProject(file);
    return { file, name: p.name, createdAt: p.createdAt, duration: p.source?.duration || 0 };
  } catch { return null; }
}).filter(Boolean));

ipcMain.handle('project:open-dialog', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Åpne prosjekt',
    defaultPath: storage.rootFolder(settings),
    filters: [{ name: 'Skjermstudio-prosjekt', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
});

ipcMain.handle('editor:open', (_e, file) => { openEditorWindow(file); return { ok: true }; });

ipcMain.handle('dialog:pick-images', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Velg bilder',
    filters: [{ name: 'Bilder', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (res.canceled) return [];
  return res.filePaths;
});

// Bilder som legges oppå videoen kopieres inn i prosjektmappen, slik at
// prosjektet fortsatt virker om originalbildet flyttes eller slettes.
ipcMain.handle('file:copy-into-project', (_e, { projectFile, source }) => {
  const mappe = path.join(path.dirname(projectFile), 'bilder');
  fs.mkdirSync(mappe, { recursive: true });
  const base = path.basename(source);
  let mal = path.join(mappe, base);
  let n = 1;
  while (fs.existsSync(mal) && fs.statSync(mal).size !== fs.statSync(source).size) {
    mal = path.join(mappe, `${path.parse(base).name}-${n++}${path.extname(base)}`);
  }
  if (!fs.existsSync(mal)) fs.copyFileSync(source, mal);
  return mal;
});

ipcMain.handle('file:read-data-url', (_e, file) => {
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  return `data:image/${mime};base64,${fs.readFileSync(file).toString('base64')}`;
});

ipcMain.handle('shell:open-path', (_e, target) => shell.openPath(target));
ipcMain.handle('shell:show-item', (_e, target) => { shell.showItemInFolder(target); return true; });
ipcMain.handle('shell:open-recordings', () => shell.openPath(storage.rootFolder(settings)));

/* -------------------------------------------------------------- eksportflyt */

// Editoren tegner den ferdige komposisjonen til et lerret og sender oss
// videoen. Lyden bygger vi fra originalfilene med FFmpeg — det er den
// eneste måten å garantere at klippene treffer nøyaktig i begge spor.
const exportJobs = new Map();

ipcMain.handle('export:begin', (_e, { projectFile }) => {
  const id = `eksport-${Date.now()}`;
  const dir = path.dirname(projectFile);
  const tmp = path.join(dir, `.tmp-${id}.webm`);
  exportJobs.set(id, { dir, tmp, writer: new storage.ChunkWriter(tmp) });
  return { id };
});

ipcMain.handle('export:chunk', async (_e, { id, data }) => {
  const job = exportJobs.get(id);
  if (!job) return { ok: false, error: 'Ukjent eksportjobb.' };
  await job.writer.write(Buffer.from(data));
  return { ok: true, bytes: job.writer.bytes };
});

ipcMain.handle('export:finish', async (event, { id, project, segments, measuredDuration, targetDuration, fileName }) => {
  const job = exportJobs.get(id);
  if (!job) return { ok: false, error: 'Ukjent eksportjobb.' };
  const send = (step, progress) => event.sender.send('export:progress', { id, step, progress });

  try {
    await job.writer.close();
    const outDir = path.join(job.dir, 'eksport');
    fs.mkdirSync(outDir, { recursive: true });
    const audioFile = path.join(job.dir, `.tmp-${id}.wav`);
    const output = path.join(outDir, fileName || `ferdig-${Date.now()}.mp4`);

    send('Bygger lydspor fra originalopptaket', 0.35);
    await ffmpeg.buildEditedAudio(segments, {
      screenFile: project.source.screen,
      cameraFile: project.source.camera,
      cameraOffset: project.source.cameraOffset || 0,
      output: audioFile,
    });

    send('Setter sammen video og lyd', 0.6);
    await ffmpeg.muxExport({
      videoFile: job.tmp,
      audioFile,
      output,
      targetDuration,
      measuredDuration,
      fps: project.export?.fps || 30,
      crf: project.export?.crf ?? 20,
      preset: project.export?.preset || 'medium',
      audioBitrate: project.export?.audioBitrate || '192k',
      onProgress: (t) => send('Setter sammen video og lyd', 0.6 + Math.min(0.35, (t / Math.max(targetDuration, 1)) * 0.35)),
    });

    for (const f of [job.tmp, audioFile]) { try { fs.unlinkSync(f); } catch { /* ignorer */ } }
    exportJobs.delete(id);
    send('Ferdig', 1);
    return { ok: true, output };
  } catch (err) {
    try { fs.unlinkSync(job.tmp); } catch { /* ignorer */ }
    exportJobs.delete(id);
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('export:cancel', async (_e, { id }) => {
  const job = exportJobs.get(id);
  if (!job) return { ok: true };
  try { await job.writer.close(); fs.unlinkSync(job.tmp); } catch { /* ignorer */ }
  exportJobs.delete(id);
  return { ok: true };
});
