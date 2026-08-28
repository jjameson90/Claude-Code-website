'use strict';
// Enkel innstillingslagring som JSON i brukerens appmappe.
// Bevisst uten ekstra avhengigheter — det er bare et objekt på disk.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  hotkeyToggle: 'CommandOrControl+Shift+F9',
  hotkeyPause: 'CommandOrControl+Shift+F10',
  outputFolderName: 'Skjermopptak',
  micDeviceId: 'default',
  cameraDeviceId: '',
  captureMic: true,
  captureSystemAudio: true,
  captureCamera: true,
  bubble: { x: 0.85, y: 0.8, size: 0.28 },
  // Kun aktuelt på Linux, der vinduer ikke kan holdes utenfor skjermdeling.
  skjulBobleUnderOpptak: false,
  videoBitrate: 8_000_000,
  fps: 30,
  exportCrf: 20,
  exportPreset: 'medium',
  silenceNoiseDb: -35,
  silenceMinDuration: 0.7,
};

class Settings {
  constructor(userDataPath) {
    this.file = path.join(userDataPath, 'innstillinger.json');
    this.data = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...DEFAULTS, ...raw, bubble: { ...DEFAULTS.bubble, ...(raw.bubble || {}) } };
    } catch {
      // Første oppstart, eller en ødelagt fil — da gjelder standardverdiene.
    }
    return this.data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }

  get(key) { return key ? this.data[key] : this.data; }

  set(patch) {
    this.data = { ...this.data, ...patch };
    this.save();
    return this.data;
  }
}

module.exports = { Settings, DEFAULTS };
