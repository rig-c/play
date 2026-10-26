/** Summarize the emitted browser records; feature counts may overlap. */
import { readFileSync } from 'node:fs';
const path = process.argv[2];
if (!path) throw Error('LIVE_SUMMARY_INPUT: expected the live-frame-contracts.log path');
const records = readFileSync(path, 'utf8').split('\n').filter(line => line.startsWith('LIVE_FRAME_CASE ')).map(line => JSON.parse(line.slice('LIVE_FRAME_CASE '.length)));
if (!records.length) throw Error('LIVE_SUMMARY_EMPTY: no browser records found');
const features = new Map();
let rows = 0, runtime = 0, fallback = 0, numericDifferences = 0, pixelDifferences = 0, pixelSkips = 0;
for (const record of records) for (const row of record.rows) {
  rows++;
  numericDifferences += row.numeric.length;
  pixelDifferences += row.pixelDifferences;
  if (!row.contentPixels) pixelSkips++;
  if (row.poser === 'runtime') { runtime++; continue; }
  fallback++;
  const names = new Set([...row.poser.matchAll(/(?:missing: |; )([a-z][a-z0-9-]+):/g)].map(match => match[1]));
  if (!names.size) throw Error(`LIVE_SUMMARY_REASON: unclassified fallback ${row.poser}`);
  for (const name of names) {
    const value = features.get(name) ?? { feature: name, rows: 0, rigs: new Set() };
    value.rows++;
    value.rigs.add(record.rig);
    features.set(name, value);
  }
}
console.log(JSON.stringify({ rows, runtime, fallback, numericDifferences, pixelDifferences, pixelSkips,
  features: [...features.values()].sort((a, b) => b.rows - a.rows || a.feature.localeCompare(b.feature)).map(value => ({ ...value, rigs: [...value.rigs].sort() })),
  boundary: 'Counts overlap where a row reports multiple features. Model-wide refusals preempt per-animation checks; unreported features are not proven supported or absent.' }, null, 2));
