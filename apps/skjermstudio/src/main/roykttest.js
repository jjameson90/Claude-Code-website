'use strict';
// Røyktest: starter appen med syntetiske medieenheter, tar opp noen sekunder,
// redigerer resultatet og eksporterer det — og kontrollerer hvert steg.
// Kjøres med `npm run roykttest` (krever en X-skjerm, f.eks. via xvfb-run).
//
//   ROYKTTEST_SEKUNDER=8            hvor langt prøveopptaket skal være
//   ROYKTTEST_SKJERMBILDER=<mappe>  lagrer skjermbilder av vinduene

const fs = require('node:fs');
const path = require('node:path');

const SEKUNDER = Number(process.env.ROYKTTEST_SEKUNDER || 5);
const logg = [];

function si(tekst, ok = null) {
  const merke = ok === null ? '·' : ok ? '✓' : '✗';
  console.log(`  ${merke} ${tekst}`);
  logg.push({ tekst, ok });
}

function forOppstart(app) {
  // Syntetisk kamera og mikrofon, og automatisk ja til medietillatelser.
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('auto-select-desktop-capture-source', 'Entire screen');
}

/** Venter til et vindu svarer på at grensesnittet er ferdig initialisert. */
async function ventPa(webContents, uttrykk, forsok = 80) {
  for (let i = 0; i < forsok; i++) {
    const klar = await webContents.executeJavaScript(uttrykk).catch(() => false);
    if (klar) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function lagreSkjermbilder(BrowserWindow) {
  const mappe = process.env.ROYKTTEST_SKJERMBILDER;
  if (!mappe) return;
  fs.mkdirSync(mappe, { recursive: true });
  for (const w of BrowserWindow.getAllWindows()) {
    const navn = (w.getTitle() || 'vindu').replace(/[^\wæøåÆØÅ-]+/g, '-').toLowerCase();
    try {
      const bilde = await w.webContents.capturePage();
      fs.writeFileSync(path.join(mappe, `${navn}.png`), bilde.toPNG());
      si(`Skjermbilde lagret: ${navn}.png`, true);
    } catch (err) {
      si(`Skjermbilde feilet for ${navn}: ${err.message}`, false);
    }
  }
}

async function kjor({ app, startRecording, stopRecording, settings, hentVindu }) {
  let feil = 0;
  const sjekk = (tekst, betingelse) => {
    si(tekst, Boolean(betingelse));
    if (!betingelse) feil += 1;
  };

  try {
    console.log('\nRøyktest for Skjermstudio');
    console.log('─'.repeat(52));

    const { desktopCapturer, BrowserWindow } = require('electron');
    const ffmpeg = require('./ffmpeg');

    // Meldinger fra grensesnittet er ofte fasit når noe svikter.
    const lyttPaKonsoll = (w) => {
      w.webContents.on('console-message', (...args) => {
        const d = args[0];
        const melding = d && typeof d === 'object' && 'message' in d ? d.message : args[2];
        const nivaa = d && typeof d === 'object' && 'level' in d ? d.level : args[1];
        if (String(nivaa) === 'info' || String(nivaa) === '1') return;
        console.log(`    [${w.getTitle() || 'vindu'}] ${melding}`);
      });
    };
    BrowserWindow.getAllWindows().forEach(lyttPaKonsoll);
    app.on('browser-window-created', (_e, w) => lyttPaKonsoll(w));

    /* ---- Fase 1: opptak ------------------------------------------------- */

    const ff = await ffmpeg.check();
    sjekk(`FFmpeg tilgjengelig (${ff.version || ff.error})`, ff.ok);

    const kilder = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    sjekk(`Fant ${kilder.length} opptakskilder`, kilder.length > 0);
    if (!kilder.length) throw new Error('Ingen skjermkilder — kjører du uten X-skjerm?');

    const vindu = hentVindu();
    await new Promise((r) => (vindu.webContents.isLoading()
      ? vindu.webContents.once('did-finish-load', r)
      : r()));
    sjekk('Opptaksvinduet er lastet', true);

    const enheter = await vindu.webContents.executeJavaScript(
      'navigator.mediaDevices.enumerateDevices().then((d) => d.map((x) => x.kind))'
    );
    sjekk(`Mediaenheter synlige (${enheter.join(', ') || 'ingen'})`, enheter.length > 0);
    sjekk('Grensesnittet er klart', await ventPa(vindu.webContents, 'Boolean(window.__klar)', 60));

    // Hovedprosessen kaller disse krokene når etterbehandlingen er ferdig.
    const ferdig = new Promise((resolve, avvis) => {
      global.__roykttestFerdig = resolve;
      global.__roykttestFeil = (melding) => avvis(new Error(melding));
    });

    si(`Starter opptak på «${kilder[0].name}» i ${SEKUNDER} sekunder …`);
    const start = await startRecording({
      display: { sourceId: kilder[0].id, systemAudio: false },
      mic: true,
      micDeviceId: '',
      camera: true,
      cameraDeviceId: '',   // tomt = standardkamera
      systemAudio: false,
    });
    sjekk(`Opptaksmappe opprettet (${start.dir ? path.basename(start.dir) : 'nei'})`, start.ok);

    await new Promise((r) => setTimeout(r, SEKUNDER * 1000));
    await stopRecording();
    si('Opptaket stoppet, venter på etterbehandling …');

    const resultat = await Promise.race([
      ferdig,
      new Promise((_, avvis) => setTimeout(() => avvis(new Error('Tidsavbrudd i etterbehandlingen')), 120_000)),
    ]);

    const dir = resultat.dir;
    const skjerm = path.join(dir, 'skjerm.mp4');
    const kamera = path.join(dir, 'kamera.mp4');
    const prosjekt = path.join(dir, 'prosjekt.json');

    sjekk('skjerm.mp4 ble skrevet', fs.existsSync(skjerm) && fs.statSync(skjerm).size > 10_000);
    sjekk('kamera.mp4 ble skrevet', fs.existsSync(kamera) && fs.statSync(kamera).size > 5_000);
    sjekk('prosjekt.json ble skrevet', fs.existsSync(prosjekt));
    sjekk('rå webm-filer er ryddet bort', !fs.existsSync(path.join(dir, 'skjerm.webm')));

    const skjermStorrelseFor = fs.statSync(skjerm).size;
    const skjermInfo = await ffmpeg.probe(skjerm);
    sjekk(`Skjermopptak: ${skjermInfo.width}x${skjermInfo.height}, ${skjermInfo.duration.toFixed(1)} s`,
      skjermInfo.duration > SEKUNDER * 0.5 && skjermInfo.width > 0);
    sjekk('Skjermopptaket har lydspor', skjermInfo.hasAudio);

    const kameraInfo = await ffmpeg.probe(kamera);
    sjekk(`Kameraopptak: ${kameraInfo.width}x${kameraInfo.height}, ${kameraInfo.duration.toFixed(1)} s`,
      kameraInfo.duration > SEKUNDER * 0.5 && kameraInfo.width > 0);

    const p = JSON.parse(fs.readFileSync(prosjekt, 'utf8'));
    sjekk('Prosjektet peker på begge sporene', Boolean(p.source.screen && p.source.camera));
    sjekk(`Kameraforskyvning målt (${(p.source.cameraOffset ?? 0).toFixed(3)} s)`, Number.isFinite(p.source.cameraOffset));
    sjekk('Kameraet har et startnøkkelpunkt', (p.edit.cameraKeyframes || []).length === 1);
    sjekk('Ingen klipp er lagt inn på forhånd', (p.edit.cuts || []).length === 0);

    /* ---- Fase 2: redigering og eksport ---------------------------------- */

    const editor = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('redigering'));
    sjekk('Redigeringsvinduet åpnet seg automatisk', Boolean(editor));
    if (!editor) throw new Error('Editoren åpnet seg ikke');

    const lastet = await ventPa(editor.webContents,
      'Boolean(window.__skjermstudio && window.__skjermstudio.app.project && window.__skjermstudio.app.segments.length)');
    sjekk('Prosjektet er lastet i editoren', lastet);

    // Lydanalysen kjører i bakgrunnen når prosjektet åpnes.
    await ventPa(editor.webContents, 'window.__skjermstudio.app.peaks.length > 0', 60);

    const tilstand = await editor.webContents.executeJavaScript(`(() => {
      const s = window.__skjermstudio;
      return {
        lengde: s.app.project.source.duration,
        bolge: s.app.peaks.length,
        kamera: Boolean(s.app.project.source.camera),
        status: document.getElementById('stillhetInfo').textContent,
      };
    })()`);
    sjekk(`Editoren leste opptaket (${tilstand.lengde.toFixed(1)} s, ${tilstand.bolge} bølgepunkter)`,
      tilstand.lengde > 1 && tilstand.bolge > 0);
    sjekk(`Stillhetsanalysen svarte («${tilstand.status}»)`, Boolean(tilstand.status));
    sjekk('Kamerasporet er tilgjengelig i editoren', tilstand.kamera);

    // Klipp bort ett sekund på midten, og la kameraet fylle bildet mot slutten.
    const etter = await editor.webContents.executeJavaScript(`(() => {
      const s = window.__skjermstudio;
      const d = s.app.project.source.duration;
      s.endre((e) => { e.cuts = [{ start: d * 0.4, end: d * 0.4 + 1 }]; });
      s.endre((e) => {
        e.cameraKeyframes = [
          { t: 0, x: 0.85, y: 0.8, size: 0.28, mode: 'bubble' },
          { t: d * 0.7, x: 0.5, y: 0.5, size: 0.28, mode: 'full' },
        ];
      });
      s.settPlayhead(d * 0.2);
      return {
        klipp: s.app.project.edit.cuts.length,
        segmenter: s.app.segments.length,
        redigertLengde: s.app.segments.reduce((a, x) => a + (x.end - x.start), 0),
        kanAngre: s.app.historikk.kanAngre,
      };
    })()`);
    sjekk(`Klipp lagt inn (${etter.segmenter} segmenter, ${etter.redigertLengde.toFixed(1)} s igjen)`,
      etter.klipp === 1 && etter.segmenter === 2);
    sjekk('Angre er tilgjengelig etter endring', etter.kanAngre);

    // Angre og gjør om skal treffe nøyaktig tilbake.
    const angret = await editor.webContents.executeJavaScript(`(() => {
      const s = window.__skjermstudio;
      const forVi = s.app.project.edit.cuts.length;
      s.app.historikk.angre();
      return { forVi };
    })()`);
    sjekk('Historikken holder på stegene', angret.forVi === 1);

    await new Promise((r) => setTimeout(r, 600)); // la forhåndsvisningen tegne et bilde
    await lagreSkjermbilder(BrowserWindow);

    si('Eksporterer (går i sanntid) …');
    const eksport = await editor.webContents.executeJavaScript(`(async () => {
      const s = window.__skjermstudio;
      document.getElementById('eksportNavn').value = 'roykttest.mp4';
      await s.kjorEksport();
      return {
        tittel: document.getElementById('modalTittel').textContent,
        tekst: document.getElementById('modalTekst').textContent,
      };
    })()`, true);
    sjekk(`Eksporten fullførte (${eksport.tittel}: ${eksport.tekst})`, eksport.tittel.includes('Ferdig'));

    const utfil = path.join(dir, 'eksport', 'roykttest.mp4');
    sjekk('Eksportert MP4 finnes', fs.existsSync(utfil));
    if (fs.existsSync(utfil)) {
      const info = await ffmpeg.probe(utfil);
      const ventet = etter.redigertLengde;
      sjekk(`Eksport: ${info.width}x${info.height}, ${info.duration.toFixed(2)} s (ventet ${ventet.toFixed(2)} s)`,
        Math.abs(info.duration - ventet) < 0.35);
      sjekk('Eksporten har lydspor', info.hasAudio);
    }

    sjekk('Originalopptaket er urørt etter redigering og eksport',
      fs.statSync(skjerm).size === skjermStorrelseFor);
    sjekk('Prosjektfilen ble lagret ved eksport', JSON.parse(fs.readFileSync(prosjekt, 'utf8')).edit.cuts.length === 1);

    console.log('─'.repeat(52));
    const antall = logg.filter((l) => l.ok !== null).length;
    console.log(feil
      ? `Røyktest: ${feil} feil av ${antall} sjekker\n`
      : `Røyktest: alle ${antall} sjekker gikk gjennom\n`);
    app.exit(feil ? 1 : 0);
  } catch (err) {
    console.error(`\n  ✗ Røyktesten stoppet: ${err.message}\n`);
    app.exit(1);
  }
}

module.exports = { forOppstart, kjor, SEKUNDER };
