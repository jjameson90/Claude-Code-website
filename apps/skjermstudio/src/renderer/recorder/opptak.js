// Opptaksvinduet: velger kilde og enheter, og kjører selve opptaket.
// Selve filskrivingen skjer i hovedprosessen — her strømmer vi bare biter dit.

const el = (id) => document.getElementById(id);

const state = {
  innstillinger: null,
  kilder: [],
  valgtKilde: null,
  filter: 'alle',
  tarOpp: false,
  pauset: false,
  startet: 0,
  tidsur: null,
};

// Aktive MediaRecorder-objekter og strømmer for skjermsporet.
const opptaker = { recorder: null, strommer: [], lydkontekst: null, forsteBilde: 0 };

/* ------------------------------------------------------------- oppstart */

async function init() {
  // Lytterne kobles på først. Trykkes hurtigtasten rett etter oppstart, må
  // beskjeden fra hovedprosessen ha noen å komme til.
  koblePaHendelser();

  state.innstillinger = await window.studio.innstillinger.hent();
  visInnstillinger();

  state.plattform = await window.studio.analyse.plattform();
  visPlattformhint();

  const ff = await window.studio.analyse.ffmpeg();
  const merke = el('ffmpegStatus');
  merke.textContent = ff.ok ? 'FFmpeg klar' : 'FFmpeg mangler';
  merke.className = `merkelapp ${ff.ok ? 'ok' : 'feil'}`;
  merke.title = ff.ok ? ff.version || ff.path : ff.error || '';

  await sikreEnhetstilgang();
  await Promise.all([lastKilder(), lastEnheter(), lastSisteOpptak()]);
  window.__klar = true;
}

/**
 * Nettleseren skjuler enhetsnavn før brukeren har gitt tilgang én gang.
 * Vi ber derfor om en kort strøm og slipper den med en gang.
 */
async function sikreEnhetstilgang() {
  for (const constraints of [{ audio: true }, { video: true }]) {
    try {
      const s = await navigator.mediaDevices.getUserMedia(constraints);
      s.getTracks().forEach((t) => t.stop());
    } catch {
      // Nektet eller ingen enhet — listene blir da tomme, og det er greit.
    }
  }
}

function visInnstillinger() {
  const s = state.innstillinger;
  el('brukMik').checked = s.captureMic;
  el('brukSystemlyd').checked = s.captureSystemAudio;
  el('brukKamera').checked = s.captureCamera;
  el('hurtigtastStart').value = s.hotkeyToggle;
  el('hurtigtastPause').value = s.hotkeyPause;
  el('bobleStorrelse').value = Math.round(s.bubble.size * 100);
  el('bobleVerdi').textContent = `${Math.round(s.bubble.size * 100)} %`;
  oppdaterKameraFelt();

}

/** Systemlyd og skjulte overleggsvinduer virker ulikt på de tre plattformene. */
function visPlattformhint() {
  const p = state.plattform;
  if (!p) return;

  if (!p.loopback) {
    el('systemlydHint').textContent =
      'Denne plattformen støtter ikke direkte opptak av systemlyd. Velg i stedet '
      + 'en «monitor»- eller loopback-enhet i mikrofonlisten over.';
    el('brukSystemlyd').checked = false;
    el('brukSystemlyd').disabled = true;
  }

  if (!p.skjermbeskyttelse) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.style.marginTop = '8px';
    hint.textContent = 'På denne plattformen kan ikke kameraboblen holdes utenfor skjermopptaket. '
      + 'Den blir da synlig to ganger. Skjul boblen under opptak for å unngå det:';
    const bryter = document.createElement('label');
    bryter.className = 'bryter';
    bryter.style.marginTop = '8px';
    bryter.innerHTML = '<input type="checkbox" id="skjulBoble" /><span class="spor"></span><span>Skjul boblen under opptak</span>';
    el('bobleFelt').append(hint, bryter);
    const avkryssing = el('skjulBoble');
    avkryssing.checked = Boolean(state.innstillinger.skjulBobleUnderOpptak);
    avkryssing.addEventListener('change', (e) => lagre({ skjulBobleUnderOpptak: e.target.checked }));
  }
}

/* ---------------------------------------------------------------- kilder */

async function lastKilder() {
  state.kilder = await window.studio.kilder.liste();
  if (!state.valgtKilde && state.kilder.length) {
    state.valgtKilde = state.kilder.find((k) => k.kind === 'skjerm')?.id || state.kilder[0].id;
  }
  tegnKilder();
}

function tegnKilder() {
  const liste = el('kildeliste');
  liste.innerHTML = '';
  const synlige = state.kilder.filter((k) => state.filter === 'alle' || k.kind === state.filter);

  if (!synlige.length) {
    liste.innerHTML = '<p class="hint">Fant ingen kilder. Trykk «Oppdater».</p>';
    return;
  }

  for (const kilde of synlige) {
    const kort = document.createElement('div');
    kort.className = `kilde${kilde.id === state.valgtKilde ? ' valgt' : ''}`;
    kort.title = kilde.name;

    const bilde = document.createElement('img');
    if (kilde.thumbnail) bilde.src = kilde.thumbnail;
    const navn = document.createElement('div');
    navn.className = 'navn';
    navn.textContent = kilde.name;

    kort.append(bilde, navn);
    kort.addEventListener('click', () => { state.valgtKilde = kilde.id; tegnKilder(); });
    liste.appendChild(kort);
  }
}

async function lastEnheter() {
  const enheter = await navigator.mediaDevices.enumerateDevices();
  fyllListe(el('mikrofon'), enheter.filter((d) => d.kind === 'audioinput'), state.innstillinger.micDeviceId, 'Systemets standardmikrofon');
  fyllListe(el('kamera'), enheter.filter((d) => d.kind === 'videoinput'), state.innstillinger.cameraDeviceId, 'Første tilgjengelige kamera');
}

function fyllListe(select, enheter, valgt, standardTekst) {
  select.innerHTML = '';
  const standard = document.createElement('option');
  standard.value = '';
  standard.textContent = standardTekst;
  select.appendChild(standard);

  for (const d of enheter) {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || `Enhet ${d.deviceId.slice(0, 6)}`;
    select.appendChild(o);
  }
  select.value = enheter.some((d) => d.deviceId === valgt) ? valgt : '';
}

async function lastSisteOpptak() {
  const prosjekter = await window.studio.prosjekt.liste();
  const boks = el('sisteOpptak');
  boks.innerHTML = '';
  if (!prosjekter.length) return;

  const merkelapp = document.createElement('span');
  merkelapp.className = 'hint';
  merkelapp.style.alignSelf = 'center';
  merkelapp.textContent = 'Siste opptak:';
  boks.appendChild(merkelapp);

  for (const p of prosjekter.slice(0, 5)) {
    const knapp = document.createElement('button');
    knapp.className = 'stille';
    knapp.textContent = `${p.name} · ${formatterTid(p.duration)}`;
    knapp.addEventListener('click', () => window.studio.prosjekt.apneEditor(p.file));
    boks.appendChild(knapp);
  }
}

/* ------------------------------------------------------------- hendelser */

function koblePaHendelser() {
  el('oppdaterKilder').addEventListener('click', lastKilder);

  for (const knapp of document.querySelectorAll('[data-filter]')) {
    knapp.addEventListener('click', () => {
      state.filter = knapp.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('aktiv', b === knapp));
      tegnKilder();
    });
  }
  for (const knapp of document.querySelectorAll('[data-omrade]')) {
    knapp.addEventListener('click', () => {
      document.querySelectorAll('[data-omrade]').forEach((b) => b.classList.toggle('aktiv', b === knapp));
    });
  }

  el('brukMik').addEventListener('change', (e) => lagre({ captureMic: e.target.checked }));
  el('brukSystemlyd').addEventListener('change', (e) => lagre({ captureSystemAudio: e.target.checked }));
  el('brukKamera').addEventListener('change', (e) => { lagre({ captureCamera: e.target.checked }); oppdaterKameraFelt(); });
  el('mikrofon').addEventListener('change', (e) => lagre({ micDeviceId: e.target.value }));
  el('kamera').addEventListener('change', (e) => lagre({ cameraDeviceId: e.target.value }));

  el('bobleStorrelse').addEventListener('input', (e) => {
    const size = Number(e.target.value) / 100;
    el('bobleVerdi').textContent = `${e.target.value} %`;
    state.innstillinger.bubble = { ...state.innstillinger.bubble, size };
    window.studio.boble.settGeometri(state.innstillinger.bubble);
  });

  el('visBoble').addEventListener('click', async () => {
    const pa = el('visBoble').classList.toggle('aktiv');
    await window.studio.boble.forhandsvis(pa, el('kamera').value);
    el('visBoble').textContent = pa ? 'Skjul boble' : 'Vis boble';
  });

  el('startStopp').addEventListener('click', () => (state.tarOpp ? window.studio.opptak.stopp() : startOpptak()));
  el('apneMappe').addEventListener('click', () => window.studio.filer.apneOpptaksmappe());
  el('apneProsjekt').addEventListener('click', async () => {
    const fil = await window.studio.prosjekt.velg();
    if (fil) window.studio.prosjekt.apneEditor(fil);
  });

  settOppHurtigtastfelt(el('hurtigtastStart'), 'hotkeyToggle');
  settOppHurtigtastfelt(el('hurtigtastPause'), 'hotkeyPause');

  // Hovedprosessen styrer opptaket; her reagerer vi bare på beskjeder.
  window.studio.opptak.onBeOmStart(() => { if (!state.tarOpp) startOpptak(); });
  window.studio.opptak.onStart((opts) => startSkjermopptak(opts));
  window.studio.opptak.onStopp(() => stoppSkjermopptak());
  window.studio.opptak.onPause(({ paused }) => {
    if (!opptaker.recorder) return;
    if (paused) opptaker.recorder.pause();
    else opptaker.recorder.resume();
  });
  window.studio.opptak.onTilstand(visTilstand);
  window.studio.opptak.onFremdrift(({ step, progress }) => visFremdrift(step, progress));
  window.studio.opptak.onFerdig(() => { skjulFremdrift(); lastSisteOpptak(); });
  window.studio.opptak.onFeil(({ error }) => { skjulFremdrift(); visFeil(error); });
}

function oppdaterKameraFelt() {
  const på = el('brukKamera').checked;
  el('kamera').disabled = !på;
  el('bobleFelt').style.opacity = på ? '1' : '0.4';
  el('bobleFelt').style.pointerEvents = på ? 'auto' : 'none';
}

async function lagre(patch) {
  state.innstillinger = await window.studio.innstillinger.lagre(patch);
}

function settOppHurtigtastfelt(input, nokkel) {
  input.addEventListener('keydown', async (e) => {
    e.preventDefault();
    const deler = [];
    if (e.ctrlKey || e.metaKey) deler.push('CommandOrControl');
    if (e.shiftKey) deler.push('Shift');
    if (e.altKey) deler.push('Alt');
    const tast = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(tast)) return;
    deler.push(tast);
    const kombinasjon = deler.join('+');
    input.value = kombinasjon;
    await lagre({ [nokkel]: kombinasjon });
    input.blur();
  });
}

/* ---------------------------------------------------------- selve opptaket */

async function startOpptak() {
  if (!state.valgtKilde) { visFeil('Velg hva som skal tas opp først.'); return; }
  const res = await window.studio.opptak.start({
    display: { sourceId: state.valgtKilde, systemAudio: el('brukSystemlyd').checked },
    mic: el('brukMik').checked,
    micDeviceId: el('mikrofon').value,
    camera: el('brukKamera').checked,
    cameraDeviceId: el('kamera').value,
    systemAudio: el('brukSystemlyd').checked,
  });
  if (!res.ok) visFeil(res.error);
}

/** Velger det beste opptaksformatet nettleseren i Electron støtter. */
function velgMimeType() {
  const kandidater = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=h264,opus',
    'video/webm',
  ];
  return kandidater.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

async function startSkjermopptak(opts) {
  try {
    const fps = state.innstillinger.fps || 30;

    // Hovedprosessen har allerede valgt kilden, så her ber vi bare om strømmen.
    const skjerm = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: fps, max: 60 } },
      audio: opts.systemAudio !== false,
    });
    opptaker.strommer.push(skjerm);

    const lydspor = [];
    const kontekst = new AudioContext({ sampleRate: 48000 });
    const miks = kontekst.createMediaStreamDestination();
    opptaker.lydkontekst = kontekst;

    if (skjerm.getAudioTracks().length) {
      const kilde = kontekst.createMediaStreamSource(new MediaStream(skjerm.getAudioTracks()));
      const gain = kontekst.createGain();
      gain.gain.value = 0.85; // litt hodrom slik at systemlyden ikke overdøver stemmen
      kilde.connect(gain).connect(miks);
      lydspor.push('systemlyd');
    }

    if (opts.mic) {
      try {
        const mik = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: opts.micDeviceId ? { exact: opts.micDeviceId } : undefined,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        opptaker.strommer.push(mik);
        const kilde = kontekst.createMediaStreamSource(mik);
        kilde.connect(miks);
        lydspor.push('mikrofon');
      } catch (err) {
        console.warn('Mikrofonen kunne ikke åpnes:', err);
      }
    }

    const spor = [...skjerm.getVideoTracks()];
    if (lydspor.length) spor.push(...miks.stream.getAudioTracks());
    const samlet = new MediaStream(spor);

    await window.studio.opptak.apneFil('skjerm');
    const recorder = new MediaRecorder(samlet, {
      mimeType: velgMimeType(),
      videoBitsPerSecond: state.innstillinger.videoBitrate || 8_000_000,
      audioBitsPerSecond: 192_000,
    });
    opptaker.recorder = recorder;

    recorder.ondataavailable = async (e) => {
      if (!e.data || !e.data.size) return;
      await window.studio.opptak.skriv('skjerm', await e.data.arrayBuffer());
    };
    recorder.onstop = async () => {
      await window.studio.opptak.lukkFil('skjerm', opptaker.forsteBilde);
      ryddOpp();
    };

    // Brukeren kan stoppe delingen fra systemets egen linje.
    skjerm.getVideoTracks()[0].addEventListener('ended', () => {
      if (state.tarOpp) window.studio.opptak.stopp();
    });

    recorder.start(1000);
    opptaker.forsteBilde = Date.now();
  } catch (err) {
    console.error(err);
    await window.studio.opptak.avbryt(`Kunne ikke starte skjermopptaket: ${err.message}`);
    ryddOpp();
  }
}

function stoppSkjermopptak() {
  if (opptaker.recorder && opptaker.recorder.state !== 'inactive') {
    visFremdrift('Avslutter opptak …', 0.05);
    opptaker.recorder.stop();
  }
}

function ryddOpp() {
  opptaker.recorder = null;
  for (const s of opptaker.strommer) s.getTracks().forEach((t) => t.stop());
  opptaker.strommer = [];
  if (opptaker.lydkontekst) { opptaker.lydkontekst.close().catch(() => {}); opptaker.lydkontekst = null; }
}

/* ---------------------------------------------------------------- visning */

function visTilstand(s) {
  state.tarOpp = s.active;
  state.pauset = s.paused;
  state.startet = s.startedAt;

  const prikk = el('statusPrikk');
  prikk.className = `prikk${s.active ? (s.paused ? ' pauset' : ' tar-opp') : ''}`;
  el('statusTekst').textContent = s.active ? (s.paused ? 'Pauset' : 'Tar opp') : 'Klar til opptak';
  el('startStopp').textContent = s.active ? 'Stopp opptak' : 'Start opptak';
  el('startStopp').className = s.active ? 'fare stor' : 'primar stor';

  clearInterval(state.tidsur);
  if (s.active) {
    state.tidsur = setInterval(() => {
      el('statusTid').textContent = formatterTid((Date.now() - state.startet) / 1000);
    }, 250);
  } else {
    el('statusTid').textContent = '';
  }
}

function visFremdrift(tekst, andel) {
  el('fremdrift').classList.remove('skjult');
  el('fremdriftTekst').textContent = tekst;
  el('fremdriftFyll').style.width = `${Math.round((andel || 0) * 100)}%`;
}

function skjulFremdrift() { el('fremdrift').classList.add('skjult'); }

function visFeil(melding) {
  el('statusTekst').textContent = melding;
  el('statusPrikk').className = 'prikk';
  console.error(melding);
}

function formatterTid(sekunder) {
  const s = Math.max(0, Math.floor(sekunder || 0));
  const t = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return t ? `${t}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

init().catch((err) => visFeil(err.message));
