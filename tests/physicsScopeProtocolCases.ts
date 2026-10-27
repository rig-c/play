import { empiricalPeakCheck, nativePeakUlp, rotationalSubsteps } from './physicsScopeProtocol';

export function physicsScopeProtocolCases() {
  let checks = 0; const problems: string[] = [];
  const check = (ok: boolean, label: string) => { checks++; if (!ok) problems.push(label); };
  const refuses = (f: () => unknown, label: string) => { let threw = false; try { f(); } catch { threw = true; } check(threw, label); };
  check(nativePeakUlp(1) === 2 ** -52, 'ULP at1');
  check(nativePeakUlp(2) === 2 ** -51, 'ULP at2');
  check(nativePeakUlp(2 - 2 ** -52) === 2 ** -52, 'ULP immediately below2 must not round log2 up');
  check(nativePeakUlp(1024 - 2 ** -43) === 2 ** -43, 'ULP below1024 must use the exponent bits when log2 rounds up');
  check(nativePeakUlp(2 ** -1022) === Number.MIN_VALUE, 'smallest normal peak ULP');
  for (const x of [0, -1, Number.MIN_VALUE, NaN, Infinity]) refuses(() => nativePeakUlp(x), 'invalid peak refused ' + String(x));
  const state = (remaining: number, lastTime: number, pending = false) => ({ remaining, lastTime, pending });
  check(rotationalSubsteps(state(0, 0), state(0, 1 / 30), 1 / 60).substeps === 2, 'one render update may contain two physical substeps');
  check(rotationalSubsteps(state(0.09375, 0), state(0.03125, 0.0625), 0.125).substeps === 1, 'carried remainder contributes to the loop budget');
  check(rotationalSubsteps(state(0, 0, true), state(0.1875, 0.1875), 0.125).substeps === 0, 'pending pass keeps budget and integrates zero');
  check(rotationalSubsteps(state(0.1875, 0.1875), state(0.0625, 0.3125), 0.125).substeps === 2, 'pending budget is carried into the next active update');
  check(rotationalSubsteps(state(0.25, 1), state(0, 1), 0.125).substeps === 2, 'zero delta can consume an existing budget');
  refuses(() => rotationalSubsteps(state(0, 0), state(0.01, 1 / 60), 1 / 60), 'wrong actual remainder is refused exactly');
  refuses(() => rotationalSubsteps(state(0, 1), state(0, 0), 1 / 60), 'reset/backward clock outside counting fixture refused');
  refuses(() => rotationalSubsteps(state(0, 0), state(0, 1), 0), 'zero fixed step refused');
  const u = 2 ** -49;
  const clean = empiricalPeakCheck(8, 8 + 2 * u, 8 + 3000 * u, 10000 * u, 3);
  check(clean.ulp === u && clean.cap === 3 * u, 'cap from native peak and physical count only');
  check(clean.peakResidual === 2 * u && clean.residualUlps === 2 && clean.amplitudePass, 'known2ULP peak difference passes3-step cap');
  check(clean.coordinateResidualUlps === 10000 && clean.amplitudePass, 'coordinate diagnostic does not become the peak gate');
  check(clean.legacyExcess === 3000 * u && clean.legacyPass, 'legacy excess at exactly1000caps passes');
  check(empiricalPeakCheck(8, 8 + 3 * u, 8 + 3000 * u, 0, 3).amplitudePass, 'peak cap equality passes');
  check(!empiricalPeakCheck(8, 8 + 4 * u, 8 + 3000 * u, 0, 3).amplitudePass, 'peak cap exceeded by1ULP fails; no epsilon');
  check(!empiricalPeakCheck(8, 8, 8 + 2999 * u, 0, 3).legacyPass, 'legacy below1000caps fails');
  check(!empiricalPeakCheck(8, 8, 1, 0, 3).legacyPass, 'negative legacy excess gets no absolute-value rescue');
  refuses(() => empiricalPeakCheck(8, 8, 9, 0, 0), 'no invented positive F floor');
  refuses(() => empiricalPeakCheck(8, 8, 9, 0, 1.5), 'fractional integration count refused');
  return { checks, problems };
}
