'use strict';
// Alt som gjøres med FFmpeg samles her. Binæren følger med appen via
// `ffmpeg-static`, så ingenting installeres systemomfattende på maskinen.

const { spawn } = require('node:child_process');
const fs = require('node:fs');

function resolveFfmpegPath() {
  let p = require('ffmpeg-static');
  if (!p) throw new Error('Fant ikke ffmpeg-static. Kjør `npm install` i appmappen.');
  // I en pakket app ligger binæren utenfor asar-arkivet.
  if (p.includes('app.asar') && !p.includes('app.asar.unpacked')) {
    p = p.replace('app.asar', 'app.asar.unpacked');
  }
  return p;
}

const FFMPEG = resolveFfmpegPath();

/** Kjører FFmpeg og samler stderr. Kaster hvis exitkoden ikke er 0. */
function run(args, { onProgress, expectBinary = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { windowsHide: true });
    let stderr = '';
    const stdoutChunks = [];

    child.stdout.on('data', (d) => stdoutChunks.push(d));
    child.stderr.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      // Hold stderr i sjakk på lange opptak; vi trenger kun halen + treff.
      if (stderr.length > 400_000) stderr = stderr.slice(-200_000);
      if (onProgress) {
        const m = text.match(/time=(\d+):(\d+):([\d.]+)/);
        if (m) onProgress(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks);
      if (code === 0) resolve({ stderr, stdout: expectBinary ? stdout : stdout.toString() });
      else reject(new Error(`FFmpeg avsluttet med kode ${code}:\n${stderr.slice(-4000)}`));
    });
  });
}

/** Leser lengde og oppløsning uten ffprobe (vi tolker FFmpegs egen rapport). */
async function probe(file) {
  let stderr = '';
  try {
    await run(['-hide_banner', '-i', file]);
  } catch (err) {
    stderr = String(err.message);
  }
  const dur = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  const size = stderr.match(/,\s*(\d{2,5})x(\d{2,5})[\s,]/);
  const hasAudio = /Stream #\d+:\d+.*: Audio:/.test(stderr);
  return {
    duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0,
    width: size ? Number(size[1]) : 0,
    height: size ? Number(size[2]) : 0,
    hasAudio,
  };
}

/**
 * WebM fra MediaRecorder -> MP4 (H.264/AAC).
 * MediaRecorder skriver variabel bildefrekvens; `-vsync cfr -r` gir en fast
 * tidsbase slik at lyd og bilde ikke sklir fra hverandre senere.
 */
async function toMp4(input, output, { fps = 30, crf = 20, preset = 'veryfast', onProgress } = {}) {
  const args = [
    '-y', '-hide_banner',
    '-fflags', '+genpts',
    '-i', input,
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf),
    '-pix_fmt', 'yuv420p', '-r', String(fps), '-fps_mode', 'cfr',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    output,
  ];
  await run(args, { onProgress });
  return output;
}

/** Finner stille partier. Terskel i dB (f.eks. -35), varighet i sekunder. */
async function detectSilence(file, { noiseDb = -35, minDuration = 0.7 } = {}) {
  const { stderr } = await run([
    '-hide_banner', '-nostats',
    '-i', file,
    '-af', `silencedetect=noise=${noiseDb}dB:d=${minDuration}`,
    '-f', 'null', '-',
  ]);
  return stderr;
}

/**
 * Henter ut lydkurven som rå 8 kHz mono-PCM og komprimerer den til
 * topp-punkter tidslinjen kan tegne direkte.
 */
async function waveformPeaks(file, { buckets = 4000 } = {}) {
  const sampleRate = 8000;
  const { stdout } = await run([
    '-hide_banner', '-nostats',
    '-i', file,
    '-ac', '1', '-ar', String(sampleRate),
    '-f', 'f32le', '-acodec', 'pcm_f32le', '-',
  ], { expectBinary: true });

  const samples = new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 4));
  const peaks = new Float32Array(buckets);
  if (!samples.length) return { peaks: Array.from(peaks), sampleRate, duration: 0 };

  const per = samples.length / buckets;
  let hoyeste = 0;
  for (let i = 0; i < buckets; i++) {
    const from = Math.floor(i * per);
    const to = Math.min(samples.length, Math.floor((i + 1) * per));
    let max = 0;
    for (let j = from; j < to; j++) {
      const v = Math.abs(samples[j]);
      if (v > max) max = v;
    }
    peaks[i] = max;
    if (max > hoyeste) hoyeste = max;
  }

  // Kurven normaliseres slik at tidslinjen fyller høyden uansett hvor lavt
  // opptaket ble spilt inn. Selve stillhetsdeteksjonen bruker dB-verdier fra
  // `silencedetect`, så dette er kun for lesbarheten.
  if (hoyeste > 0) for (let i = 0; i < buckets; i++) peaks[i] /= hoyeste;

  return { peaks: Array.from(peaks), sampleRate, duration: samples.length / sampleRate, peak: hoyeste };
}

/**
 * Bygger den ferdig redigerte lydsporet: klipper ut segmentene som beholdes,
 * limer dem sammen og blander inn kameraets lyd hvis den finnes.
 * Lyden bygges alltid fra originalfilene, aldri fra forhåndsvisningen — det
 * er slik vi garanterer at lyden holder seg synkron etter klipping.
 */
async function buildEditedAudio(segments, { screenFile, cameraFile, cameraOffset = 0, output }) {
  if (!segments.length) throw new Error('Ingen segmenter å bygge lyd fra.');
  const total = segments.reduce((sum, s) => sum + (s.end - s.start), 0);

  // Vi tar bare med spor som faktisk har lyd. Kameraet spilles normalt inn
  // uten lyd (mikrofonen ligger i skjermsporet), og da finnes ikke [1:a].
  const skjerm = await probe(screenFile);
  const kamera = cameraFile ? await probe(cameraFile) : null;
  const brukKamera = Boolean(kamera && kamera.hasAudio);

  // Uten lyd i det hele tatt lager vi et stille spor, slik at eksporten
  // fortsatt får et lydspor og riktig lengde.
  if (!skjerm.hasAudio && !brukKamera) {
    await run([
      '-y', '-hide_banner',
      '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=48000`,
      '-t', total.toFixed(6),
      '-c:a', 'pcm_s16le',
      output,
    ]);
    return output;
  }

  const inputs = ['-y', '-hide_banner'];
  const filters = [];
  const parts = [];
  let indeks = 0;

  const trimTo = (inputIdx, offset, label) => {
    const chain = segments.map((s, i) => {
      const start = Math.max(0, s.start - offset);
      const end = Math.max(start, s.end - offset);
      const tag = `${label}${i}`;
      filters.push(`[${inputIdx}:a]atrim=start=${start.toFixed(6)}:end=${end.toFixed(6)},asetpts=PTS-STARTPTS[${tag}]`);
      return `[${tag}]`;
    });
    filters.push(`${chain.join('')}concat=n=${segments.length}:v=0:a=1[${label}out]`);
    return `[${label}out]`;
  };

  if (skjerm.hasAudio) {
    inputs.push('-i', screenFile);
    parts.push(trimTo(indeks++, 0, 'sa'));
  }
  if (brukKamera) {
    inputs.push('-i', cameraFile);
    parts.push(trimTo(indeks++, cameraOffset, 'ca'));
  }

  if (parts.length > 1) {
    filters.push(`${parts.join('')}amix=inputs=${parts.length}:normalize=0:duration=longest[aout]`);
  } else {
    filters.push(`${parts[0]}anull[aout]`);
  }

  await run([
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[aout]',
    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2',
    output,
  ]);
  return output;
}

/**
 * Setter sammen sluttfilen: ferdig komponert video fra editoren + lyden over.
 * `targetDuration` er fasiten fra tidslinjen. Skjermopptak i sanntid kan
 * bomme med noen promille, så vi strekker bildets tidsstempler til nøyaktig
 * riktig lengde før muxing. Da matcher lyd og bilde ende til ende.
 */
async function muxExport({ videoFile, audioFile, output, targetDuration, measuredDuration, fps = 30, crf = 20, preset = 'medium', audioBitrate = '192k', onProgress }) {
  const ratio = measuredDuration > 0.1 && targetDuration > 0.1
    ? targetDuration / measuredDuration
    : 1;
  const needsRetime = Math.abs(ratio - 1) > 0.001;

  const filters = [`[0:v]${needsRetime ? `setpts=${ratio.toFixed(9)}*PTS,` : ''}fps=${fps},format=yuv420p[v]`];

  await run([
    '-y', '-hide_banner',
    '-fflags', '+genpts',
    '-i', videoFile,
    '-i', audioFile,
    '-filter_complex', filters.join(';'),
    '-map', '[v]', '-map', '1:a',
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf),
    '-c:a', 'aac', '-b:a', audioBitrate, '-ar', '48000',
    '-movflags', '+faststart',
    '-t', targetDuration.toFixed(3),
    output,
  ], { onProgress });
  return output;
}

/** Stillbilde fra et gitt tidspunkt — brukes til miniatyrbilder i editoren. */
async function thumbnail(file, time, output, width = 320) {
  await run(['-y', '-hide_banner', '-ss', String(time), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, output]);
  return output;
}

async function check() {
  if (!fs.existsSync(FFMPEG)) return { ok: false, path: FFMPEG, error: 'Binærfilen finnes ikke' };
  try {
    const { stdout, stderr } = await run(['-version']);
    const version = String(stdout || stderr || '').split('\n')[0];
    return { ok: true, path: FFMPEG, version };
  } catch (err) {
    return { ok: false, path: FFMPEG, error: String(err.message).slice(0, 300) };
  }
}

module.exports = { FFMPEG, run, probe, toMp4, detectSilence, waveformPeaks, buildEditedAudio, muxExport, thumbnail, check };
