// Eksport: vi spiller av den redigerte tidslinjen én gang, tegner hvert bilde
// med samme kompositor som forhåndsvisningen, og sender bildestrømmen til
// hovedprosessen. Lyden bygger FFmpeg separat fra originalfilene, og til slutt
// strekkes bildets tidsstempler til nøyaktig riktig lengde. Det er dette som
// holder lyd og bilde synkront selv etter mange klipp.

import { tegnBilde, utdataStorrelse } from './kompositor.mjs';
import { keptSegments, editedDuration } from '../../shared/timeline.mjs';

const EPS = 0.02;

export async function eksporter({ project, projectFile, skjermVideo, kameraVideo, bilder, filnavn, onProgress, avbrytSignal }) {
  const segments = keptSegments(project.source.duration, project.edit.cuts);
  if (!segments.length) throw new Error('Hele opptaket er klippet bort — ingenting å eksportere.');

  const malLengde = editedDuration(segments);
  const { width, height } = utdataStorrelse(project);
  const fps = project.export?.fps || 30;

  const lerret = document.createElement('canvas');
  lerret.width = width;
  lerret.height = height;
  const ctx = lerret.getContext('2d', { alpha: false });

  const { id } = await window.studio.eksport.start(projectFile);
  const strom = lerret.captureStream(fps);
  const kandidater = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const recorder = new MediaRecorder(strom, {
    mimeType: kandidater.find((t) => MediaRecorder.isTypeSupported(t)) || '',
    videoBitsPerSecond: Math.round(width * height * fps * 0.14),
  });

  const skriveKo = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) {
      skriveKo.push(e.data.arrayBuffer().then((buf) => window.studio.eksport.skriv(id, buf)));
    }
  };

  // Lyden skal ikke høres under eksport, men videoene må spille for å
  // levere bilder i sanntid.
  const forrigeLyd = { skjerm: skjermVideo.muted, kamera: kameraVideo?.muted };
  skjermVideo.muted = true;
  if (kameraVideo) kameraVideo.muted = true;

  const offset = project.source.cameraOffset || 0;
  let segIndex = 0;
  let ferdig = false;
  let avbrutt = false;

  const sokTil = (t) => new Promise((resolve) => {
    const nar = () => { skjermVideo.removeEventListener('seeked', nar); resolve(); };
    skjermVideo.addEventListener('seeked', nar);
    skjermVideo.currentTime = t;
  });

  await sokTil(segments[0].start);
  if (kameraVideo) kameraVideo.currentTime = Math.max(0, segments[0].start - offset);

  const start = performance.now();
  recorder.start(2000);
  await skjermVideo.play();
  if (kameraVideo) await kameraVideo.play().catch(() => {});

  const resultat = await new Promise((resolve, reject) => {
    let rafId = 0;

    const stopp = () => {
      cancelAnimationFrame(rafId);
      skjermVideo.pause();
      if (kameraVideo) kameraVideo.pause();
    };

    const steg = async () => {
      if (avbrytSignal?.avbrutt && !avbrutt) {
        avbrutt = true;
        stopp();
        recorder.stop();
        return reject(new Error('Eksport avbrutt.'));
      }

      const seg = segments[segIndex];
      let t = skjermVideo.currentTime;

      // Har vi passert enden av segmentet, hopper vi til neste bit.
      if (t >= seg.end - EPS || skjermVideo.ended) {
        segIndex += 1;
        if (segIndex >= segments.length) {
          if (!ferdig) {
            ferdig = true;
            stopp();
            // La den siste biten rekke fram til opptakeren.
            setTimeout(() => recorder.stop(), 120);
          }
          return;
        }
        const neste = segments[segIndex];
        skjermVideo.pause();
        await sokTil(neste.start);
        if (kameraVideo) kameraVideo.currentTime = Math.max(0, neste.start - offset);
        await skjermVideo.play();
        t = neste.start;
      }

      // Kameraet korrigeres bare når det virkelig har sklidd ut.
      if (kameraVideo && kameraVideo.readyState >= 2) {
        const onsket = Math.max(0, t - offset);
        if (Math.abs(kameraVideo.currentTime - onsket) > 0.2) kameraVideo.currentTime = onsket;
      }

      tegnBilde(ctx, project, { skjermVideo, kameraVideo, sourceTime: t, bilder });

      const gjort = segments.slice(0, segIndex).reduce((s, x) => s + (x.end - x.start), 0)
        + Math.max(0, t - segments[segIndex].start);
      onProgress?.({ step: 'Spiller inn bilder', progress: Math.min(0.32, (gjort / malLengde) * 0.32) });

      rafId = requestAnimationFrame(steg);
    };

    recorder.onstop = async () => {
      const maltLengde = (performance.now() - start) / 1000;
      try {
        await Promise.all(skriveKo);
        resolve(maltLengde);
      } catch (err) { reject(err); }
    };
    recorder.onerror = (e) => { stopp(); reject(e.error || new Error('Opptaket av bildestrømmen feilet.')); };

    rafId = requestAnimationFrame(steg);
  }).then(async (maltLengde) => {
    skjermVideo.muted = forrigeLyd.skjerm;
    if (kameraVideo) kameraVideo.muted = forrigeLyd.kamera;

    const res = await window.studio.eksport.fullfor({
      id,
      project,
      segments,
      measuredDuration: maltLengde,
      targetDuration: malLengde,
      fileName: filnavn,
    });
    if (!res.ok) throw new Error(res.error);
    return res;
  }).catch(async (err) => {
    skjermVideo.muted = forrigeLyd.skjerm;
    if (kameraVideo) kameraVideo.muted = forrigeLyd.kamera;
    await window.studio.eksport.avbryt(id).catch(() => {});
    throw err;
  });

  return { ...resultat, malLengde, width, height };
}
