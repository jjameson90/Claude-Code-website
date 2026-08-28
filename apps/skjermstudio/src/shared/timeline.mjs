// Tidslinjemodell: kildetid  <->  redigert tid.
// Alle klipp er ikke-destruktive. Originalfilen røres aldri; vi lagrer kun
// hvilke intervaller som er fjernet, og regner om tidene ved behov.

const EPS = 1e-6;

/** Sorterer, klemmer og slår sammen overlappende intervaller. */
export function normalizeRanges(ranges, duration = Infinity) {
  const clean = (ranges || [])
    .map((r) => ({ start: Math.max(0, Math.min(r.start, r.end)), end: Math.min(duration, Math.max(r.start, r.end)) }))
    .filter((r) => r.end - r.start > EPS)
    .sort((a, b) => a.start - b.start);

  const merged = [];
  for (const r of clean) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + EPS) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

/** Segmentene som beholdes etter at `cuts` er fjernet fra [0, duration]. */
export function keptSegments(duration, cuts) {
  const removed = normalizeRanges(cuts, duration);
  const kept = [];
  let cursor = 0;
  for (const r of removed) {
    if (r.start - cursor > EPS) kept.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (duration - cursor > EPS) kept.push({ start: cursor, end: duration });
  return kept;
}

/** Samlet lengde på ferdig redigert video. */
export function editedDuration(segments) {
  return segments.reduce((sum, s) => sum + (s.end - s.start), 0);
}

/** Segmenter med akkumulert offset i redigert tidslinje. */
export function withOffsets(segments) {
  let acc = 0;
  return segments.map((s) => {
    const out = { ...s, outStart: acc, outEnd: acc + (s.end - s.start) };
    acc = out.outEnd;
    return out;
  });
}

/** Redigert tid -> kildetid. Returnerer null hvis utenfor. */
export function editedToSource(t, segments) {
  const segs = withOffsets(segments);
  if (!segs.length) return null;
  if (t <= 0) return segs[0].start;
  for (const s of segs) {
    if (t < s.outEnd - EPS) return s.start + (t - s.outStart);
  }
  const last = segs[segs.length - 1];
  return t <= last.outEnd + EPS ? last.end : null;
}

/** Kildetid -> redigert tid. Null hvis tiden ligger i et bortklippet parti. */
export function sourceToEdited(t, segments) {
  const segs = withOffsets(segments);
  for (const s of segs) {
    if (t >= s.start - EPS && t <= s.end + EPS) return s.outStart + (t - s.start);
  }
  return null;
}

/** Nærmeste gyldige kildetid framover (brukes når avspilling treffer et klipp). */
export function nextSourceTime(t, segments) {
  const segs = withOffsets(segments);
  for (const s of segs) {
    if (t < s.start) return s.start;
    if (t <= s.end) return t;
  }
  return null;
}

/** Oversetter markeringer (f.eks. stillhet) til redigert tidslinje. */
export function mapRangesToEdited(ranges, segments) {
  const out = [];
  for (const r of ranges) {
    for (const s of withOffsets(segments)) {
      const start = Math.max(r.start, s.start);
      const end = Math.min(r.end, s.end);
      if (end - start > EPS) {
        out.push({ start: s.outStart + (start - s.start), end: s.outStart + (end - s.start) });
      }
    }
  }
  return normalizeRanges(out);
}
