import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const VERSION = '1.27.0';
const CANONICAL = '@rig-c/play';
const CLI = fileURLToPath(new URL('./confirm-registry.mjs', import.meta.url));
const NPM_STUB = `#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const [command, spec, ...args] = process.argv.slice(2);
const { version, packages, fixtures, calls } = JSON.parse(process.env.NPM_STUB_CONFIG);
const name = spec.slice(0, spec.lastIndexOf('@'));
assert.equal(spec, name + '@' + version);
assert.ok(Object.hasOwn(packages, name), 'unexpected package ' + name);
assert.ok(args.includes('--prefer-online'));
assert.ok(args.includes('--fetch-retries=0'));
const log = path.join(calls, command + '-' + packages[name].id);
fs.appendFileSync(log, '.');
const attempt = fs.statSync(log).size;
const { viewMisses, wrongVersion, emptyPack, latePack, hungPack } = packages[name];

function notFound() {
  console.error('npm error code E404');
  process.exit(1);
}

if (command === 'view') {
  assert.equal(args[0], 'version');
  if (attempt <= viewMisses) notFound();
  console.log(wrongVersion && attempt === 1 ? '0.0.1' : version);
} else {
  assert.equal(command, 'pack');
  assert.ok(args.includes('--ignore-scripts'));
  assert.ok(args.includes('--pack-destination'));
  const destination = args[args.indexOf('--pack-destination') + 1];
  const tarball = path.join(destination, packages[name].id + '.tgz');
  assert.deepEqual(fs.readdirSync(destination), []);
  if (hungPack) {
    fs.writeFileSync(tarball, 'partial pack');
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  } else if (latePack && attempt === 1) {
    fs.writeFileSync(tarball, 'partial pack');
    notFound();
  } else if (emptyPack && attempt === 2) {
    fs.writeFileSync(tarball, '');
  } else {
    fs.copyFileSync(path.join(fixtures, packages[name].id + '.tgz'), tarball);
  }
}
`;

type PackageBehavior = {
  viewMisses?: number;
  wrongVersion?: boolean;
  emptyPack?: boolean;
  latePack?: boolean;
  hungPack?: boolean;
  different?: boolean;
  manifestName?: string;
  unreadable?: boolean;
};

function setup(t: TestContext, behaviors: Record<string, PackageBehavior>) {
  const root = mkdtempSync(join(tmpdir(), 'play-confirm-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const scratch = join(root, 'scratch');
  const calls = join(root, 'calls');
  for (const path of [bin, scratch, calls]) mkdirSync(path);
  writeFileSync(join(bin, 'npm'), NPM_STUB, { mode: 0o755 });

  const packages = Object.fromEntries(Object.entries(behaviors).map(([name, behavior], index) => {
    const id = `package-${index}`;
    const tarball = join(root, `${id}.tgz`);
    if (behavior.unreadable) {
      writeFileSync(tarball, 'not gzip');
    } else {
      const source = join(root, id);
      mkdirSync(join(source, 'package'), { recursive: true });
      writeFileSync(join(source, 'package', 'package.json'), JSON.stringify({ name: behavior.manifestName ?? name, version: VERSION }, null, 2) + '\n');
      writeFileSync(join(source, 'package', 'index.js'), `export const value = ${behavior.different ? 2 : 1};\n`);
      execFileSync('tar', ['-czf', tarball, '-C', source, 'package']);
    }
    return [name, { id, ...behavior }];
  }));

  return {
    run(args: string[] = [VERSION], extraEnv: Record<string, string> = {}) {
      const result = spawnSync(process.execPath, [CLI, ...args], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
        killSignal: 'SIGKILL',
        env: {
          ...process.env,
          PATH: [bin, process.env.PATH].join(delimiter),
          TMPDIR: scratch,
          TMP: scratch,
          TEMP: scratch,
          CONFIRM_WAIT_MS: '5000',
          CONFIRM_POLL_MS: '25',
          NPM_STUB_CONFIG: JSON.stringify({ version: VERSION, packages, fixtures: root, calls }),
          ...extraEnv,
        },
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.deepEqual(readdirSync(scratch), [], 'verifier left temporary files');
      return result;
    },
    count(command: 'view' | 'pack', name: string) {
      const log = join(calls, `${command}-${packages[name].id}`);
      return existsSync(log) ? readFileSync(log).length : 0;
    },
  };
}

test('default aliases compare after view misses, retaining their successful packs', t => {
  const fixture = setup(t, { [CANONICAL]: { viewMisses: 3 }, 'rig-play': {}, 'spine-html': {} });
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  for (const name of [CANONICAL, 'rig-play', 'spine-html']) {
    assert.ok(result.stdout.includes(`${name}@${VERSION} served (npm view version ${VERSION})`));
    assert.equal(fixture.count('pack', name), 1);
  }
  assert.equal(fixture.count('view', CANONICAL), 4);
  assert.equal((result.stdout.match(/PASS  ALIAS_SAME_CONTENT:/g) ?? []).length, 2);
});

test('alias subset retries a wrong view version, a failed partial pack and an empty pack', t => {
  const fixture = setup(t, {
    [CANONICAL]: {},
    'rig-play': {},
    'spine-html': { wrongVersion: true, latePack: true, emptyPack: true },
  });
  const result = fixture.run([VERSION, 'spine-html']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fixture.count('view', 'spine-html'), 2);
  assert.equal(fixture.count('pack', 'spine-html'), 3);
  assert.equal(fixture.count('pack', 'rig-play'), 0);
  assert.equal(fixture.count('view', 'rig-play'), 0);
  assert.match(result.stdout, /PASS  ALIAS_SAME_CONTENT: spine-html/);
});

test('one window covers an unserved view, a hung pack and a served name', t => {
  const fixture = setup(t, {
    [CANONICAL]: { viewMisses: Number.MAX_SAFE_INTEGER },
    'rig-play': { hungPack: true },
    'spine-html': {},
  });
  const result = fixture.run([VERSION], { CONFIRM_WAIT_MS: '1000' });
  assert.equal(result.status, 3, result.stderr);
  for (const name of [CANONICAL, 'rig-play']) {
    assert.ok(result.stderr.includes(`${name}@${VERSION} was not served within 1000 ms: confirmation NOT taken; re-run the confirm`));
  }
  assert.ok(fixture.count('view', CANONICAL) > 1);
  assert.equal(fixture.count('pack', CANONICAL), 1);
  assert.equal(fixture.count('pack', 'rig-play'), 1);
  assert.ok(result.stdout.includes(`spine-html@${VERSION} served`));
  assert.doesNotMatch(result.stdout, /ALIAS_SAME_CONTENT/);
});

test('comparator differences name the changed path and exit 1', t => {
  const fixture = setup(t, { [CANONICAL]: {}, 'rig-play': { different: true } });
  const result = fixture.run([VERSION, 'rig-play']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /FAIL  ALIAS_SAME_CONTENT: rig-play differs from @rig-c\/play beyond its name:/);
  assert.match(result.stdout, /package\/index\.js differs: \d+ byte\(s\) in @rig-c\/play's tarball and \d+ in rig-play's, first parting at byte \d+/);
});

test('a served alias tarball must declare the requested package name', t => {
  const fixture = setup(t, { [CANONICAL]: {}, 'rig-play': { manifestName: 'spine-html' } });
  const result = fixture.run([VERSION, 'rig-play']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /package\/package\.json in rig-play@1\.27\.0 declares "spine-html"/);
});

test('an unreadable archive is a comparison infrastructure error and exits 2', t => {
  const fixture = setup(t, { [CANONICAL]: {}, 'rig-play': { unreadable: true } });
  const result = fixture.run([VERSION, 'rig-play']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /tar -xzf/);
  assert.doesNotMatch(result.stdout, /FAIL  ALIAS_SAME_CONTENT/);
});

test('missing npm exits 2 with a spawn diagnostic', t => {
  const fixture = setup(t, {});
  const result = fixture.run([VERSION], { PATH: '' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /npm (view|pack) failed to run \(ENOENT\)/);
  assert.doesNotMatch(result.stderr, /not served/);
});

test('invalid arguments and timing overrides exit 2', t => {
  const fixture = setup(t, {});
  for (const args of [[], ['latest'], [VERSION, 'another-alias']]) {
    const result = fixture.run(args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
  }
  const result = fixture.run([VERSION], { CONFIRM_POLL_MS: '0' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /CONFIRM_POLL_MS must be a positive integer/);
});
