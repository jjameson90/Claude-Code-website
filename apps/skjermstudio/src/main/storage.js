'use strict';
// Filhåndtering for opptak. Hvert opptak får sin egen mappe på skrivebordet:
//
//   Skrivebord/Skjermopptak/2026-08-28_14-32-05/
//     skjerm.webm      (rått opptak — slettes etter vellykket konvertering)
//     skjerm.mp4       (originalopptak, overskrives aldri)
//     kamera.mp4       (eget spor, slik at kameraet kan redigeres etterpå)
//     prosjekt.json    (all redigering, ikke-destruktiv)
//     eksport/         (ferdige MP4-filer)

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

function rootFolder(settings) {
  const desktop = app.getPath('desktop');
  return path.join(desktop, settings.get('outputFolderName') || 'Skjermopptak');
}

function timestampName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
}

function createRecordingFolder(settings) {
  const name = timestampName();
  const dir = path.join(rootFolder(settings), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'eksport'), { recursive: true });
  return { dir, name };
}

/** Skrivestrøm for opptaksbiter fra MediaRecorder. */
class ChunkWriter {
  constructor(filePath) {
    this.filePath = filePath;
    this.stream = fs.createWriteStream(filePath);
    this.bytes = 0;
  }

  write(buffer) {
    this.bytes += buffer.length;
    return new Promise((resolve, reject) => {
      this.stream.write(buffer, (err) => (err ? reject(err) : resolve()));
    });
  }

  close() {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}

function listProjects(settings) {
  const root = rootFolder(settings);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(root, d.name, 'prosjekt.json'))
    .filter((f) => fs.existsSync(f))
    .sort()
    .reverse();
}

function readProject(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeProject(file, project) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(project, null, 2), 'utf8');
  return file;
}

module.exports = { rootFolder, timestampName, createRecordingFolder, ChunkWriter, listProjects, readProject, writeProject };
