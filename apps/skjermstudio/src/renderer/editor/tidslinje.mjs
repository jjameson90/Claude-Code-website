// Tidslinjen tegnes på et lerret: linjal, lydbølge med stillhetsmarkering,
// bortklippede partier, kameraets nøkkelpunkter og påleggene.
// Den viser originalens tidsakse — da ligger bølgeformen i ro selv om du
// klipper, og du ser tydelig hva som er fjernet.

const LINJAL_H = 22;
const BOLGE_H = 92;
const KEYFRAME_H = 24;
const PALEGG_H = 26;
export const TOTAL_H = LINJAL_H + BOLGE_H + KEYFRAME_H + PALEGG_H;

const FARGER = {
  bakgrunn: '#12151b',
  linjal: '#8892a4',
  rute: '#232833',
  bolge: '#4f8cff',
  bolgeSvak: '#2b4a80',
  stillhet: 'rgba(251, 191, 36, 0.16)',
  stillhetKant: 'rgba(251, 191, 36, 0.5)',
  klipp: 'rgba(255, 77, 90, 0.22)',
  klippKant: 'rgba(255, 77, 90, 0.75)',
  valg: 'rgba(79, 140, 255, 0.22)',
  valgKant: '#4f8cff',
  spillehode: '#ffffff',
  keyframe: '#34d399',
  keyframeFull: '#a78bfa',
  palegg: '#fb923c',
};

export class Tidslinje {
  constructor(canvas, handlers = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.h = handlers;

    this.data = {
      duration: 0,
      peaks: [],
      silence: [],
      cuts: [],
      keyframes: [],
      overlays: [],
      playhead: 0,
      selection: null,
      valgtKeyframe: null,
      valgtPalegg: null,
    };
    this.view = { start: 0, end: 0 };
    this.drag = null;

    this._koblePaMus();
    this.observer = new ResizeObserver(() => this.tegn());
    this.observer.observe(canvas.parentElement || canvas);
  }

  sett(patch) {
    Object.assign(this.data, patch);
    if (patch.duration && this.view.end <= this.view.start) {
      this.view = { start: 0, end: patch.duration };
    }
    this.tegn();
  }

  /* ------------------------------------------------------- koordinater */

  get bredde() { return this.canvas.width / (window.devicePixelRatio || 1); }

  tidTilX(t) {
    const span = Math.max(1e-6, this.view.end - this.view.start);
    return ((t - this.view.start) / span) * this.bredde;
  }

  xTilTid(x) {
    const span = Math.max(1e-6, this.view.end - this.view.start);
    return this.view.start + (x / this.bredde) * span;
  }

  zoom(faktor, senterTid) {
    const span = (this.view.end - this.view.start) / faktor;
    const minSpan = Math.min(0.5, this.data.duration);
    const nySpan = Math.max(minSpan, Math.min(this.data.duration, span));
    const andel = (senterTid - this.view.start) / Math.max(1e-6, this.view.end - this.view.start);
    let start = senterTid - andel * nySpan;
    start = Math.max(0, Math.min(this.data.duration - nySpan, start));
    this.view = { start, end: start + nySpan };
    this.tegn();
  }

  visAlt() { this.view = { start: 0, end: this.data.duration }; this.tegn(); }

  /** Ruller sideveis slik at spillehodet holder seg synlig. */
  folgSpillehode(t) {
    const span = this.view.end - this.view.start;
    if (span >= this.data.duration - 0.01) return;
    if (t < this.view.start || t > this.view.end - span * 0.1) {
      const start = Math.max(0, Math.min(this.data.duration - span, t - span * 0.35));
      this.view = { start, end: start + span };
    }
  }

  /* ------------------------------------------------------------ tegning */

  tegn() {
    const dpr = window.devicePixelRatio || 1;
    const bredde = this.canvas.clientWidth || 800;
    this.canvas.width = Math.round(bredde * dpr);
    this.canvas.height = Math.round(TOTAL_H * dpr);
    this.canvas.style.height = `${TOTAL_H}px`;

    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, bredde, TOTAL_H);
    ctx.fillStyle = FARGER.bakgrunn;
    ctx.fillRect(0, 0, bredde, TOTAL_H);

    if (!this.data.duration) return;

    this._tegnLinjal();
    this._tegnBolge();
    this._tegnBand(this.data.silence, FARGER.stillhet, FARGER.stillhetKant, LINJAL_H, BOLGE_H);
    this._tegnBand(this.data.cuts, FARGER.klipp, FARGER.klippKant, LINJAL_H, BOLGE_H, true);
    if (this.data.selection) {
      this._tegnBand([this.data.selection], FARGER.valg, FARGER.valgKant, LINJAL_H, BOLGE_H);
    }
    this._tegnKeyframes();
    this._tegnPalegg();
    this._tegnSpillehode();
  }

  _tegnLinjal() {
    const ctx = this.ctx;
    const span = this.view.end - this.view.start;
    const steg = velgSteg(span, this.bredde);

    ctx.fillStyle = '#0d1015';
    ctx.fillRect(0, 0, this.bredde, LINJAL_H);
    ctx.strokeStyle = FARGER.rute;
    ctx.fillStyle = FARGER.linjal;
    ctx.font = '10px -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';

    const forste = Math.ceil(this.view.start / steg) * steg;
    for (let t = forste; t <= this.view.end; t += steg) {
      const x = Math.round(this.tidTilX(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, TOTAL_H);
      ctx.globalAlpha = 0.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
      // Ved fin oppløsning trengs desimaler, ellers gjentas samme etikett.
      ctx.fillText(formatterTid(t, steg < 1), x + 4, LINJAL_H / 2);
    }
  }

  _tegnBolge() {
    const { peaks } = this.data;
    if (!peaks || !peaks.length) return;
    const ctx = this.ctx;
    const midt = LINJAL_H + BOLGE_H / 2;
    const halv = BOLGE_H / 2 - 6;
    const bredde = Math.ceil(this.bredde);

    ctx.fillStyle = FARGER.bolge;
    for (let x = 0; x < bredde; x++) {
      const t0 = this.xTilTid(x);
      const t1 = this.xTilTid(x + 1);
      const i0 = Math.max(0, Math.floor((t0 / this.data.duration) * peaks.length));
      const i1 = Math.min(peaks.length, Math.max(i0 + 1, Math.ceil((t1 / this.data.duration) * peaks.length)));
      let topp = 0;
      for (let i = i0; i < i1; i++) if (peaks[i] > topp) topp = peaks[i];
      const h = Math.max(1, topp * halv);
      ctx.fillRect(x, midt - h, 1, h * 2);
    }

    ctx.strokeStyle = FARGER.bolgeSvak;
    ctx.beginPath();
    ctx.moveTo(0, midt + 0.5);
    ctx.lineTo(this.bredde, midt + 0.5);
    ctx.stroke();
  }

  _tegnBand(omrader, fyll, kant, y, h, skravert = false) {
    const ctx = this.ctx;
    for (const r of omrader || []) {
      const x0 = this.tidTilX(r.start);
      const x1 = this.tidTilX(r.end);
      if (x1 < 0 || x0 > this.bredde) continue;
      const b = Math.max(1, x1 - x0);
      ctx.fillStyle = fyll;
      ctx.fillRect(x0, y, b, h);

      if (skravert) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, y, b, h);
        ctx.clip();
        ctx.strokeStyle = 'rgba(255,77,90,0.35)';
        ctx.lineWidth = 1;
        for (let x = x0 - h; x < x1 + h; x += 8) {
          ctx.beginPath();
          ctx.moveTo(x, y + h);
          ctx.lineTo(x + h, y);
          ctx.stroke();
        }
        ctx.restore();
      }

      ctx.strokeStyle = kant;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0 + 0.5, y);
      ctx.lineTo(x0 + 0.5, y + h);
      ctx.moveTo(x1 - 0.5, y);
      ctx.lineTo(x1 - 0.5, y + h);
      ctx.stroke();
    }
  }

  _tegnKeyframes() {
    const ctx = this.ctx;
    const y = LINJAL_H + BOLGE_H + KEYFRAME_H / 2;
    ctx.fillStyle = '#0f1319';
    ctx.fillRect(0, LINJAL_H + BOLGE_H, this.bredde, KEYFRAME_H);
    ctx.fillStyle = '#5b6577';
    ctx.font = '9px -apple-system, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('KAMERA', 6, y);

    const kfer = this.data.keyframes || [];
    // Linje mellom nøkkelpunktene, så bevegelsen er lett å lese.
    if (kfer.length > 1) {
      ctx.strokeStyle = 'rgba(52, 211, 153, 0.35)';
      ctx.beginPath();
      ctx.moveTo(this.tidTilX(kfer[0].t), y);
      for (const k of kfer) ctx.lineTo(this.tidTilX(k.t), y);
      ctx.stroke();
    }

    for (const k of kfer) {
      const x = this.tidTilX(k.t);
      if (x < -8 || x > this.bredde + 8) continue;
      const valgt = this.data.valgtKeyframe != null && Math.abs(this.data.valgtKeyframe - k.t) < 0.02;
      ctx.fillStyle = k.mode === 'full' ? FARGER.keyframeFull : FARGER.keyframe;
      ctx.strokeStyle = valgt ? '#fff' : 'rgba(0,0,0,0.5)';
      ctx.lineWidth = valgt ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x + 6, y);
      ctx.lineTo(x, y + 6);
      ctx.lineTo(x - 6, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  _tegnPalegg() {
    const ctx = this.ctx;
    const y = LINJAL_H + BOLGE_H + KEYFRAME_H;
    ctx.fillStyle = '#0f1319';
    ctx.fillRect(0, y, this.bredde, PALEGG_H);
    ctx.fillStyle = '#5b6577';
    ctx.font = '9px -apple-system, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('PÅLEGG', 6, y + PALEGG_H / 2);

    for (const o of this.data.overlays || []) {
      const x0 = this.tidTilX(o.start);
      const x1 = this.tidTilX(o.end);
      if (x1 < 0 || x0 > this.bredde) continue;
      const valgt = this.data.valgtPalegg === o.id;
      ctx.fillStyle = valgt ? 'rgba(251,146,60,0.55)' : 'rgba(251,146,60,0.3)';
      ctx.strokeStyle = FARGER.palegg;
      ctx.lineWidth = valgt ? 2 : 1;
      const b = Math.max(3, x1 - x0);
      ctx.fillRect(x0, y + 5, b, PALEGG_H - 12);
      ctx.strokeRect(x0 + 0.5, y + 5.5, b - 1, PALEGG_H - 13);
      if (b > 40) {
        ctx.fillStyle = '#fff';
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0 + 3, y, b - 6, PALEGG_H);
        ctx.clip();
        ctx.fillText(etikett(o), x0 + 6, y + PALEGG_H / 2);
        ctx.restore();
      }
    }
  }

  _tegnSpillehode() {
    const x = Math.round(this.tidTilX(this.data.playhead)) + 0.5;
    if (x < 0 || x > this.bredde) return;
    const ctx = this.ctx;
    ctx.strokeStyle = FARGER.spillehode;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, TOTAL_H);
    ctx.stroke();
    ctx.fillStyle = FARGER.spillehode;
    ctx.beginPath();
    ctx.moveTo(x - 5, 0);
    ctx.lineTo(x + 5, 0);
    ctx.lineTo(x, 8);
    ctx.closePath();
    ctx.fill();
  }

  /* ---------------------------------------------------------- musestyring */

  _koblePaMus() {
    const c = this.canvas;

    c.addEventListener('mousedown', (e) => {
      const { x, y } = this._pos(e);
      const t = this.xTilTid(x);

      const kfBand = y >= LINJAL_H + BOLGE_H && y < LINJAL_H + BOLGE_H + KEYFRAME_H;
      if (kfBand) {
        const truffet = (this.data.keyframes || []).find((k) => Math.abs(this.tidTilX(k.t) - x) < 8);
        if (truffet) {
          this.drag = { type: 'keyframe', fra: truffet.t };
          this.h.onKeyframeValgt?.(truffet.t);
          return;
        }
        this.h.onSeek?.(Math.max(0, Math.min(this.data.duration, t)));
        return;
      }

      const paleggBand = y >= LINJAL_H + BOLGE_H + KEYFRAME_H;
      if (paleggBand) {
        const truffet = [...(this.data.overlays || [])].reverse()
          .find((o) => x >= this.tidTilX(o.start) - 3 && x <= this.tidTilX(o.end) + 3);
        this.h.onPaleggValgt?.(truffet ? truffet.id : null);
        if (truffet) {
          const venstre = Math.abs(this.tidTilX(truffet.start) - x) < 6;
          const hoyre = Math.abs(this.tidTilX(truffet.end) - x) < 6;
          this.drag = {
            type: 'palegg',
            id: truffet.id,
            kant: venstre ? 'start' : hoyre ? 'end' : null,
            gripTid: t,
            start: truffet.start,
            end: truffet.end,
          };
        }
        return;
      }

      // Bølgeområdet: klikk flytter spillehodet, dra lager en markering.
      this.drag = { type: 'valg', fra: t };
      this.h.onSeek?.(Math.max(0, Math.min(this.data.duration, t)));
      this.h.onSelection?.(null);
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.drag) {
        this._settPeker(e);
        return;
      }
      const { x } = this._pos(e);
      const t = Math.max(0, Math.min(this.data.duration, this.xTilTid(x)));

      if (this.drag.type === 'valg') {
        if (Math.abs(t - this.drag.fra) > 0.02) {
          this.h.onSelection?.({ start: Math.min(this.drag.fra, t), end: Math.max(this.drag.fra, t) });
        }
      } else if (this.drag.type === 'keyframe') {
        this.h.onKeyframeFlyttet?.(this.drag.fra, t);
        this.drag.fra = t;
      } else if (this.drag.type === 'palegg') {
        const d = this.drag;
        if (d.kant === 'start') this.h.onPaleggEndret?.(d.id, { start: Math.min(t, d.end - 0.1) });
        else if (d.kant === 'end') this.h.onPaleggEndret?.(d.id, { end: Math.max(t, d.start + 0.1) });
        else {
          const forskyv = t - d.gripTid;
          this.h.onPaleggEndret?.(d.id, { start: d.start + forskyv, end: d.end + forskyv });
        }
      }
    });

    window.addEventListener('mouseup', () => { this.drag = null; });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const { x } = this._pos(e);
      const t = this.xTilTid(x);
      if (e.ctrlKey || e.metaKey || !e.shiftKey) {
        this.zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2, t);
      } else {
        const span = this.view.end - this.view.start;
        const flytt = (e.deltaY / this.bredde) * span;
        const start = Math.max(0, Math.min(this.data.duration - span, this.view.start + flytt));
        this.view = { start, end: start + span };
        this.tegn();
      }
    }, { passive: false });

    c.addEventListener('dblclick', (e) => {
      const { y } = this._pos(e);
      if (y >= LINJAL_H + BOLGE_H && y < LINJAL_H + BOLGE_H + KEYFRAME_H) {
        const { x } = this._pos(e);
        const truffet = (this.data.keyframes || []).find((k) => Math.abs(this.tidTilX(k.t) - x) < 8);
        if (truffet) this.h.onKeyframeSlettet?.(truffet.t);
      }
    });
  }

  _settPeker(e) {
    const { x, y } = this._pos(e);
    if (x < 0 || x > this.bredde || y < 0 || y > TOTAL_H) return;
    let peker = 'default';
    if (y >= LINJAL_H && y < LINJAL_H + BOLGE_H) peker = 'text';
    else if (y >= LINJAL_H + BOLGE_H && y < LINJAL_H + BOLGE_H + KEYFRAME_H) {
      peker = (this.data.keyframes || []).some((k) => Math.abs(this.tidTilX(k.t) - x) < 8) ? 'grab' : 'default';
    } else if (y >= LINJAL_H + BOLGE_H + KEYFRAME_H) {
      const o = (this.data.overlays || []).find((p) => x >= this.tidTilX(p.start) - 3 && x <= this.tidTilX(p.end) + 3);
      if (o) {
        const nærKant = Math.abs(this.tidTilX(o.start) - x) < 6 || Math.abs(this.tidTilX(o.end) - x) < 6;
        peker = nærKant ? 'ew-resize' : 'grab';
      }
    }
    this.canvas.style.cursor = peker;
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
}

function etikett(o) {
  if (o.type === 'image') return o.name || 'Bilde';
  if (o.type === 'text') return (o.text || 'Tekst').split('\n')[0].slice(0, 24);
  if (o.type === 'arrow') return 'Pil';
  return 'Markering';
}

function velgSteg(span, bredde) {
  const onsket = span / Math.max(4, bredde / 90);
  const steg = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  return steg.find((s) => s >= onsket) || 3600;
}

export function formatterTid(sekunder, medDesimal = false) {
  const s = Math.max(0, sekunder || 0);
  const t = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n) => String(Math.floor(n)).padStart(2, '0');
  const sek = medDesimal ? (r < 10 ? `0${r.toFixed(1)}` : r.toFixed(1)) : pad(r);
  return t ? `${t}:${pad(m)}:${sek}` : `${m}:${sek}`;
}
