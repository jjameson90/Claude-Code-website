'use strict';
// Broen mellom hovedprosessen og grensesnittet. Renderer får kun det som
// står her — ingen `require`, ingen direkte filtilgang.

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (handler) => {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('studio', {
  innstillinger: {
    hent: () => ipcRenderer.invoke('settings:get'),
    lagre: (patch) => ipcRenderer.invoke('settings:set', patch),
  },

  kilder: {
    liste: () => ipcRenderer.invoke('sources:list'),
    skjermer: () => ipcRenderer.invoke('screens:info'),
  },

  opptak: {
    start: (options) => ipcRenderer.invoke('recording:start', options),
    stopp: () => ipcRenderer.invoke('recording:stop'),
    pause: () => ipcRenderer.invoke('recording:pause-toggle'),
    tilstand: () => ipcRenderer.invoke('recording:state'),
    apneFil: (which) => ipcRenderer.invoke('recording:open-writer', { which }),
    skriv: (which, data) => ipcRenderer.invoke('recording:chunk', { which, data }),
    lukkFil: (which, firstFrameAt) => ipcRenderer.invoke('recording:close-writer', { which, firstFrameAt }),
    fullfor: (payload) => ipcRenderer.invoke('recording:finalize', payload),
    avbryt: (error) => ipcRenderer.invoke('recording:abort', { error }),

    onStart: on('record:start'),
    onStopp: on('record:stop'),
    onPause: on('record:pause'),
    onBeOmStart: on('record:request-start'),
    onTilstand: on('recording:state'),
    onFremdrift: on('recording:progress'),
    onFerdig: on('recording:done'),
    onFeil: on('recording:error'),
  },

  boble: {
    forhandsvis: (show, deviceId) => ipcRenderer.invoke('bubble:preview', { show, deviceId }),
    settGeometri: (geo) => ipcRenderer.send('bubble:geometry', geo),
    onForhandsvis: on('bubble:preview'),
    onStartOpptak: on('bubble:start-recording'),
    onStoppOpptak: on('bubble:stop-recording'),
  },

  overlegg: {
    onTilstand: on('overlay:state'),
  },

  analyse: {
    plattform: () => ipcRenderer.invoke('plattform:info'),
    ffmpeg: () => ipcRenderer.invoke('ffmpeg:check'),
    metadata: (file) => ipcRenderer.invoke('ffmpeg:probe', file),
    stillhet: (opts) => ipcRenderer.invoke('analyze:silence', opts),
    bolgeform: (opts) => ipcRenderer.invoke('analyze:waveform', opts),
  },

  prosjekt: {
    last: (file) => ipcRenderer.invoke('project:load', file),
    lagre: (file, project) => ipcRenderer.invoke('project:save', { file, project }),
    liste: () => ipcRenderer.invoke('project:list'),
    velg: () => ipcRenderer.invoke('project:open-dialog'),
    apneEditor: (file) => ipcRenderer.invoke('editor:open', file),
    onApne: on('editor:open-project'),
  },

  filer: {
    velgBilder: () => ipcRenderer.invoke('dialog:pick-images'),
    lesSomDataUrl: (file) => ipcRenderer.invoke('file:read-data-url', file),
    kopierTilProsjekt: (projectFile, source) => ipcRenderer.invoke('file:copy-into-project', { projectFile, source }),
    apne: (target) => ipcRenderer.invoke('shell:open-path', target),
    visIMappe: (target) => ipcRenderer.invoke('shell:show-item', target),
    apneOpptaksmappe: () => ipcRenderer.invoke('shell:open-recordings'),
  },

  eksport: {
    start: (projectFile) => ipcRenderer.invoke('export:begin', { projectFile }),
    skriv: (id, data) => ipcRenderer.invoke('export:chunk', { id, data }),
    fullfor: (payload) => ipcRenderer.invoke('export:finish', payload),
    avbryt: (id) => ipcRenderer.invoke('export:cancel', { id }),
    onFremdrift: on('export:progress'),
  },
});
