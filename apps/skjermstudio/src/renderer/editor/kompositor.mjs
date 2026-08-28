// Kompositoren tegner ett ferdig bilde: skjerm, kamera og påleggene over.
// Nøyaktig samme funksjon brukes både til forhåndsvisning og til eksport,
// slik at det du ser er det du får.

import { sampleCamera, cameraRect } from '../../shared/keyframes.mjs';

/** Utdataoppløsningen etter beskjæring. Alltid partall (H.264-krav). */
export function utdataStorrelse(project) {
  const { width, height } = project.source;
  const c = project.edit.crop;
  const w = c ? Math.round(width * c.w) : width;
  const h = c ? Math.round(height * c.h) : height;
  return { width: Math.max(2, w - (w % 2)), height: Math.max(2, h - (h % 2)) };
}

/** Kildeutsnittet i skjermvideoen som skal fylle lerretet. */
function skjermUtsnitt(project, videoW, videoH) {
  const c = project.edit.crop;
  if (!c) return { sx: 0, sy: 0, sw: videoW, sh: videoH };
  return { sx: c.x * videoW, sy: c.y * videoH, sw: c.w * videoW, sh: c.h * videoH };
}

/** Rektangel som dekker målflaten uten å strekke bildet (cover). */
function dekkende(kildeW, kildeH, malW, malH) {
  if (!kildeW || !kildeH) return { sx: 0, sy: 0, sw: kildeW || 1, sh: kildeH || 1 };
  const kildeForhold = kildeW / kildeH;
  const malForhold = malW / malH;
  if (kildeForhold > malForhold) {
    const sw = kildeH * malForhold;
    return { sx: (kildeW - sw) / 2, sy: 0, sw, sh: kildeH };
  }
  const sh = kildeW / malForhold;
  return { sx: 0, sy: (kildeH - sh) / 2, sw: kildeW, sh };
}

function avrundetRekt(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, radius);
  else {
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }
}

/**
 * Tegner ett bilde av den ferdige videoen.
 * `sourceTime` er tid i originalopptaket — all animasjon er forankret der,
 * slik at klipping ikke forskyver kameraet eller påleggene.
 */
export function tegnBilde(ctx, project, { skjermVideo, kameraVideo, sourceTime, bilder = new Map(), speilKamera = true }) {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;

  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  // 1. Skjermopptaket, eventuelt beskåret.
  if (skjermVideo && skjermVideo.videoWidth) {
    const u = skjermUtsnitt(project, skjermVideo.videoWidth, skjermVideo.videoHeight);
    ctx.drawImage(skjermVideo, u.sx, u.sy, u.sw, u.sh, 0, 0, W, H);
  }

  // 2. Kameraet: rund boble, full skjerm, eller midt i overgangen.
  const kf = project.edit.cameraKeyframes || [];
  if (kameraVideo && kameraVideo.videoWidth && kf.length) {
    const tilstand = sampleCamera(kf, sourceTime, { transition: project.edit.cameraTransition ?? 0.6 });
    const r = cameraRect(tilstand, W, H);
    if (r.w > 1 && r.h > 1) {
      const d = dekkende(kameraVideo.videoWidth, kameraVideo.videoHeight, r.w, r.h);

      ctx.save();
      avrundetRekt(ctx, r.x, r.y, r.w, r.h, r.radius);
      ctx.clip();
      if (speilKamera) {
        // Speilvendt, slik brukeren så seg selv i forhåndsvisningen.
        ctx.translate(r.x + r.w, r.y);
        ctx.scale(-1, 1);
        ctx.drawImage(kameraVideo, d.sx, d.sy, d.sw, d.sh, 0, 0, r.w, r.h);
      } else {
        ctx.drawImage(kameraVideo, d.sx, d.sy, d.sw, d.sh, r.x, r.y, r.w, r.h);
      }
      ctx.restore();

      // Hvit ring rundt boblen, som tones ut når kameraet fyller bildet.
      if (r.fullness < 0.98) {
        ctx.save();
        ctx.globalAlpha = 1 - r.fullness;
        ctx.lineWidth = Math.max(2, H * 0.004);
        ctx.strokeStyle = 'rgba(255,255,255,0.92)';
        avrundetRekt(ctx, r.x, r.y, r.w, r.h, r.radius);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // 3. Pålegg: bilder, tekst, piler og markeringer.
  for (const o of project.edit.overlays || []) {
    if (sourceTime < o.start || sourceTime > o.end) continue;
    const alpha = inntoning(o, sourceTime);
    if (alpha <= 0.01) continue;
    ctx.save();
    ctx.globalAlpha = alpha;
    tegnPalegg(ctx, o, W, H, bilder);
    ctx.restore();
  }

  ctx.restore();
}

/** Myk inn- og uttoning i endene av påleggets levetid. */
function inntoning(o, t) {
  const fade = o.fade ?? 0.25;
  if (fade <= 0) return 1;
  const inn = Math.min(1, (t - o.start) / fade);
  const ut = Math.min(1, (o.end - t) / fade);
  return Math.max(0, Math.min(inn, ut));
}

function tegnPalegg(ctx, o, W, H, bilder) {
  const x = o.x * W;
  const y = o.y * H;
  const w = (o.w ?? 0.3) * W;
  const h = (o.h ?? 0.3) * H;

  if (o.type === 'image') {
    const img = bilder.get(o.id);
    if (!img || !img.complete || !img.naturalWidth) return;
    // Bildet skaleres inn i rammen uten å bli strukket.
    const forhold = Math.min(w / img.naturalWidth, h / img.naturalHeight);
    const bw = img.naturalWidth * forhold;
    const bh = img.naturalHeight * forhold;
    const bx = x + (w - bw) / 2;
    const by = y + (h - bh) / 2;
    if (o.shadow !== false) {
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = H * 0.02;
      ctx.shadowOffsetY = H * 0.006;
    }
    if (o.radius) {
      avrundetRekt(ctx, bx, by, bw, bh, o.radius * H);
      ctx.save();
      ctx.clip();
      ctx.drawImage(img, bx, by, bw, bh);
      ctx.restore();
    } else {
      ctx.drawImage(img, bx, by, bw, bh);
    }
    return;
  }

  if (o.type === 'text') {
    const storrelse = (o.fontSize ?? 0.05) * H;
    ctx.font = `600 ${storrelse}px -apple-system, "Segoe UI", Inter, sans-serif`;
    ctx.textBaseline = 'top';
    const linjer = String(o.text || '').split('\n');
    const bredde = Math.max(...linjer.map((l) => ctx.measureText(l).width));
    const pad = storrelse * 0.45;
    const boksH = linjer.length * storrelse * 1.25 + pad * 2;

    if (o.background !== false) {
      ctx.fillStyle = o.backgroundColor || 'rgba(16,18,22,0.82)';
      avrundetRekt(ctx, x - pad, y - pad, bredde + pad * 2, boksH, storrelse * 0.3);
      ctx.fill();
    }
    ctx.fillStyle = o.color || '#ffffff';
    linjer.forEach((linje, i) => ctx.fillText(linje, x, y + i * storrelse * 1.25));
    return;
  }

  if (o.type === 'arrow') {
    const x2 = (o.x2 ?? o.x + 0.15) * W;
    const y2 = (o.y2 ?? o.y + 0.1) * H;
    const tykkelse = (o.thickness ?? 0.006) * H;
    ctx.strokeStyle = o.color || '#ff4d5a';
    ctx.fillStyle = o.color || '#ff4d5a';
    ctx.lineWidth = tykkelse;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    const vinkel = Math.atan2(y2 - y, x2 - x);
    const spiss = tykkelse * 4;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - spiss * Math.cos(vinkel - Math.PI / 7), y2 - spiss * Math.sin(vinkel - Math.PI / 7));
    ctx.lineTo(x2 - spiss * Math.cos(vinkel + Math.PI / 7), y2 - spiss * Math.sin(vinkel + Math.PI / 7));
    ctx.closePath();
    ctx.fill();
    return;
  }

  if (o.type === 'highlight') {
    ctx.strokeStyle = o.color || '#fbbf24';
    ctx.lineWidth = (o.thickness ?? 0.005) * H;
    if (o.fill !== false) {
      ctx.fillStyle = o.fillColor || 'rgba(251,191,36,0.16)';
      avrundetRekt(ctx, x, y, w, h, H * 0.012);
      ctx.fill();
    }
    avrundetRekt(ctx, x, y, w, h, H * 0.012);
    ctx.stroke();
  }
}
