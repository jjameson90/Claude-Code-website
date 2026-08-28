// Stillhetsdeteksjon bygger på FFmpeg-filteret `silencedetect`.
// Her tolker vi utdataene og gjør dem om til noe tidslinjen kan bruke.

import { normalizeRanges } from './timeline.mjs';

const START_RE = /silence_start:\s*(-?[\d.]+)/;
const END_RE = /silence_end:\s*(-?[\d.]+)/;

/**
 * Leser stderr fra `ffmpeg -af silencedetect` og returnerer stille intervaller.
 * Et siste `silence_start` uten tilhørende `silence_end` betyr at opptaket
 * sluttet i stillhet — da lukker vi intervallet på `duration`.
 */
export function parseSilenceDetect(text, duration = Infinity) {
  const ranges = [];
  let open = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.match(START_RE);
    if (s) { open = Math.max(0, parseFloat(s[1])); continue; }
    const e = line.match(END_RE);
    if (e && open !== null) { ranges.push({ start: open, end: parseFloat(e[1]) }); open = null; }
  }
  if (open !== null && Number.isFinite(duration)) ranges.push({ start: open, end: duration });
  return normalizeRanges(ranges, duration);
}

/** Første stille parti som starter etter `t`. */
export function nextSilence(ranges, t) {
  return ranges.find((r) => r.start > t + 0.01) || null;
}

/** Siste stille parti som starter før `t`. */
export function prevSilence(ranges, t) {
  let found = null;
  for (const r of ranges) { if (r.start < t - 0.01) found = r; else break; }
  return found;
}

/**
 * Gjør stille partier om til klipp. `padding` beholder litt luft i hver ende
 * slik at talen ikke kappes, og `minDuration` hopper over korte pauser.
 */
export function silenceToCuts(ranges, { padding = 0.15, minDuration = 0.8, duration = Infinity } = {}) {
  const cuts = [];
  for (const r of ranges) {
    if (r.end - r.start < minDuration) continue;
    const start = r.start + padding;
    const end = r.end - padding;
    if (end - start > 0.05) cuts.push({ start, end });
  }
  return normalizeRanges(cuts, duration);
}
