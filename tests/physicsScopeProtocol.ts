/** Protocol 02: a predeclared empirical cap for this fixture, not a solver error theorem. */
export const PHYSICS_SCOPE_PROTOCOL = Object.freeze({ revision: 2, frames: 120, dt: 1 / 60, depth: 30,
  toleranceRule: 'fixture-only empirical PEAK cap: abs(scopedPeak-nativePeak) <= F*ulp(nativePeak); F is actual rotational substeps to the earliest fresh native peak frame; coordinate maximum is an ungated diagnostic; no epsilon, gain or post-A/B change',
  legacyMultiple: 1000,
});

/** Exact binary64 exponent implements 2^(floor(log2(x))-52), avoiding log2 boundary rounding. */
export function nativePeakUlp(x: number): number {
  if (!Number.isFinite(x) || x < 2 ** -1022) throw new Error('native peak must be positive, normal and finite');
  const bits = new DataView(new ArrayBuffer(8)); bits.setFloat64(0, x);
  const exponent = ((bits.getUint32(0) >>> 20) & 0x7ff) - 1023;
  return 2 ** (exponent - 52);
}
export interface PhysicsScheduleState { remaining: number; lastTime: number; pending: boolean }
/** Exact replay of this fixture's rotational loop budget, checked against the actual resulting state. */
export function rotationalSubsteps(before: PhysicsScheduleState, after: PhysicsScheduleState, step: number) {
  if (![before.remaining, before.lastTime, after.remaining, after.lastTime, step].every(Number.isFinite)
    || step <= 0 || before.remaining < 0 || after.remaining < 0 || after.lastTime < before.lastTime)
    throw new Error('invalid fixture physics schedule');
  const delta = Math.max(after.lastTime - before.lastTime, 0);
  const budget = before.remaining + delta;
  let remaining = budget, substeps = 0;
  if (!before.pending) while (remaining >= step) {
    const next = remaining - step;
    if (next === remaining || ++substeps > PHYSICS_SCOPE_PROTOCOL.frames * 2) throw new Error('physics schedule outside fixture domain');
    remaining = next;
  }
  const remainderExact = Object.is(remaining, after.remaining);
  if (!remainderExact) throw new Error('reconstructed rotational remainder differs from actual state');
  return { step, delta, budget, substeps, reconstructedRemaining: remaining, remainderExact };
}
export function empiricalPeakCheck(nativePeak: number, scopedPeak: number, legacyPeak: number, coordinateMax: number, F: number) {
  if (!Number.isSafeInteger(F) || F <= 0) throw new Error('F must count positive actual rotational substeps');
  if (![scopedPeak, legacyPeak, coordinateMax].every((x) => Number.isFinite(x) && x >= 0)) throw new Error('invalid fixture peak/coordinate reading');
  const ulp = nativePeakUlp(nativePeak), cap = F * ulp;
  const peakResidual = Math.abs(scopedPeak - nativePeak), legacyExcess = legacyPeak - nativePeak;
  return { F, ulp, cap, peakResidual, residualUlps: peakResidual / ulp,
    amplitudePass: peakResidual <= cap, coordinateMax, coordinateResidualUlps: coordinateMax / ulp,
    legacyExcess, legacyRequiredExcess: PHYSICS_SCOPE_PROTOCOL.legacyMultiple * cap,
    legacyPass: legacyExcess >= PHYSICS_SCOPE_PROTOCOL.legacyMultiple * cap };
}
export function physicsScopeSample(frame: number): { yaw: number; x: number; narrow: number } {
  const yaw = frame < 12 || frame > 108 ? 0 : 12 * Math.sin(2 * Math.PI * (frame - 12) / 96)
    + (frame >= 60 && frame <= 72 ? 6 * Math.sin(Math.PI * (frame - 60) / 12) : 0);
  const radians = yaw * Math.PI / 180;
  return { yaw, x: -PHYSICS_SCOPE_PROTOCOL.depth * Math.sin(radians), narrow: Math.cos(radians) - 1 };
}
