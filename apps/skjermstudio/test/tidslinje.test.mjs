import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRanges, keptSegments, editedDuration, editedToSource, sourceToEdited,
  nextSourceTime, mapRangesToEdited,
} from '../src/shared/timeline.mjs';

test('normalizeRanges slår sammen overlapp og sorterer', () => {
  const r = normalizeRanges([{ start: 5, end: 8 }, { start: 1, end: 3 }, { start: 2.5, end: 6 }]);
  assert.deepEqual(r, [{ start: 1, end: 8 }]);
});

test('normalizeRanges snur vendte intervaller og fjerner tomme', () => {
  const r = normalizeRanges([{ start: 4, end: 2 }, { start: 7, end: 7 }]);
  assert.deepEqual(r, [{ start: 2, end: 4 }]);
});

test('normalizeRanges klemmer mot varigheten', () => {
  const r = normalizeRanges([{ start: 8, end: 20 }], 10);
  assert.deepEqual(r, [{ start: 8, end: 10 }]);
});

test('keptSegments fjerner klippene', () => {
  const seg = keptSegments(30, [{ start: 5, end: 10 }, { start: 20, end: 22 }]);
  assert.deepEqual(seg, [
    { start: 0, end: 5 },
    { start: 10, end: 20 },
    { start: 22, end: 30 },
  ]);
  assert.equal(editedDuration(seg), 23);
});

test('keptSegments takler klipp helt i starten og slutten', () => {
  const seg = keptSegments(10, [{ start: 0, end: 2 }, { start: 8, end: 10 }]);
  assert.deepEqual(seg, [{ start: 2, end: 8 }]);
});

test('keptSegments gir tom liste når alt er klippet bort', () => {
  assert.deepEqual(keptSegments(10, [{ start: 0, end: 10 }]), []);
});

test('editedToSource og sourceToEdited er hverandres motsatte', () => {
  const seg = keptSegments(30, [{ start: 5, end: 10 }]);
  assert.equal(editedToSource(3, seg), 3);
  assert.equal(editedToSource(6, seg), 11);   // etter klippet
  assert.equal(sourceToEdited(11, seg), 6);
  assert.equal(sourceToEdited(7, seg), null); // inne i klippet
  for (const t of [0, 1, 4.99, 10, 15, 24.5]) {
    const e = sourceToEdited(t, seg);
    if (e !== null) assert.ok(Math.abs(editedToSource(e, seg) - t) < 1e-6, `t=${t}`);
  }
});

test('nextSourceTime hopper forbi bortklippede partier', () => {
  const seg = keptSegments(30, [{ start: 5, end: 10 }]);
  assert.equal(nextSourceTime(3, seg), 3);
  assert.equal(nextSourceTime(7, seg), 10);
  assert.equal(nextSourceTime(31, seg), null);
});

test('mapRangesToEdited flytter markeringer inn i redigert tid', () => {
  const seg = keptSegments(30, [{ start: 5, end: 10 }]);
  const flyttet = mapRangesToEdited([{ start: 12, end: 14 }], seg);
  assert.deepEqual(flyttet, [{ start: 7, end: 9 }]);
});

test('markering som krysser et klipp deles i to', () => {
  const seg = keptSegments(30, [{ start: 5, end: 10 }]);
  const flyttet = mapRangesToEdited([{ start: 4, end: 11 }], seg);
  assert.deepEqual(flyttet, [{ start: 4, end: 6 }]);
});
