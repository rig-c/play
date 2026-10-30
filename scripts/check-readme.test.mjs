import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkReadme, WORD_CAP } from './check-readme.mjs';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

test('README passes the fixed scope check', () => {
  assert.deepEqual(checkReadme(readme).errors, []);
});

for (const [name, plant, diagnostic] of [
  ['words over cap', 'word '.repeat(WORD_CAP + 1), /^words:/u],
  ['unlisted level-two heading', `${readme}\n## Flag catalogue\n`, /^heading:/u],
  ['indented level-two heading', `${readme}\n  ## Flag catalogue\n`, /^heading:/u],
  ['empty level-two heading', `${readme}\n##\n`, /^heading:/u],
  ['measured on 20', `${readme}\nMeasured on 2026-10-30.\n`, /^dated measurement:/u],
  ['read on 20', `${readme}\nStats read on 2026-10-30.\n`, /^dated measurement:/u],
  ['wrapped dated measurement', `${readme}\nMeasured\non 2026-10-30.\n`, /^dated measurement:/u],
  ['date inside table cell', `${readme}\n| date | result |\n| --- | --- |\n| 2026-10-30 | 60 fps |\n`, /^dated table cell:/u],
]) {
  test(`planted failure refused: ${name}`, () => {
    assert.ok(checkReadme(plant).errors.some(error => diagnostic.test(error)), `missing ${diagnostic}`);
  });
}

test('word cap accepts its boundary and refuses the next word', () => {
  assert.deepEqual(checkReadme('word '.repeat(WORD_CAP)).errors, []);
  assert.match(checkReadme('word '.repeat(WORD_CAP + 1)).errors[0], /^words:/u);
});

test('code examples are not headings or dated measurement prose', () => {
  for (const fence of ['```', '~~~~']) {
    assert.deepEqual(checkReadme(`${fence}\n## Example heading\nMeasured on 2026-10-30\n| 2026-10-30 |\n${fence}\n`).errors, []);
  }
});

test('Measured anchor and at most six summary rows survive', () => {
  const section = /\n### Measured\n([\s\S]*?)\n## /u.exec(readme)?.[1];
  assert.ok(section, 'README #measured anchor missing');
  const rows = section.split('\n').filter(line => line.startsWith('|'));
  assert.ok(rows.length <= 8, `summary has ${rows.length - 2} data rows`);
  assert.match(section, /https:\/\/github\.com\/rig-c\/play\/blob\/main\/docs\/BENCHMARK\.md#measured/u);
});

test('How it works stays one paragraph and License points to shipped NOTICE', () => {
  const how = /\n## How it works\n\n([\s\S]*?)\n## /u.exec(readme)?.[1].trim();
  assert.ok(how);
  assert.equal(how.split(/\n\s*\n/u).length, 1);
  assert.equal(readme.split('## License\n\n')[1]?.trim(), 'See [NOTICE.md](NOTICE.md) for licensing and third-party notices.');
});
