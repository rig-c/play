/** Apply the predeclared A/A envelope to two independent measurements per input. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const paths = process.argv.slice(2);
if (paths.length < 2) throw Error('BENCH_SUMMARY_INPUT: expected independent report JSON files');
const reports = paths.map(path => JSON.parse(readFileSync(path, 'utf8')));
if (new Set(reports.map(value => value.bundleSha256)).size !== 1) throw Error('BENCH_SUMMARY_BUNDLE: harness bundles differ');
for (const data of reports) {
  if (data.protocol !== 'play-runtime-default-same-frame-v1' || data.bundleSha256 !== data.productBundleSha256) throw Error('BENCH_SUMMARY_PRODUCT: expected unchanged default-product bundle');
}
const groups = new Map();
const checks = { frames: 0, halves: 0, softwareRendererRows: 0, drawCalls: new Set() };
for (const [report, data] of reports.entries()) for (const row of data.rows) {
  if (row.eventsIgnored !== 0 || row.eventAsymmetry !== null) throw Error('BENCH_SUMMARY_EVENTS: default-product comparison cannot waive events');
  const raw = JSON.parse(readFileSync(join(dirname(paths[report]), `${row.skeleton}-${row.instances}-${row.control}.json`), 'utf8'));
  if (raw.bundleSha256 !== data.bundleSha256 || raw.frames.length !== 180 || !raw.drawCallsPass || !raw.halves.every(half => half.pass)) throw Error('BENCH_SUMMARY_CONTROLS: raw same-frame controls did not pass');
  checks.frames += raw.frames.length; checks.halves += raw.halves.length;
  if (/SwiftShader/.test(raw.gpu.renderer)) checks.softwareRendererRows++;
  for (const frame of raw.frames) for (const arm of frame.arms) checks.drawCalls.add(arm.drawCalls);
  const key = `${row.skeleton}/${row.instances}`;
  const group = groups.get(key) ?? [];
  group.push({ ...row, report });
  groups.set(key, group);
}
const rows = [];
for (const [input, group] of groups) {
  const aa = group.filter(row => row.control === 'AA');
  const ab = group.filter(row => row.control === 'AB');
  if (aa.length !== 2 || ab.length !== 2 || new Set(ab.map(row => row.report)).size !== 2) throw Error(`BENCH_SUMMARY_RUNS: ${input} needs exactly two independent A/A and A/B rows`);
  for (const metric of ['pose', 'submit', 'cpu']) {
    const noiseEnvelopeMs = Math.max(...aa.flatMap(row => [Math.abs(row[metric].p05Ms), Math.abs(row[metric].p95Ms)]));
    const outsideNoise = ab.every(row => row[metric].p50Ms < 0 && -row[metric].p50Ms > noiseEnvelopeMs);
    rows.push({ input, metric, aa: aa.map(row => ({ report: row.report, ...row[metric] })), ab: ab.map(row => ({ report: row.report, ...row[metric], candidatePoser: row.candidatePoser, eventsIgnored: row.eventsIgnored })), noiseEnvelopeMs,
      verdict: outsideNoise ? 'default-product improvement outside A/A noise' : 'unresolved within A/A noise' });
  }
}
console.log(JSON.stringify({ protocol: 'runtime-bench-summary-v1', bundleSha256: reports[0].bundleSha256, productBundleSha256: reports[0].productBundleSha256, checks: { ...checks, drawCalls: [...checks.drawCalls].sort() }, rows,
  boundary: 'Default-product oracle vs automatic runtime; no event waiver or model injection; legacy adapter consumes snapshots. Candidate-minus-oracle milliseconds, no renderer or native-GPU speedup claim.' }, null, 2));
