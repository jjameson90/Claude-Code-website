import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleCamera, cameraRect, upsertKeyframe, removeKeyframeAt, easeInOutCubic } from '../src/shared/keyframes.mjs';

const BOBLE = (t, x, y, size) => ({ t, x, y, size, mode: 'bubble' });

test('sampleCamera holder verdien før første og etter siste nøkkelpunkt', () => {
  const kf = [BOBLE(2, 0.2, 0.3, 0.25), BOBLE(8, 0.8, 0.7, 0.4)];
  assert.equal(sampleCamera(kf, 0).x, 0.2);
  assert.equal(sampleCamera(kf, 99).x, 0.8);
});

test('sampleCamera glider mykt mellom nøkkelpunkter', () => {
  const kf = [BOBLE(0, 0, 0, 0.2), BOBLE(10, 1, 1, 0.4)];
  const midt = sampleCamera(kf, 5);
  assert.ok(Math.abs(midt.x - 0.5) < 1e-9);
  assert.ok(Math.abs(midt.size - 0.3) < 1e-9);
  // Mykningen skal gjøre starten roligere enn en rett linje.
  assert.ok(sampleCamera(kf, 1).x < 0.1);
});

test('overgang til full skjerm skjer i de siste sekundene før nøkkelpunktet', () => {
  const kf = [BOBLE(0, 0.8, 0.8, 0.3), { t: 10, x: 0.5, y: 0.5, size: 0.3, mode: 'full' }];
  assert.equal(sampleCamera(kf, 5, { transition: 0.6 }).fullness, 0);
  const under = sampleCamera(kf, 9.7, { transition: 0.6 }).fullness;
  assert.ok(under > 0 && under < 1, `forventet mellomverdi, fikk ${under}`);
  assert.equal(sampleCamera(kf, 10, { transition: 0.6 }).fullness, 1);
});

test('cameraRect gir rund boble når fullness er 0', () => {
  const r = cameraRect({ x: 0.5, y: 0.5, size: 0.3, fullness: 0 }, 1920, 1080);
  assert.equal(r.w, 324);
  assert.equal(r.h, 324);
  assert.equal(r.radius, 162);   // halv bredde = perfekt sirkel
  assert.equal(r.x, 1920 / 2 - 162);
});

test('cameraRect fyller hele bildet når fullness er 1', () => {
  const r = cameraRect({ x: 0.85, y: 0.8, size: 0.3, fullness: 1 }, 1920, 1080);
  assert.deepEqual([r.x, r.y, r.w, r.h, r.radius], [0, 0, 1920, 1080, 0]);
});

test('upsertKeyframe erstatter i stedet for å duplisere', () => {
  let kf = [BOBLE(1, 0.1, 0.1, 0.2)];
  kf = upsertKeyframe(kf, BOBLE(1.01, 0.9, 0.9, 0.5));
  assert.equal(kf.length, 1);
  assert.equal(kf[0].x, 0.9);

  kf = upsertKeyframe(kf, BOBLE(5, 0.3, 0.3, 0.3));
  assert.equal(kf.length, 2);
  assert.deepEqual(kf.map((k) => k.t), [1.01, 5]);
});

test('removeKeyframeAt fjerner bare det nærmeste punktet', () => {
  const kf = [BOBLE(1, 0, 0, 0.2), BOBLE(5, 0, 0, 0.2)];
  assert.equal(removeKeyframeAt(kf, 5).length, 1);
  assert.equal(removeKeyframeAt(kf, 3).length, 2);
});

test('easeInOutCubic er forankret i endepunktene', () => {
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  assert.ok(Math.abs(easeInOutCubic(0.5) - 0.5) < 1e-9);
});
