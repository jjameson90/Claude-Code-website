// Kameraboblen er både forhåndsvisning og selve kameraopptakeren.
// Ved å ta opp her unngår vi å åpne kameraet to ganger, og brukeren ser
// nøyaktig hvor boblen står før opptaket begynner.

const video = document.getElementById('video');
const ring = document.getElementById('ring');

let strom = null;
let recorder = null;
let geometri = null;

window.studio.innstillinger.hent().then((s) => { geometri = { ...s.bubble }; });

async function apneKamera(deviceId) {
  if (strom) strom.getTracks().forEach((t) => t.stop());
  strom = await navigator.mediaDevices.getUserMedia({
    video: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
    audio: false, // mikrofonen håndteres av skjermsporet
  });
  video.srcObject = strom;
  return strom;
}

window.studio.boble.onForhandsvis(async ({ deviceId }) => {
  try { await apneKamera(deviceId); } catch (err) { console.error('Kamera:', err); }
});

window.studio.boble.onStartOpptak(async ({ deviceId }) => {
  try {
    const s = await apneKamera(deviceId);
    await window.studio.opptak.apneFil('kamera');

    const kandidater = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    recorder = new MediaRecorder(s, {
      mimeType: kandidater.find((t) => MediaRecorder.isTypeSupported(t)) || '',
      videoBitsPerSecond: 4_000_000,
    });

    let forsteBilde = 0;
    recorder.ondataavailable = async (e) => {
      if (!e.data || !e.data.size) return;
      await window.studio.opptak.skriv('kamera', await e.data.arrayBuffer());
    };
    recorder.onstop = async () => {
      await window.studio.opptak.lukkFil('kamera', forsteBilde);
      ring.classList.remove('tar-opp');
      recorder = null;
    };

    recorder.start(1000);
    forsteBilde = Date.now();
    ring.classList.add('tar-opp');
  } catch (err) {
    console.error('Kameraopptak feilet:', err);
    // Skjermopptaket skal fortsette selv om kameraet svikter — vi melder
    // fra at sporet er «ferdig» slik at etterbehandlingen ikke henger.
    await window.studio.opptak.lukkFil('kamera', 0);
  }
});

window.studio.boble.onStoppOpptak(() => {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
});

window.studio.opptak.onPause(({ paused }) => {
  if (!recorder) return;
  if (paused) recorder.pause(); else recorder.resume();
});

// Rullehjulet endrer størrelsen. Hovedprosessen flytter selve vinduet og
// lagrer den normaliserte plasseringen som kameraets første nøkkelpunkt.
window.addEventListener('wheel', (e) => {
  if (!geometri) return;
  e.preventDefault();
  const steg = e.deltaY > 0 ? -0.015 : 0.015;
  geometri = { ...geometri, size: Math.min(0.6, Math.max(0.1, geometri.size + steg)) };
  window.studio.boble.settGeometri(geometri);
}, { passive: false });
