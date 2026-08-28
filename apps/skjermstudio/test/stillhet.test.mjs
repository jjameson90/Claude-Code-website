import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSilenceDetect, nextSilence, prevSilence, silenceToCuts } from '../src/shared/silence.mjs';

const UTDATA = `
[silencedetect @ 0x55] silence_start: 2.5
[silencedetect @ 0x55] silence_end: 5.1 | silence_duration: 2.6
[silencedetect @ 0x55] silence_start: 12.04
[silencedetect @ 0x55] silence_end: 13.2 | silence_duration: 1.16
`;

test('parseSilenceDetect leser start- og sluttpar', () => {
  assert.deepEqual(parseSilenceDetect(UTDATA), [
    { start: 2.5, end: 5.1 },
    { start: 12.04, end: 13.2 },
  ]);
});

test('stillhet som varer ut opptaket lukkes på varigheten', () => {
  const r = parseSilenceDetect('silence_start: 18.0', 20);
  assert.deepEqual(r, [{ start: 18, end: 20 }]);
});

test('tomt utdata gir ingen treff', () => {
  assert.deepEqual(parseSilenceDetect(''), []);
  assert.deepEqual(parseSilenceDetect(null), []);
});

test('nextSilence og prevSilence finner riktig parti', () => {
  const r = parseSilenceDetect(UTDATA);
  assert.deepEqual(nextSilence(r, 0), { start: 2.5, end: 5.1 });
  assert.deepEqual(nextSilence(r, 3), { start: 12.04, end: 13.2 });
  assert.equal(nextSilence(r, 20), null);
  // Står spillehodet inne i et stille parti, hopper vi først til starten av
  // det — og videre bakover ved neste trykk.
  assert.deepEqual(prevSilence(r, 13), { start: 12.04, end: 13.2 });
  assert.deepEqual(prevSilence(r, 12.04), { start: 2.5, end: 5.1 });
  assert.equal(prevSilence(r, 1), null);
});

test('silenceToCuts beholder luft i endene og hopper over korte pauser', () => {
  const cuts = silenceToCuts([{ start: 2, end: 6 }, { start: 8, end: 8.4 }], { padding: 0.2, minDuration: 0.8 });
  assert.deepEqual(cuts, [{ start: 2.2, end: 5.8 }]);
});
