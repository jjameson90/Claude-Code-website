// Nøkkelpunkter for kameraboblen: posisjon, størrelse og full skjerm.
// Koordinater er normaliserte (0-1) slik at de følger med uansett oppløsning.
//   x, y  : boblens senter, andel av bredde/høyde
//   size  : boblens diameter, andel av bildehøyden
//   mode  : 'bubble' (rund boble) eller 'full' (kamera fyller bildet)

export const DEFAULT_CAMERA_KEYFRAME = { t: 0, x: 0.85, y: 0.8, size: 0.28, mode: 'bubble' };

export function easeInOutCubic(p) {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

export function sortKeyframes(keyframes) {
  return [...(keyframes || [])].sort((a, b) => a.t - b.t);
}

/** Legger til eller erstatter et nøkkelpunkt på tidspunkt `t` (0,02 s toleranse). */
export function upsertKeyframe(keyframes, kf) {
  const list = sortKeyframes(keyframes).filter((k) => Math.abs(k.t - kf.t) > 0.02);
  list.push({ ...kf });
  return sortKeyframes(list);
}

export function removeKeyframeAt(keyframes, t, tolerance = 0.02) {
  return sortKeyframes(keyframes).filter((k) => Math.abs(k.t - t) > tolerance);
}

/**
 * Beregner kameraets tilstand ved tidspunkt `t`.
 * `fullness` er 0 for rund boble og 1 for full skjerm; mellomverdier gir den
 * myke overgangen. Overgangen varer maks `transition` sekunder og lander
 * nøyaktig på det senere nøkkelpunktet.
 */
export function sampleCamera(keyframes, t, { transition = 0.6 } = {}) {
  const list = sortKeyframes(keyframes);
  if (!list.length) return { ...DEFAULT_CAMERA_KEYFRAME, fullness: 0 };
  if (t <= list[0].t) return toState(list[0], list[0].mode === 'full' ? 1 : 0);

  const last = list[list.length - 1];
  if (t >= last.t) return toState(last, last.mode === 'full' ? 1 : 0);

  let a = list[0];
  let b = list[1];
  for (let i = 0; i < list.length - 1; i++) {
    if (t >= list[i].t && t <= list[i + 1].t) { a = list[i]; b = list[i + 1]; break; }
  }

  const span = Math.max(b.t - a.t, 1e-6);
  const p = easeInOutCubic(Math.min(1, Math.max(0, (t - a.t) / span)));

  const state = {
    x: a.x + (b.x - a.x) * p,
    y: a.y + (b.y - a.y) * p,
    size: a.size + (b.size - a.size) * p,
    mode: p < 1 ? a.mode : b.mode,
  };

  const fromFull = a.mode === 'full' ? 1 : 0;
  const toFull = b.mode === 'full' ? 1 : 0;
  let fullness = fromFull;
  if (fromFull !== toFull) {
    // Hold tilstanden, og kjør overgangen i de siste `transition` sekundene.
    const dur = Math.min(transition, span);
    const startT = b.t - dur;
    const q = easeInOutCubic(Math.min(1, Math.max(0, (t - startT) / dur)));
    fullness = fromFull + (toFull - fromFull) * q;
  }
  return { ...state, fullness };
}

function toState(kf, fullness) {
  return { x: kf.x, y: kf.y, size: kf.size, mode: kf.mode, fullness };
}

/**
 * Rektangelet kameraet skal tegnes i, gitt lerretets størrelse.
 * `radius` er hjørneradien: full sirkel som boble, 0 ved full skjerm.
 */
export function cameraRect(state, canvasW, canvasH, camAspect = 16 / 9) {
  const f = Math.min(1, Math.max(0, state.fullness ?? 0));

  const bubbleD = state.size * canvasH;
  const bubble = {
    w: bubbleD,
    h: bubbleD,
    cx: state.x * canvasW,
    cy: state.y * canvasH,
  };

  // Full skjerm: dekk hele lerretet (cover), sentrert.
  const full = { w: canvasW, h: canvasH, cx: canvasW / 2, cy: canvasH / 2 };

  const w = bubble.w + (full.w - bubble.w) * f;
  const h = bubble.h + (full.h - bubble.h) * f;
  const cx = bubble.cx + (full.cx - bubble.cx) * f;
  const cy = bubble.cy + (full.cy - bubble.cy) * f;

  return {
    x: cx - w / 2,
    y: cy - h / 2,
    w,
    h,
    radius: (Math.min(w, h) / 2) * (1 - f),
    fullness: f,
    aspect: camAspect,
  };
}
