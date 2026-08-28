// Redigeringsvinduet. All redigering er ikke-destruktiv: prosjektfilen
// beskriver hva som skal skje, originalopptakene ligger urørt ved siden av.

import { Tidslinje, formatterTid } from './tidslinje.mjs';
import { Historikk } from './historikk.mjs';
import { tegnBilde, utdataStorrelse } from './kompositor.mjs';
import { eksporter } from './eksport.mjs';
import { keptSegments, editedDuration, nextSourceTime, normalizeRanges } from '../../shared/timeline.mjs';
import { sampleCamera, upsertKeyframe, removeKeyframeAt, sortKeyframes, DEFAULT_CAMERA_KEYFRAME } from '../../shared/keyframes.mjs';
import { silenceToCuts, nextSilence, prevSilence } from '../../shared/silence.mjs';

const el = (id) => document.getElementById(id);
const skjermVideo = el('skjermVideo');
const kameraVideo = el('kameraVideo');
const lerret = el('lerret');
const ctx = lerret.getContext('2d', { alpha: false });

const app = {
  projectFile: null,
  project: null,
  historikk: null,
  tidslinje: null,
  segments: [],
  stillhet: [],
  peaks: [],
  spiller: false,
  playhead: 0,
  valg: null,
  bilder: new Map(),        // pålegg-id -> Image
  valgtPalegg: null,
  kameraUtkast: null,       // levende forhåndsvisning mens en glidebryter dras
  beskjaerModus: false,
  beskjaerRekt: null,
  lagret: true,
};

/* ------------------------------------------------------------- oppstart */

async function init() {
  const fra = new URLSearchParams(location.search).get('project');
  window.studio.prosjekt.onApne((fil) => lastProsjekt(fil));
  if (fra) await lastProsjekt(fra);
  koblePaHendelser();
  requestAnimationFrame(tegneLokke);
}

function filUrl(sti) {
  let s = String(sti).replace(/\\/g, '/');
  if (!s.startsWith('/')) s = `/${s}`;
  return `file://${encodeURI(s).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

async function lastProsjekt(fil) {
  const { project } = await window.studio.prosjekt.last(fil);
  app.projectFile = fil;
  app.project = project;
  app.historikk = new Historikk(project.edit);
  app.valg = null;
  app.valgtPalegg = null;
  app.bilder.clear();

  el('prosjektnavn').textContent = project.name;
  el('eksportNavn').value = `${project.name}.mp4`;
  el('crf').value = project.export?.crf ?? 20;
  el('crfVerdi').textContent = project.export?.crf ?? 20;
  el('eksportFps').value = String(project.export?.fps ?? 30);
  el('overgang').value = Math.round((project.edit.cameraTransition ?? 0.6) * 10);
  el('overgangVerdi').textContent = `${(project.edit.cameraTransition ?? 0.6).toFixed(1).replace('.', ',')} s`;

  skjermVideo.src = filUrl(project.source.screen);
  if (project.source.camera) {
    kameraVideo.src = filUrl(project.source.camera);
    el('kameraMangler').classList.add('skjult');
    el('kameraPanel').classList.remove('skjult');
  } else {
    el('kameraMangler').classList.remove('skjult');
    el('kameraPanel').classList.add('skjult');
  }

  await new Promise((res) => {
    if (skjermVideo.readyState >= 1) return res();
    skjermVideo.addEventListener('loadedmetadata', res, { once: true });
  });

  // Videoens egen lengde er fasit hvis prosjektfilen mangler eller bommer.
  if (!project.source.duration || Math.abs(project.source.duration - skjermVideo.duration) > 0.5) {
    project.source.duration = skjermVideo.duration;
  }
  if (!project.source.width) {
    project.source.width = skjermVideo.videoWidth;
    project.source.height = skjermVideo.videoHeight;
  }

  settOppLerret();
  beregnSegmenter();

  app.tidslinje = app.tidslinje || lagTidslinje();
  app.tidslinje.sett({ duration: project.source.duration, cuts: project.edit.cuts, keyframes: project.edit.cameraKeyframes, overlays: project.edit.overlays, playhead: 0 });
  app.tidslinje.visAlt();

  await lastPaleggBilder();
  oppdaterPaneler();
  analyser();
}

function settOppLerret() {
  const { width, height } = utdataStorrelse(app.project);
  lerret.width = width;
  lerret.height = height;
  lerret.style.aspectRatio = `${width} / ${height}`;
}

/** Bølgeform og stillhet regnes ut av FFmpeg i hovedprosessen. */
async function analyser() {
  const fil = app.project.source.screen;
  el('stillhetInfo').textContent = 'Analyserer lyd …';
  try {
    const [bolge, stillhet] = await Promise.all([
      window.studio.analyse.bolgeform({ file: fil, buckets: 6000 }),
      window.studio.analyse.stillhet({
        file: fil,
        noiseDb: Number(el('terskel').value),
        minDuration: Number(el('minLengde').value) / 10,
        duration: app.project.source.duration,
      }),
    ]);
    app.peaks = bolge.peaks || [];
    app.stillhet = stillhet || [];
    app.tidslinje.sett({ peaks: app.peaks, silence: app.stillhet });
    const sum = app.stillhet.reduce((s, r) => s + (r.end - r.start), 0);
    el('stillhetInfo').textContent = app.stillhet.length
      ? `Fant ${app.stillhet.length} stille partier (${formatterTid(sum)} til sammen).`
      : 'Fant ingen stille partier med denne terskelen.';
  } catch (err) {
    el('stillhetInfo').textContent = `Analysen feilet: ${err.message}`;
  }
}

function beregnSegmenter() {
  app.segments = keptSegments(app.project.source.duration, app.project.edit.cuts);
  const lengde = editedDuration(app.segments);
  el('lengdeMerke').textContent = `${formatterTid(lengde)} etter klipping`;
  el('tidTotal').textContent = formatterTid(app.project.source.duration);
}

/* --------------------------------------------------------- tegning og avspilling */

function aktiveKeyframes() {
  const kf = app.project?.edit.cameraKeyframes || [];
  if (!app.kameraUtkast) return kf;
  return upsertKeyframe(kf, { ...app.kameraUtkast, t: app.playhead });
}

function tegneLokke() {
  if (app.project) {
    if (app.spiller) oppdaterAvspilling();
    const prosjektMedUtkast = app.kameraUtkast
      ? { ...app.project, edit: { ...app.project.edit, cameraKeyframes: aktiveKeyframes() } }
      : app.project;
    tegnBilde(ctx, prosjektMedUtkast, {
      skjermVideo,
      kameraVideo: app.project.source.camera ? kameraVideo : null,
      sourceTime: app.playhead,
      bilder: app.bilder,
    });
    oppdaterHjornebryter();
  }
  requestAnimationFrame(tegneLokke);
}

function oppdaterAvspilling() {
  let t = skjermVideo.currentTime;
  const neste = nextSourceTime(t, app.segments);

  if (neste === null) { pause(); settPlayhead(app.project.source.duration); return; }
  if (neste - t > 0.03) { skjermVideo.currentTime = neste; t = neste; }

  settPlayhead(t, { fraAvspilling: true });

  if (app.project.source.camera && kameraVideo.readyState >= 2) {
    const onsket = Math.max(0, t - (app.project.source.cameraOffset || 0));
    if (Math.abs(kameraVideo.currentTime - onsket) > 0.25) kameraVideo.currentTime = onsket;
  }
}

function settPlayhead(t, { fraAvspilling = false } = {}) {
  app.playhead = Math.max(0, Math.min(app.project.source.duration, t));
  if (!fraAvspilling) {
    skjermVideo.currentTime = app.playhead;
    if (app.project.source.camera) {
      kameraVideo.currentTime = Math.max(0, app.playhead - (app.project.source.cameraOffset || 0));
    }
  }
  el('tidNa').textContent = formatterTid(app.playhead, true);
  if (app.tidslinje) {
    if (fraAvspilling) app.tidslinje.folgSpillehode(app.playhead);
    app.tidslinje.sett({ playhead: app.playhead });
  }
  oppdaterKameraGlidebrytere();
}

async function spillAv() {
  const neste = nextSourceTime(app.playhead, app.segments);
  if (neste === null) settPlayhead(app.segments[0]?.start ?? 0);
  else if (neste !== app.playhead) settPlayhead(neste);

  app.spiller = true;
  el('spill').textContent = 'Pause';
  await skjermVideo.play().catch(() => {});
  if (app.project.source.camera) kameraVideo.play().catch(() => {});
}

function pause() {
  app.spiller = false;
  el('spill').textContent = 'Spill';
  skjermVideo.pause();
  kameraVideo.pause();
}

function vekslePlay() { app.spiller ? pause() : spillAv(); }

/* -------------------------------------------------------------- endringer */

/** Alle redigeringer går gjennom denne, slik at angre alltid virker. */
function endre(fn, { historikk = true } = {}) {
  fn(app.project.edit);
  if (historikk) app.historikk.push(app.project.edit);
  app.lagret = false;
  beregnSegmenter();
  settOppLerret();
  app.tidslinje.sett({
    cuts: app.project.edit.cuts,
    keyframes: app.project.edit.cameraKeyframes,
    overlays: app.project.edit.overlays,
  });
  oppdaterPaneler();
}

function gjenopprett(tilstand) {
  if (!tilstand) return;
  app.project.edit = tilstand;
  app.lagret = false;
  beregnSegmenter();
  settOppLerret();
  app.tidslinje.sett({
    cuts: app.project.edit.cuts,
    keyframes: app.project.edit.cameraKeyframes,
    overlays: app.project.edit.overlays,
  });
  lastPaleggBilder();
  oppdaterPaneler();
}

async function lagre() {
  if (!app.projectFile) return;
  app.project.export = {
    ...app.project.export,
    crf: Number(el('crf').value),
    fps: Number(el('eksportFps').value),
  };
  await window.studio.prosjekt.lagre(app.projectFile, app.project);
  app.lagret = true;
  el('lagre').textContent = 'Lagret ✓';
  setTimeout(() => { el('lagre').textContent = 'Lagre'; }, 1400);
}

/* ------------------------------------------------------------- tidslinje */

function lagTidslinje() {
  return new Tidslinje(el('tidslinje'), {
    onSeek: (t) => { if (app.spiller) pause(); settPlayhead(t); },
    onSelection: (valg) => { app.valg = valg; app.tidslinje.sett({ selection: valg }); oppdaterValgInfo(); },
    onKeyframeValgt: (t) => { settPlayhead(t); app.tidslinje.sett({ valgtKeyframe: t }); },
    onKeyframeFlyttet: (fra, til) => {
      endre((e) => {
        const kf = e.cameraKeyframes.find((k) => Math.abs(k.t - fra) < 0.02);
        if (kf) kf.t = Math.max(0, Math.min(app.project.source.duration, til));
        e.cameraKeyframes = sortKeyframes(e.cameraKeyframes);
      }, { historikk: false });
      app.tidslinje.sett({ valgtKeyframe: til });
    },
    onKeyframeSlettet: (t) => endre((e) => { e.cameraKeyframes = removeKeyframeAt(e.cameraKeyframes, t); }),
    onPaleggValgt: (id) => { app.valgtPalegg = id; app.tidslinje.sett({ valgtPalegg: id }); oppdaterPaleggPanel(); },
    onPaleggEndret: (id, patch) => {
      endre((e) => {
        const o = e.overlays.find((x) => x.id === id);
        if (o) Object.assign(o, patch);
      }, { historikk: false });
    },
  });
}

function oppdaterValgInfo() {
  const v = app.valg;
  el('valgInfo').textContent = v
    ? `Markert: ${formatterTid(v.start, true)} – ${formatterTid(v.end, true)} (${(v.end - v.start).toFixed(1).replace('.', ',')} s)`
    : 'Dra i lydbølgen for å markere et parti.';
  el('klippValg').disabled = !v;
}

/* --------------------------------------------------------------- paneler */

function oppdaterPaneler() {
  oppdaterValgInfo();
  oppdaterKlippliste();
  oppdaterKeyframeliste();
  oppdaterPaleggliste();
  oppdaterPaleggPanel();
  oppdaterKameraGlidebrytere();
  el('angre').disabled = !app.historikk?.kanAngre;
  el('gjorOm').disabled = !app.historikk?.kanGjorOm;
}

function oppdaterKlippliste() {
  const boks = el('klippliste');
  boks.innerHTML = '';
  const cuts = app.project.edit.cuts;
  if (!cuts.length) { boks.innerHTML = '<div class="tom">Ingenting er klippet bort ennå.</div>'; return; }

  cuts.forEach((c, i) => {
    const rad = document.createElement('div');
    rad.className = 'element';
    const tekst = document.createElement('span');
    tekst.className = 'tekst';
    tekst.textContent = `${formatterTid(c.start, true)} – ${formatterTid(c.end, true)}`;
    const gaTil = document.createElement('button');
    gaTil.textContent = 'Gå til';
    gaTil.addEventListener('click', () => settPlayhead(Math.max(0, c.start - 0.5)));
    const angre = document.createElement('button');
    angre.textContent = 'Ta tilbake';
    angre.addEventListener('click', () => endre((e) => { e.cuts = e.cuts.filter((_, j) => j !== i); }));
    rad.append(tekst, gaTil, angre);
    boks.appendChild(rad);
  });
}

function oppdaterKeyframeliste() {
  const boks = el('keyframeliste');
  if (!boks) return;
  boks.innerHTML = '';
  const kfer = app.project.edit.cameraKeyframes || [];
  if (!kfer.length) { boks.innerHTML = '<div class="tom">Ingen nøkkelpunkter.</div>'; return; }

  for (const k of kfer) {
    const rad = document.createElement('div');
    rad.className = 'element';
    const tekst = document.createElement('span');
    tekst.className = 'tekst';
    tekst.textContent = `${formatterTid(k.t, true)} · ${k.mode === 'full' ? 'fyller bildet' : `boble ${Math.round(k.size * 100)} %`}`;
    const gaTil = document.createElement('button');
    gaTil.textContent = 'Gå til';
    gaTil.addEventListener('click', () => settPlayhead(k.t));
    const slett = document.createElement('button');
    slett.textContent = 'Slett';
    slett.addEventListener('click', () => endre((e) => { e.cameraKeyframes = removeKeyframeAt(e.cameraKeyframes, k.t); }));
    rad.append(tekst, gaTil, slett);
    boks.appendChild(rad);
  }
}

function oppdaterKameraGlidebrytere() {
  if (!app.project?.source.camera || app.kameraUtkast) return;
  const s = sampleCamera(app.project.edit.cameraKeyframes, app.playhead, { transition: app.project.edit.cameraTransition });
  el('kfX').value = Math.round(s.x * 100);
  el('kfY').value = Math.round(s.y * 100);
  el('kfStorrelse').value = Math.round(s.size * 100);
  el('kfXVerdi').textContent = `${Math.round(s.x * 100)} %`;
  el('kfYVerdi').textContent = `${Math.round(s.y * 100)} %`;
  el('kfStorrelseVerdi').textContent = `${Math.round(s.size * 100)} %`;
  const full = (s.fullness ?? 0) > 0.5;
  el('modusBoble').classList.toggle('aktiv', !full);
  el('modusFull').classList.toggle('aktiv', full);
}

function oppdaterHjornebryter() {
  const knapp = el('hjornebryter');
  if (!app.project?.source.camera) { knapp.classList.add('skjult'); return; }
  const s = sampleCamera(app.project.edit.cameraKeyframes, app.playhead, { transition: app.project.edit.cameraTransition });
  knapp.classList.toggle('skjult', (s.fullness ?? 0) < 0.5);
}

/** Kameratilstanden slik den ser ut akkurat nå — grunnlag for nye nøkkelpunkter. */
function naverendeKamera() {
  const kfer = app.project.edit.cameraKeyframes || [];
  if (!kfer.length) return { ...DEFAULT_CAMERA_KEYFRAME };
  const s = sampleCamera(kfer, app.playhead, { transition: app.project.edit.cameraTransition });
  return { x: s.x, y: s.y, size: s.size, mode: (s.fullness ?? 0) > 0.5 ? 'full' : 'bubble' };
}

/** Siste boblestørrelse og -plassering før kameraet ble forstørret. */
function sisteBoble() {
  const kfer = sortKeyframes(app.project.edit.cameraKeyframes || []);
  const boble = [...kfer].reverse().find((k) => k.mode === 'bubble' && k.t <= app.playhead)
    || kfer.find((k) => k.mode === 'bubble');
  return boble || DEFAULT_CAMERA_KEYFRAME;
}

/* ------------------------------------------------------------------ pålegg */

async function lastPaleggBilder() {
  for (const o of app.project.edit.overlays || []) {
    if (o.type !== 'image' || app.bilder.has(o.id) || !o.src) continue;
    try {
      const dataUrl = await window.studio.filer.lesSomDataUrl(o.src);
      const img = new Image();
      img.src = dataUrl;
      app.bilder.set(o.id, img);
    } catch {
      // Bildet finnes ikke lenger — påleggets plass beholdes, men det tegnes ikke.
    }
  }
}

function nyId() { return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }

function leggTilPalegg(palegg) {
  const id = nyId();
  const start = app.playhead;
  const slutt = Math.min(app.project.source.duration, start + 5);
  endre((e) => {
    e.overlays = [...e.overlays, { id, start, end: slutt, x: 0.1, y: 0.1, w: 0.3, h: 0.3, fade: 0.25, ...palegg }];
  });
  app.valgtPalegg = id;
  app.tidslinje.sett({ valgtPalegg: id });
  oppdaterPaleggPanel();
  return id;
}

function oppdaterPaleggliste() {
  const boks = el('paleggliste');
  if (!boks) return;
  boks.innerHTML = '';
  const liste = app.project.edit.overlays || [];
  if (!liste.length) { boks.innerHTML = '<div class="tom">Ingen pålegg lagt til.</div>'; return; }

  for (const o of liste) {
    const rad = document.createElement('div');
    rad.className = `element${o.id === app.valgtPalegg ? ' valgt' : ''}`;
    const tekst = document.createElement('span');
    tekst.className = 'tekst';
    tekst.textContent = `${navnPa(o)} · ${formatterTid(o.start)}–${formatterTid(o.end)}`;
    const velg = document.createElement('button');
    velg.textContent = 'Velg';
    velg.addEventListener('click', () => {
      app.valgtPalegg = o.id;
      settPlayhead(o.start + 0.1);
      app.tidslinje.sett({ valgtPalegg: o.id });
      oppdaterPaleggliste();
      oppdaterPaleggPanel();
    });
    rad.append(tekst, velg);
    boks.appendChild(rad);
  }
}

function navnPa(o) {
  if (o.type === 'image') return o.name || 'Bilde';
  if (o.type === 'text') return `Tekst: ${(o.text || '').slice(0, 18)}`;
  if (o.type === 'arrow') return 'Pil';
  return 'Markering';
}

function oppdaterPaleggPanel() {
  const boks = el('paleggRedigering');
  const o = (app.project?.edit.overlays || []).find((x) => x.id === app.valgtPalegg);
  if (!o) { boks.classList.add('skjult'); return; }
  boks.classList.remove('skjult');

  el('tekstFelt').style.display = o.type === 'text' ? 'block' : 'none';
  el('paleggTekst').value = o.text || '';
  el('px').value = Math.round(o.x * 100);
  el('py').value = Math.round(o.y * 100);
  el('pxVerdi').textContent = `${Math.round(o.x * 100)} %`;
  el('pyVerdi').textContent = `${Math.round(o.y * 100)} %`;

  const storrelse = o.type === 'text' ? (o.fontSize ?? 0.05) * 100 : (o.w ?? 0.3) * 100;
  el('pStorrelse').value = Math.round(storrelse);
  el('pStorrelseVerdi').textContent = `${Math.round(storrelse)} %`;

  const varighet = o.end - o.start;
  el('pVarighet').value = Math.round(varighet * 10);
  el('pVarighetVerdi').textContent = `${varighet.toFixed(1).replace('.', ',')} s`;
}

function endrePalegg(patch) {
  if (!app.valgtPalegg) return;
  endre((e) => {
    const o = e.overlays.find((x) => x.id === app.valgtPalegg);
    if (o) Object.assign(o, patch);
  }, { historikk: false });
}

/* ---------------------------------------------------------------- beskjæring */

function startBeskjaering() {
  app.beskjaerModus = true;
  const c = app.project.edit.crop || { x: 0, y: 0, w: 1, h: 1 };
  app.beskjaerRekt = { ...c };
  el('beskjaerLag').classList.remove('skjult');
  el('beskjaerPa').textContent = 'Bruk beskjæring';
  tegnBeskjaerRute();
}

function avsluttBeskjaering(bruk) {
  if (bruk && app.beskjaerRekt) {
    const r = app.beskjaerRekt;
    const helt = r.x <= 0.001 && r.y <= 0.001 && r.w >= 0.999 && r.h >= 0.999;
    endre((e) => { e.crop = helt ? null : { ...r }; });
  }
  app.beskjaerModus = false;
  el('beskjaerLag').classList.add('skjult');
  el('beskjaerPa').textContent = 'Beskjær bildet';
}

function lerretsRammen() {
  const boks = el('lerretsboks').getBoundingClientRect();
  const r = lerret.getBoundingClientRect();
  return { venstre: r.left - boks.left, topp: r.top - boks.top, bredde: r.width, hoyde: r.height };
}

function tegnBeskjaerRute() {
  if (!app.beskjaerRekt) return;
  const f = lerretsRammen();
  const r = app.beskjaerRekt;
  const rute = el('beskjaerRute');
  rute.style.left = `${f.venstre + r.x * f.bredde}px`;
  rute.style.top = `${f.topp + r.y * f.hoyde}px`;
  rute.style.width = `${r.w * f.bredde}px`;
  rute.style.height = `${r.h * f.hoyde}px`;
}

function koblePaBeskjaering() {
  const lag = el('beskjaerLag');
  let drag = null;

  lag.addEventListener('mousedown', (e) => {
    const f = lerretsRammen();
    const boks = el('lerretsboks').getBoundingClientRect();
    const px = (e.clientX - boks.left - f.venstre) / f.bredde;
    const py = (e.clientY - boks.top - f.topp) / f.hoyde;
    const hjorne = e.target.classList.contains('hjorne') ? [...e.target.classList].find((c) => ['nv', 'no', 'sv', 'so'].includes(c)) : null;
    drag = { hjorne, px, py, start: { ...app.beskjaerRekt }, flytt: !hjorne && e.target.id === 'beskjaerRute' };
    if (!hjorne && !drag.flytt) {
      // Klikk utenfor rammen starter en helt ny beskjæring.
      app.beskjaerRekt = { x: Math.max(0, Math.min(1, px)), y: Math.max(0, Math.min(1, py)), w: 0.001, h: 0.001 };
      drag = { hjorne: 'so', px, py, start: { ...app.beskjaerRekt } };
    }
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!drag || !app.beskjaerModus) return;
    const f = lerretsRammen();
    const boks = el('lerretsboks').getBoundingClientRect();
    const px = (e.clientX - boks.left - f.venstre) / f.bredde;
    const py = (e.clientY - boks.top - f.topp) / f.hoyde;
    const dx = px - drag.px;
    const dy = py - drag.py;
    const s = drag.start;
    let r = { ...s };

    if (drag.flytt) {
      r.x = Math.max(0, Math.min(1 - s.w, s.x + dx));
      r.y = Math.max(0, Math.min(1 - s.h, s.y + dy));
    } else if (drag.hjorne) {
      const vest = drag.hjorne.includes('v');
      const nord = drag.hjorne.startsWith('n');
      const x0 = vest ? Math.min(s.x + dx, s.x + s.w - 0.02) : s.x;
      const x1 = vest ? s.x + s.w : Math.max(s.x + s.w + dx, s.x + 0.02);
      const y0 = nord ? Math.min(s.y + dy, s.y + s.h - 0.02) : s.y;
      const y1 = nord ? s.y + s.h : Math.max(s.y + s.h + dy, s.y + 0.02);
      r = { x: Math.max(0, x0), y: Math.max(0, y0), w: Math.min(1, x1) - Math.max(0, x0), h: Math.min(1, y1) - Math.max(0, y0) };
    }
    app.beskjaerRekt = r;
    tegnBeskjaerRute();
  });

  window.addEventListener('mouseup', () => { drag = null; });
  window.addEventListener('resize', () => { if (app.beskjaerModus) tegnBeskjaerRute(); });
}

/* ------------------------------------------------------------------ eksport */

let eksportSignal = null;

async function kjorEksport() {
  if (!app.project) return;
  if (app.spiller) pause();
  await lagre();

  el('modal').classList.remove('skjult');
  el('modalTittel').textContent = 'Eksporterer …';
  el('modalTekst').textContent = 'Spiller inn bilder i sanntid.';
  el('modalFyll').style.width = '0%';
  el('modalKnapp').textContent = 'Avbryt';
  eksportSignal = { avbrutt: false };

  const av = window.studio.eksport.onFremdrift(({ step, progress }) => {
    el('modalTekst').textContent = step;
    el('modalFyll').style.width = `${Math.round(progress * 100)}%`;
  });

  try {
    const res = await eksporter({
      project: app.project,
      projectFile: app.projectFile,
      skjermVideo,
      kameraVideo: app.project.source.camera ? kameraVideo : null,
      bilder: app.bilder,
      filnavn: el('eksportNavn').value || `${app.project.name}.mp4`,
      avbrytSignal: eksportSignal,
      onProgress: ({ step, progress }) => {
        el('modalTekst').textContent = step;
        el('modalFyll').style.width = `${Math.round(progress * 100)}%`;
      },
    });

    el('modalTittel').textContent = 'Ferdig eksportert';
    el('modalTekst').textContent = res.output;
    el('modalFyll').style.width = '100%';
    el('modalKnapp').textContent = 'Lukk';
    loggEksport(res.output);
  } catch (err) {
    el('modalTittel').textContent = 'Eksporten stoppet';
    el('modalTekst').textContent = err.message;
    el('modalKnapp').textContent = 'Lukk';
  } finally {
    av();
    eksportSignal = null;
  }
}

function loggEksport(sti) {
  const rad = document.createElement('div');
  rad.className = 'element';
  const tekst = document.createElement('span');
  tekst.className = 'tekst';
  tekst.textContent = sti.split(/[\\/]/).pop();
  const vis = document.createElement('button');
  vis.textContent = 'Vis i mappe';
  vis.addEventListener('click', () => window.studio.filer.visIMappe(sti));
  rad.append(tekst, vis);
  el('eksportlogg').prepend(rad);
}

/* ---------------------------------------------------------------- hendelser */

function koblePaHendelser() {
  el('spill').addEventListener('click', vekslePlay);
  el('tilStart').addEventListener('click', () => { pause(); settPlayhead(app.segments[0]?.start ?? 0); });
  el('tilSlutt').addEventListener('click', () => { pause(); settPlayhead(app.project.source.duration); });
  el('zoomInn').addEventListener('click', () => app.tidslinje.zoom(1.5, app.playhead));
  el('zoomUt').addEventListener('click', () => app.tidslinje.zoom(1 / 1.5, app.playhead));
  el('zoomAlt').addEventListener('click', () => app.tidslinje.visAlt());

  el('nesteStille').addEventListener('click', () => {
    const s = nextSilence(app.stillhet, app.playhead);
    if (s) { pause(); settPlayhead(s.start); app.valg = s; app.tidslinje.sett({ selection: s }); oppdaterValgInfo(); }
  });
  el('forrigeStille').addEventListener('click', () => {
    const s = prevSilence(app.stillhet, app.playhead);
    if (s) { pause(); settPlayhead(s.start); app.valg = s; app.tidslinje.sett({ selection: s }); oppdaterValgInfo(); }
  });

  el('angre').addEventListener('click', () => gjenopprett(app.historikk.angre()));
  el('gjorOm').addEventListener('click', () => gjenopprett(app.historikk.gjorOm()));
  el('lagre').addEventListener('click', lagre);
  el('visMappe').addEventListener('click', () => window.studio.filer.apne(app.project.dir));
  el('eksporter').addEventListener('click', kjorEksport);
  el('eksporter2').addEventListener('click', kjorEksport);
  el('modalKnapp').addEventListener('click', () => {
    if (eksportSignal) eksportSignal.avbrutt = true;
    el('modal').classList.add('skjult');
  });

  // Faner
  for (const knapp of document.querySelectorAll('[data-fane]')) {
    knapp.addEventListener('click', () => {
      document.querySelectorAll('[data-fane]').forEach((b) => b.classList.toggle('aktiv', b === knapp));
      document.querySelectorAll('[data-innhold]').forEach((d) => {
        d.classList.toggle('skjult', d.dataset.innhold !== knapp.dataset.fane);
      });
    });
  }

  // Klipping
  el('klippValg').addEventListener('click', () => {
    if (!app.valg) return;
    const v = app.valg;
    endre((e) => { e.cuts = normalizeRanges([...e.cuts, v], app.project.source.duration); });
    app.valg = null;
    app.tidslinje.sett({ selection: null });
    oppdaterValgInfo();
  });
  el('nullstillValg').addEventListener('click', () => {
    app.valg = null;
    app.tidslinje.sett({ selection: null });
    oppdaterValgInfo();
  });

  el('terskel').addEventListener('input', (e) => { el('terskelVerdi').textContent = `${e.target.value} dB`; });
  el('minLengde').addEventListener('input', (e) => {
    el('minLengdeVerdi').textContent = `${(Number(e.target.value) / 10).toFixed(1).replace('.', ',')} s`;
  });
  el('analyserStillhet').addEventListener('click', analyser);
  el('fjernStillhet').addEventListener('click', () => {
    const nye = silenceToCuts(app.stillhet, { padding: 0.15, minDuration: 0.8, duration: app.project.source.duration });
    if (!nye.length) return;
    endre((e) => { e.cuts = normalizeRanges([...e.cuts, ...nye], app.project.source.duration); });
  });

  el('beskjaerPa').addEventListener('click', () => (app.beskjaerModus ? avsluttBeskjaering(true) : startBeskjaering()));
  el('beskjaerAv').addEventListener('click', () => {
    if (app.beskjaerModus) avsluttBeskjaering(false);
    endre((e) => { e.crop = null; });
  });
  koblePaBeskjaering();

  // Kamera
  const kameraBrytere = ['kfX', 'kfY', 'kfStorrelse'];
  for (const id of kameraBrytere) {
    el(id).addEventListener('input', () => {
      app.kameraUtkast = {
        x: Number(el('kfX').value) / 100,
        y: Number(el('kfY').value) / 100,
        size: Number(el('kfStorrelse').value) / 100,
        mode: el('modusFull').classList.contains('aktiv') ? 'full' : 'bubble',
      };
      el('kfXVerdi').textContent = `${el('kfX').value} %`;
      el('kfYVerdi').textContent = `${el('kfY').value} %`;
      el('kfStorrelseVerdi').textContent = `${el('kfStorrelse').value} %`;
    });
    // Nøkkelpunktet settes når glidebryteren slippes.
    el(id).addEventListener('change', settKeyframeFraUtkast);
  }

  el('modusBoble').addEventListener('click', () => {
    const b = sisteBoble();
    app.kameraUtkast = { x: b.x, y: b.y, size: b.size, mode: 'bubble' };
    settKeyframeFraUtkast();
  });
  el('modusFull').addEventListener('click', () => {
    const n = naverendeKamera();
    app.kameraUtkast = { ...n, mode: 'full' };
    settKeyframeFraUtkast();
  });
  el('settKeyframe').addEventListener('click', () => {
    app.kameraUtkast = app.kameraUtkast || naverendeKamera();
    settKeyframeFraUtkast();
  });
  el('slettKeyframe').addEventListener('click', () => {
    endre((e) => { e.cameraKeyframes = removeKeyframeAt(e.cameraKeyframes, app.playhead, 0.15); });
  });
  el('hjornebryter').addEventListener('click', () => {
    const b = sisteBoble();
    app.kameraUtkast = { x: b.x, y: b.y, size: b.size, mode: 'bubble' };
    settKeyframeFraUtkast();
  });
  el('overgang').addEventListener('input', (e) => {
    const v = Number(e.target.value) / 10;
    el('overgangVerdi').textContent = `${v.toFixed(1).replace('.', ',')} s`;
    endre((ed) => { ed.cameraTransition = v; }, { historikk: false });
  });
  el('forhandsvisOvergang').addEventListener('click', forhandsvisOvergang);

  // Pålegg
  el('leggTilBilde').addEventListener('click', async () => {
    const filer = await window.studio.filer.velgBilder();
    for (const f of filer) {
      const kopi = await window.studio.filer.kopierTilProsjekt(app.projectFile, f);
      const id = leggTilPalegg({ type: 'image', src: kopi, name: f.split(/[\\/]/).pop(), w: 0.35, h: 0.35 });
      const dataUrl = await window.studio.filer.lesSomDataUrl(kopi);
      const img = new Image();
      img.src = dataUrl;
      app.bilder.set(id, img);
    }
  });
  el('leggTilTekst').addEventListener('click', () => leggTilPalegg({ type: 'text', text: 'Ny tekst', fontSize: 0.05, x: 0.08, y: 0.08 }));
  el('leggTilPil').addEventListener('click', () => leggTilPalegg({ type: 'arrow', x: 0.25, y: 0.25, x2: 0.45, y2: 0.45, color: '#ff4d5a' }));
  el('leggTilMarkering').addEventListener('click', () => leggTilPalegg({ type: 'highlight', x: 0.3, y: 0.3, w: 0.3, h: 0.2 }));

  el('paleggTekst').addEventListener('input', (e) => endrePalegg({ text: e.target.value }));
  el('px').addEventListener('input', (e) => {
    el('pxVerdi').textContent = `${e.target.value} %`;
    endrePalegg({ x: Number(e.target.value) / 100 });
  });
  el('py').addEventListener('input', (e) => {
    el('pyVerdi').textContent = `${e.target.value} %`;
    endrePalegg({ y: Number(e.target.value) / 100 });
  });
  el('pStorrelse').addEventListener('input', (e) => {
    const v = Number(e.target.value) / 100;
    el('pStorrelseVerdi').textContent = `${e.target.value} %`;
    const o = app.project.edit.overlays.find((x) => x.id === app.valgtPalegg);
    if (!o) return;
    endrePalegg(o.type === 'text' ? { fontSize: v } : { w: v, h: v });
  });
  el('pVarighet').addEventListener('input', (e) => {
    const v = Number(e.target.value) / 10;
    el('pVarighetVerdi').textContent = `${v.toFixed(1).replace('.', ',')} s`;
    const o = app.project.edit.overlays.find((x) => x.id === app.valgtPalegg);
    if (o) endrePalegg({ end: Math.min(app.project.source.duration, o.start + v) });
  });
  el('slettPalegg').addEventListener('click', () => {
    const id = app.valgtPalegg;
    if (!id) return;
    endre((e) => { e.overlays = e.overlays.filter((o) => o.id !== id); });
    app.bilder.delete(id);
    app.valgtPalegg = null;
    app.tidslinje.sett({ valgtPalegg: null });
    oppdaterPaleggPanel();
  });

  el('crf').addEventListener('input', (e) => { el('crfVerdi').textContent = e.target.value; });

  // Hurtigtaster i editoren
  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    const ctrlEller = e.ctrlKey || e.metaKey;

    if (e.code === 'Space') { e.preventDefault(); vekslePlay(); return; }
    if (ctrlEller && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      gjenopprett(e.shiftKey ? app.historikk.gjorOm() : app.historikk.angre());
      return;
    }
    if (ctrlEller && e.key.toLowerCase() === 's') { e.preventDefault(); lagre(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && app.valg) { e.preventDefault(); el('klippValg').click(); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); settPlayhead(app.playhead + (e.shiftKey ? 1 : 1 / 30)); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); settPlayhead(app.playhead - (e.shiftKey ? 1 : 1 / 30)); return; }
    if (e.key.toLowerCase() === 's') { el('nesteStille').click(); }
    if (e.key.toLowerCase() === 'k') { el('settKeyframe').click(); }
  });

  window.addEventListener('beforeunload', () => { if (!app.lagret) lagre(); });
}

function settKeyframeFraUtkast() {
  if (!app.kameraUtkast) return;
  const kf = { ...app.kameraUtkast, t: app.playhead };
  endre((e) => { e.cameraKeyframes = upsertKeyframe(e.cameraKeyframes, kf); });
  app.kameraUtkast = null;
  app.tidslinje.sett({ valgtKeyframe: kf.t });
  oppdaterKameraGlidebrytere();
}

/** Spiller av litt før og etter nærmeste overgang, så den kan vurderes. */
function forhandsvisOvergang() {
  const kfer = sortKeyframes(app.project.edit.cameraKeyframes || []);
  if (kfer.length < 2) return;
  let naermest = kfer[0];
  let beste = Infinity;
  for (let i = 1; i < kfer.length; i++) {
    if (kfer[i].mode === kfer[i - 1].mode) continue;
    const avstand = Math.abs(kfer[i].t - app.playhead);
    if (avstand < beste) { beste = avstand; naermest = kfer[i]; }
  }
  const overgang = app.project.edit.cameraTransition ?? 0.6;
  const fra = Math.max(0, naermest.t - overgang - 0.8);
  const til = Math.min(app.project.source.duration, naermest.t + 1.2);

  pause();
  settPlayhead(fra);
  spillAv();
  const stopp = setInterval(() => {
    if (!app.spiller || app.playhead >= til) { pause(); clearInterval(stopp); }
  }, 60);
}

// Et lite håndtak for feilsøking og den automatiske røyktesten.
// Alt her finnes allerede i grensesnittet; dette er bare samme funksjoner
// gjort tilgjengelige fra konsollen.
window.__skjermstudio = { app, endre, settPlayhead, kjorEksport, analyser, spillAv, pause };

init().catch((err) => {
  document.body.insertAdjacentHTML('afterbegin',
    `<div style="padding:20px;color:#ff4d5a">Kunne ikke åpne prosjektet: ${err.message}</div>`);
});
