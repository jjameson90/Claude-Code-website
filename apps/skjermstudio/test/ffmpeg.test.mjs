// Ende-til-ende-test av FFmpeg-kjeden med den binæren appen faktisk bruker.
// Vi lager et testopptak med en kjent stillhet, klipper den bort, og
// kontrollerer at lyd og bilde kommer ut med riktig lengde og innhold.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { keptSegments, editedDuration } from '../src/shared/timeline.mjs';
import { parseSilenceDetect } from '../src/shared/silence.mjs';

const require = createRequire(import.meta.url);
const ffmpeg = require('../src/main/ffmpeg.js');

const arbeid = fs.mkdtempSync(path.join(os.tmpdir(), 'skjermstudio-test-'));
const KILDE = path.join(arbeid, 'kilde.mp4');

// 12 sekunder testbilde med 440 Hz tone, men helt stille mellom 4 og 7 sekunder.
const LENGDE = 12;
const STILLE_FRA = 4;
const STILLE_TIL = 7;

test.before(async () => {
  await ffmpeg.run([
    '-y', '-hide_banner',
    '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=30:duration=${LENGDE}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${LENGDE}`,
    '-filter_complex', `[1:a]volume=0:enable='between(t,${STILLE_FRA},${STILLE_TIL})'[a]`,
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    KILDE,
  ]);
}, { timeout: 120_000 });

test.after(() => fs.rmSync(arbeid, { recursive: true, force: true }));

test('probe leser lengde, oppløsning og lydspor', async () => {
  const info = await ffmpeg.probe(KILDE);
  assert.ok(Math.abs(info.duration - LENGDE) < 0.3, `lengde ${info.duration}`);
  assert.equal(info.width, 640);
  assert.equal(info.height, 360);
  assert.equal(info.hasAudio, true);
});

test('silencedetect finner den innlagte stillheten', async () => {
  const stderr = await ffmpeg.detectSilence(KILDE, { noiseDb: -40, minDuration: 0.5 });
  const stille = parseSilenceDetect(stderr, LENGDE);
  assert.equal(stille.length, 1, `fant ${stille.length} partier`);
  assert.ok(Math.abs(stille[0].start - STILLE_FRA) < 0.35, `start ${stille[0].start}`);
  assert.ok(Math.abs(stille[0].end - STILLE_TIL) < 0.35, `slutt ${stille[0].end}`);
});

test('bølgeformen er høy der det er lyd og flat der det er stille', async () => {
  const { peaks, peak } = await ffmpeg.waveformPeaks(KILDE, { buckets: 240 });
  assert.equal(peaks.length, 240);
  const iPunkt = (t) => Math.floor((t / LENGDE) * peaks.length);
  const lyd = peaks[iPunkt(2)];
  const stille = peaks[iPunkt(5.5)];

  assert.ok(peak > 0, 'fant ingen lyd i det hele tatt');
  assert.ok(stille < 0.02, `forventet stillhet, fikk ${stille}`);
  assert.ok(lyd > 0.5, `kurven skal normaliseres mot toppen, fikk ${lyd}`);
  assert.ok(Math.max(...peaks) <= 1.0000001, 'normaliserte verdier skal ikke overstige 1');
});

test('buildEditedAudio klipper bort stillheten og gir riktig lengde', async () => {
  const segments = keptSegments(LENGDE, [{ start: STILLE_FRA, end: STILLE_TIL }]);
  const forventet = editedDuration(segments);
  assert.equal(forventet, LENGDE - (STILLE_TIL - STILLE_FRA));

  const ut = path.join(arbeid, 'lyd.wav');
  await ffmpeg.buildEditedAudio(segments, { screenFile: KILDE, cameraFile: null, output: ut });

  const info = await ffmpeg.probe(ut);
  assert.ok(Math.abs(info.duration - forventet) < 0.15, `lyd ble ${info.duration}, ventet ${forventet}`);

  // Etter klippet skal det ikke finnes stillhet igjen i lydsporet.
  const stille = parseSilenceDetect(await ffmpeg.detectSilence(ut, { noiseDb: -40, minDuration: 0.5 }), info.duration);
  assert.equal(stille.length, 0, `uventet stillhet igjen: ${JSON.stringify(stille)}`);
});

test('buildEditedAudio hopper over kameraspor uten lyd', async () => {
  // Kameraet spilles inn uten lyd — filteret må da ikke vise til [1:a].
  const stumtKamera = path.join(arbeid, 'kamera-stum.mp4');
  await ffmpeg.run([
    '-y', '-hide_banner',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15:duration=12',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    stumtKamera,
  ]);

  const segments = keptSegments(LENGDE, [{ start: 2, end: 4 }]);
  const ut = path.join(arbeid, 'lyd-stumt-kamera.wav');
  await ffmpeg.buildEditedAudio(segments, { screenFile: KILDE, cameraFile: stumtKamera, output: ut });

  const info = await ffmpeg.probe(ut);
  assert.ok(Math.abs(info.duration - editedDuration(segments)) < 0.15, `lyd ble ${info.duration}`);
}, { timeout: 120_000 });

test('buildEditedAudio lager stille spor når ingen kilder har lyd', async () => {
  const stum = path.join(arbeid, 'helt-stum.mp4');
  await ffmpeg.run([
    '-y', '-hide_banner',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15:duration=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    stum,
  ]);

  const segments = keptSegments(6, [{ start: 1, end: 2 }]);
  const ut = path.join(arbeid, 'lyd-stum.wav');
  await ffmpeg.buildEditedAudio(segments, { screenFile: stum, cameraFile: null, output: ut });

  const info = await ffmpeg.probe(ut);
  assert.ok(Math.abs(info.duration - editedDuration(segments)) < 0.15, `lyd ble ${info.duration}`);
}, { timeout: 120_000 });

test('muxExport låser lengden slik at lyd og bilde treffer', async () => {
  const segments = keptSegments(LENGDE, [{ start: STILLE_FRA, end: STILLE_TIL }]);
  const malLengde = editedDuration(segments); // 9 s

  const lyd = path.join(arbeid, 'lyd2.wav');
  await ffmpeg.buildEditedAudio(segments, { screenFile: KILDE, cameraFile: null, output: lyd });

  // Sanntidsinnspilling bommer alltid litt; her later vi som den ble 9,4 s.
  const maltLengde = 9.4;
  const bilde = path.join(arbeid, 'bilde.webm');
  await ffmpeg.run([
    '-y', '-hide_banner',
    '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=30:duration=${maltLengde}`,
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1M',
    bilde,
  ]);

  const ut = path.join(arbeid, 'ferdig.mp4');
  await ffmpeg.muxExport({
    videoFile: bilde,
    audioFile: lyd,
    output: ut,
    targetDuration: malLengde,
    measuredDuration: maltLengde,
    fps: 30,
    crf: 28,
    preset: 'ultrafast',
  });

  const info = await ffmpeg.probe(ut);
  assert.ok(info.hasAudio, 'eksporten mangler lydspor');
  // Bildet strekkes fra 9,4 til 9,0 s, så begge sporene ender likt.
  assert.ok(Math.abs(info.duration - malLengde) < 0.12, `ferdig fil ble ${info.duration}, ventet ${malLengde}`);
}, { timeout: 180_000 });
