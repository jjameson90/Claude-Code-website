// Den lille indikatoren som alltid ligger øverst mens et opptak pågår.
// Vinduet slipper museklikk gjennom, så den er aldri i veien.

const pille = document.getElementById('pille');
const prikk = document.getElementById('prikk');
const tidFelt = document.getElementById('tid');
const tekst = document.getElementById('tekst');

let startet = 0;
let tidsur = null;

window.studio.innstillinger.hent().then((s) => {
  document.getElementById('hurtigtast').textContent = (s.hotkeyToggle || '')
    .replace('CommandOrControl', navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl');
});

window.studio.overlegg.onTilstand((s) => {
  clearInterval(tidsur);

  if (s.processing) {
    pille.classList.add('synlig');
    prikk.className = 'prikk behandler';
    tekst.textContent = 'behandler';
    tidFelt.textContent = '';
    return;
  }

  if (!s.active) { pille.classList.remove('synlig'); return; }

  startet = s.startedAt || Date.now();
  pille.classList.add('synlig');
  prikk.className = s.paused ? 'prikk pauset' : 'prikk blinker';
  tekst.textContent = s.paused ? 'pauset' : 'tar opp';

  const tikk = () => { tidFelt.textContent = formatter((Date.now() - startet) / 1000); };
  tikk();
  if (!s.paused) tidsur = setInterval(tikk, 500);
});

function formatter(sekunder) {
  const s = Math.max(0, Math.floor(sekunder));
  const t = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return t ? `${t}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
