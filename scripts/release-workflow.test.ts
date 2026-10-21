// Standalone: bun test scripts/release-workflow.test.ts. No build, credentials or network.
// Execute the actual YAML shell bodies, replacing every external CLI with a recorder.
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ALIASES } from '../scripts/alias-tarball.mjs';

type Step = { name?: string; id?: string; uses?: string; if?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> };
const root = resolve(import.meta.dir, '..');
const source = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
const workflow = Bun.YAML.parse(source) as any;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tagSha = '1111111111111111111111111111111111111111';
const otherSha = '2222222222222222222222222222222222222222';
const sourceGuard = (s: Step) => s.name === 'Verify the dispatched source commit';
const resolver = workflow.jobs.release.steps.find((s: Step) => s.id === 'target') as Step;
const originalSteps = workflow.jobs.release.steps.filter((s: Step) => !sourceGuard(s) && s.id !== 'release' && s.id !== 'target' && s.name !== 'Verify the retry tag matches the package' && s.name !== 'Verify the retry tag is on main');

// The mock never delegates npm/gh/bun/git to the host. Only node's local JSON checks
// reach a real interpreter; alias pack/compare are recorded stand-ins here.
const mock = String.raw`
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
const config = JSON.parse(readFileSync(process.env.MOCK_CONFIG, 'utf8'));
const state = JSON.parse(readFileSync(process.env.MOCK_STATE, 'utf8'));
const record = (command, args) => appendFileSync(process.env.MOCK_LOG, JSON.stringify({command, args}) + '\n');
const save = () => writeFileSync(process.env.MOCK_STATE, JSON.stringify(state));
const fail = message => { console.error(message); process.exit(71); };
record(command, args);
if (command === 'gh') {
  if (args[0] !== 'api' || args[1] !== '--include' || args[2] !== 'repos/rig-c/play/releases/tags/v1.12.0') fail('unexpected gh request');
  const status = config.ghStatus ?? 200;
  if (status === 0) { console.error('mock connection failure'); process.exit(1); }
  console.log('HTTP/2.0 ' + status + '\r\nx-mock: true\r\n\r\n' + JSON.stringify({tag_name:'v1.12.0', draft:config.draft ?? false, published_at:config.unpublished ? null : '2026-10-21T00:00:00Z'}));
  process.exit(status === 200 ? 0 : 1);
}
if (command === 'git') {
  if (args.join(' ') === 'rev-parse --verify HEAD^{commit}') {
    if (!state.checkedOutRef) fail('HEAD query before checkout');
    if (config.headQueryFails) process.exit(128);
    console.log(state.checkoutSha); process.exit(0);
  }
  if (args.join(' ') === 'rev-parse --is-shallow-repository') {
    if (config.gitQueryFails) process.exit(128);
    console.log(config.shallow ?? 'true'); process.exit(0);
  }
  if (args[0] === 'fetch') {
    const expected = ['fetch','--no-tags', ...(config.shallow === 'false' ? [] : ['--unshallow']), 'origin','refs/heads/main:refs/remotes/origin/main'];
    if (JSON.stringify(args) !== JSON.stringify(expected)) fail('unexpected fetch or incomplete main history');
    state.mainFetched = !config.gitFetchFails; save();
    process.exit(config.gitFetchFails ? 128 : 0);
  }
  if (args.join(' ') === 'merge-base --is-ancestor HEAD origin/main') {
    if (!state.mainFetched) fail('ancestry before full main fetch');
    process.exit(config.ancestryStatus ?? 0);
  }
  fail('unexpected git query');
}
if (command === 'npm') {
  if (args[0] === 'view') {
    const [name, version] = args[1].split(/@(?=[^@]*$)/);
    if (args.includes('--json')) {
      if (config.registryMalformed) { console.log('broken JSON'); process.exit(1); }
      if (config.registryError) { console.log(JSON.stringify({error:{code:config.registryError}})); process.exit(1); }
      if (state.served.includes(name)) { console.log(JSON.stringify(version)); process.exit(0); }
      console.log(JSON.stringify({error:{code:'E404'}})); process.exit(1);
    }
    if (!state.served.includes(name)) fail('version not served');
    console.log(version); process.exit(0);
  }
  if (args[0] === 'install' || args[0] === '--version') process.exit(0);
  if (args[0] === 'publish') {
    if (!args.includes('--provenance') || !args.includes('--access') || !args.includes('public')) fail('publish lost provenance/access');
    let name;
    if (args[1] === '--provenance') {
      const p = JSON.parse(readFileSync('package.json', 'utf8'));
      record('prepublishOnly', [p.scripts.prepublishOnly]);
      if (config.buildFails) process.exit(1);
      name = p.name;
    } else {
      if (!args.includes('--ignore-scripts')) fail('alias lifecycle scripts enabled');
      name = JSON.parse(readFileSync(args[1], 'utf8')).name;
    }
    if (state.served.includes(name)) fail('attempted duplicate publish');
    state.served.push(name); save(); record('published', [name]); process.exit(0);
  }
  if (args[0] === 'pack') {
    const [name, version] = args[1].split(/@(?=[^@]*$)/);
    if (!state.served.includes(name)) fail('pack of unpublished name');
    const dest = args[args.indexOf('--pack-destination') + 1];
    mkdirSync(dest, {recursive:true});
    const file = name.replace(/^@/, '').replace('/', '-') + '-' + version + '.tgz';
    writeFileSync(join(dest, file), JSON.stringify({name, version})); console.log(file); process.exit(0);
  }
}
if (command === 'node') {
  if (args[0] === '-' || args[0] === '-e') {
    const result = spawnSync(process.env.MOCK_REAL_NODE, args, {stdio:'inherit', env:process.env});
    process.exit(result.status ?? 1);
  }
  if (args[0] === 'scripts/alias-tarball.mjs') {
    if (args[1] === 'pack') {
      const name = args[args.indexOf('--alias') + 1];
      if (!['rig-play', 'spine-html'].includes(name)) fail('unknown alias');
      const dest = args[args.indexOf('--out') + 1];
      mkdirSync(dest, {recursive:true});
      const file = join(dest, name + '.tgz');
      writeFileSync(file, JSON.stringify({name, version:'1.12.0'})); console.log(file); process.exit(0);
    }
    if (args[1] === 'compare') {
      const a = JSON.parse(readFileSync(args[2], 'utf8'));
      const b = JSON.parse(readFileSync(args[3], 'utf8'));
      if (a.name !== '@rig-c/play' || !['rig-play','spine-html'].includes(b.name) || a.version !== b.version) fail('wrong confirmation inputs');
      record('compared', [a.name,b.name,a.version]); process.exit(0);
    }
  }
}
if (command === 'bun' && args.join(' ') === 'install --frozen-lockfile') process.exit(0);
fail('unmocked command: ' + command + ' ' + args.join(' '));
`;

type Scenario = {
  event?: string; created?: string; cutTag?: string; tag?: string; aliasVersion?: string;
  aliasNames?: string; ref?: string; served?: string[]; ghStatus?: number; draft?: boolean;
  unpublished?: boolean; registryError?: string; registryMalformed?: boolean; packageVersion?: string;
  packageName?: string; buildFails?: boolean; shallow?: string; gitQueryFails?: boolean;
  gitFetchFails?: boolean; ancestryStatus?: number; runSha?: string; headSha?: string; headQueryFails?: boolean;
};
function exercise(config: Scenario = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'play-release-mock-'));
  try {
    const bin = join(dir, 'bin'); mkdirSync(bin);
    const home = join(dir, 'home'); mkdirSync(home);
    for (const cli of ['npm','gh','node','bun','git'])
      writeFileSync(join(bin, cli), '#!' + process.execPath + '\n' + mock, {mode:0o755});
    const log = join(dir, 'calls.jsonl'); writeFileSync(log, '');
    const state = join(dir, 'state.json'); writeFileSync(state, JSON.stringify({served:config.served ?? []}));
    const cfg = join(dir, 'config.json'); writeFileSync(cfg, JSON.stringify(config));
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    manifest.version = config.packageVersion ?? '1.12.0';
    manifest.name = config.packageName ?? '@rig-c/play';
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
    const outputs: Record<string,string> = {};
    const values: Record<string,string> = {
      'github.event_name': config.event ?? 'workflow_dispatch',
      'github.ref': config.ref ?? 'refs/tags/v1.12.0', 'github.sha':config.runSha ?? tagSha,
      'github.repository':'rig-c/play', 'github.token':'mock-token',
      'inputs.tag':config.tag ?? 'v1.12.0', 'inputs.alias_version':config.aliasVersion ?? '',
      'inputs.alias_names':config.aliasNames ?? 'rig-play spine-html',
      'steps.release.outputs.release_created':config.created ?? '', 'steps.release.outputs.tag_name':config.cutTag ?? 'v1.12.0',
    };
    const expand = (text: string) => text.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, key) => {
      if (!(key in values)) throw Error('unhandled expression: ' + key);
      return values[key];
    });
    const condition = (expression?: string) => {
      if (!expression) return true;
      const match = /^\$\{\{ (.*?) == '(.*?)' \}\}$/.exec(expression);
      if (!match) throw Error('unhandled condition: ' + expression);
      return values[match[1]] === match[2];
    };
    const actions: {uses: string; ref?:string}[] = [];
    const ran: string[] = [];
    let status = 0, output = '';
    const execute = (step: Step, jobEnv: Record<string,string> = {}) => {
      if (!condition(step.if)) return;
      if (step.uses) {
        actions.push({uses:step.uses, ...(step.with?.ref ? {ref:expand(step.with.ref)} : {})});
        if (step.uses === 'actions/checkout@v4') {
          const current = JSON.parse(readFileSync(state, 'utf8'));
          current.checkedOutRef = expand(step.with!.ref);
          current.checkoutSha = config.headSha ?? tagSha;
          writeFileSync(state, JSON.stringify(current));
        }
        return;
      }
      if (!step.run) throw Error('missing run');
      ran.push(step.name ?? step.id ?? 'run');
      const outFile = join(dir, 'outputs'); writeFileSync(outFile, '');
      const env: Record<string,string> = {
        PATH:bin + ':/usr/bin:/bin', HOME:home, RUNNER_TEMP:dir, GITHUB_OUTPUT:outFile,
        MOCK_CONFIG:cfg, MOCK_STATE:state, MOCK_LOG:log, MOCK_REAL_NODE:Bun.which('node')!,
      };
      for (const [key,value] of Object.entries({...jobEnv,...step.env})) env[key] = expand(value);
      const result = spawnSync('/bin/bash', ['-e','-o','pipefail','-c',step.run], {cwd:dir, env, encoding:'utf8', timeout:10000});
      if (result.error) throw result.error;
      status = result.status ?? 1; output += result.stdout + result.stderr;
      if (status === 0 && step.id) {
        for (const line of readFileSync(outFile, 'utf8').trim().split('\n').filter(Boolean)) {
          const index = line.indexOf('='); const key = line.slice(0,index), value = line.slice(index+1);
          outputs[key] = value; values[`steps.${step.id}.outputs.${key}`] = value;
        }
      }
    };
    for (const step of workflow.jobs.release.steps as Step[]) { execute(step); if (status) break; }
    values['needs.release.outputs.mode'] = outputs.mode ?? '';
    const aliasRan = status === 0 && condition(workflow.jobs.alias.if);
    if (aliasRan) for (const step of workflow.jobs.alias.steps as Step[]) { execute(step, workflow.jobs.alias.env); if (status) break; }
    return {status, output, outputs, actions, ran, aliasRan, calls:readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))};
  } finally { rmSync(dir, {recursive:true, force:true}); }
}
const published = (r: ReturnType<typeof exercise>) => r.calls.filter(c => c.command === 'published').map(c => c.args[0]);
function noInstallOrPublish(r: ReturnType<typeof exercise>) {
  expect(r.calls.filter(c => c.command === 'npm' && ['install','publish'].includes(c.args[0]) || c.command === 'bun' || c.command === 'prepublishOnly')).toEqual([]);
}
function refused(config: Scenario, code: string) {
  const r = exercise(config);
  expect(r.status).not.toBe(0); expect(r.output).toContain(code);
  expect(published(r)).toEqual([]); expect(r.aliasRan).toBe(false);
  noInstallOrPublish(r);
  return r;
}

describe('release workflow contract', () => {
  test('preserves original publication bodies/order and alias job steps', () => {
    const clean = (s: Step) => {
      const c = structuredClone(s); delete c.if;
      if (c.uses === 'actions/checkout@v4') delete c.with!.ref;
      if (c.env) delete c.env.TAG_NAME;
      return c;
    };
    // SHA-256 of parsed original steps, excluding only routing condition/ref.
    expect(digest(originalSteps.map(clean))).toBe('1268705f8a94844af4d72dd083c007cbe194148864ddd5c2c9c57e9b1e7aa361');
    expect(digest(workflow.jobs.alias.steps.filter((s: Step) => !sourceGuard(s)))).toBe('2aaeef5812c8c0beac4025a53434c90891b605209832b26ec00b54b1452b944f');
    // Preserve the existing steps in full, including push refs/conditions and
    // the canonical HEAD-to-main ancestry guard added before this change.
    expect(digest(workflow.jobs.release.steps.filter((s: Step) => s.id !== 'target' && !sourceGuard(s)))).toBe('901f721eca42554866b7dc1035b5db1d4de7d8558634495b72d7352b5aa2f16f');
    expect(digest(resolver.run!.split('if [ -n "$INPUT_TAG" ]')[0])).toBe('eac7560cf5ce8b3d604f5d35d605121396870d1bec5cc9c81db0dc7033e656eb');
    expect(ALIASES).toEqual(['rig-play','spine-html']);
    expect(workflow.concurrency).toEqual({group:'release-${{ github.ref }}', 'cancel-in-progress':false});
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs.release.permissions).toEqual({contents:'write','pull-requests':'write',issues:'write','id-token':'write'});
    expect(workflow.jobs.alias.permissions).toEqual({contents:'read','id-token':'write'});
    expect(workflow.jobs.release['runs-on']).toBe('ubuntu-latest');
    expect(workflow.jobs.alias.needs).toBe('release');
    expect(workflow.on.workflow_dispatch.inputs.tag.required).toBe(false);
    expect(workflow.on.workflow_dispatch.inputs.alias_version.required).toBe(false);
    const canonicalGuard = workflow.jobs.release.steps.find(sourceGuard) as Step;
    const aliasGuard = workflow.jobs.alias.steps.find(sourceGuard) as Step;
    expect(canonicalGuard.env).toEqual({RUN_SHA:'${{ github.sha }}', TAG_NAME:'${{ steps.target.outputs.tag }}'});
    expect(aliasGuard.env).toEqual({RUN_SHA:'${{ github.sha }}', TAG_NAME:'v${{ inputs.alias_version }}'});
    expect(aliasGuard.run).toBe(canonicalGuard.run);
    for (const job of Object.values(workflow.jobs) as any[]) {
      for (const env of [job.env ?? {}, ...job.steps.map((s: Step) => s.env ?? {})]) {
        expect(Object.keys(env).filter(k=>k.startsWith('GITHUB_'))).toEqual([]);
      }
      for (const step of job.steps as Step[]) if (step.run) {
        expect(step.run).not.toContain('${{');
        expect(step.run).not.toMatch(/(?:export\s+)?GITHUB_(?:SHA|REF)=/);
      }
    }
    expect(resolver.env!.INPUT_TAG).toBe('${{ inputs.tag }}');
  });
  test('same-SHA tag-ref retry uses exact tag, original build hook and all three publishes/confirmations (mock only)', () => {
    const r = exercise(); expect(r.status).toBe(0); expect(r.aliasRan).toBe(false);
    expect(published(r)).toEqual(['@rig-c/play',...ALIASES]);
    expect(r.actions.find(a=>a.uses === 'actions/checkout@v4')?.ref).toBe('refs/tags/v1.12.0');
    expect(r.actions.some(a=>a.uses === 'googleapis/release-please-action@v4')).toBe(false);
    expect(r.calls.filter(c=>c.command === 'compared').map(c=>c.args)).toEqual(ALIASES.map(a=>['@rig-c/play',a,'1.12.0']));
    expect(r.calls.find(c=>c.command === 'prepublishOnly')?.args).toEqual(['npm run build:lib']);
  });
  test.each(['v1.12.0;touch injected','v1.12.0\npublish=true','1.12.0','v1.12.0-beta.1','v01.12.0'])('rejects malformed tag %j before external requests', tag => {
    const r = refused({tag}, 'RELEASE_TAG_FORM'); expect(r.calls).toEqual([]);
  });
  test('rejects no release', () => { refused({ghStatus:404}, 'RELEASE_TAG_UNRELEASED'); });
  test('rejects a draft release', () => { refused({draft:true}, 'RELEASE_TAG_UNRELEASED'); });
  test('rejects a release without published_at', () => { refused({unpublished:true}, 'RELEASE_TAG_UNRELEASED'); });
  test.each([0,403,500])('GitHub lookup %i fails distinctly from unpublished', ghStatus => {
    const r = refused({ghStatus}, 'RELEASE_TAG_LOOKUP'); expect(r.output).not.toContain('RELEASE_TAG_UNRELEASED');
  });
  test('canonical already served refuses and never hijacks alias repair', () => {
    refused({served:['@rig-c/play']}, 'RELEASE_ALREADY_PUBLISHED');
  });
  test.each(['E403','E401','E500','ETIMEDOUT','ENOTFOUND'])('registry %s fails closed', registryError => {
    refused({registryError}, 'RELEASE_REGISTRY_LOOKUP');
  });
  test('malformed registry failure fails closed', () => { refused({registryMalformed:true}, 'RELEASE_REGISTRY_LOOKUP'); });
  test.each([{tag:'',aliasVersion:''},{tag:'v1.12.0',aliasVersion:'1.12.0'},{tag:'',aliasVersion:'1.12.0;bad'}])('rejects ambiguous/empty/invalid mode %j', scenario => { refused(scenario, 'RELEASE_MODE'); });
  test.each(['refs/heads/main','refs/heads/other'])('branch-ref dispatch %s with a different run SHA refuses', ref => {
    const r = refused({ref,runSha:otherSha}, 'PROVENANCE_SHA_MISMATCH');
    expect(r.output).toContain(otherSha); expect(r.output).toContain(tagSha);
  });
  const dispatchModes: {mode: string; config: Scenario}[] = [
    {mode:'canonical',config:{}},
    {mode:'alias',config:{tag:'',aliasVersion:'1.12.0',served:['@rig-c/play']}},
  ];
  for (const {mode,config} of dispatchModes) {
    test.each([
      {runSha:otherSha}, {runSha:''}, {headQueryFails:true}, {headSha:''},
    ])(`${mode} source guard fails closed before install/publish for %j`, failure => {
      const r = exercise({...config,...failure});
      expect(r.status).not.toBe(0); expect(published(r)).toEqual([]);
      noInstallOrPublish(r);
      expect(r.output).toContain('headQueryFails' in failure || 'headSha' in failure ? 'PROVENANCE_SHA_LOOKUP' : 'PROVENANCE_SHA_MISMATCH');
      if ('runSha' in failure) {
        expect(r.output).toContain(failure.runSha || '<missing>');
        expect(r.output).toContain(tagSha);
        expect(r.output).toContain('--ref v1.12.0');
      }
      expect(r.calls.filter(c=>c.command === 'git').at(-1)?.args).toEqual(['rev-parse','--verify','HEAD^{commit}']);
      expect(r.calls.some(c=>c.command === 'npm' && c.args[0] === 'pack')).toBe(false);
      expect(r.actions.some(a=>a.uses === 'actions/setup-node@v4' || a.uses === 'oven-sh/setup-bun@v2')).toBe(false);
      if (mode === 'canonical') {
        expect(r.ran.indexOf('Verify the retry tag is on main')).toBeLessThan(r.ran.indexOf('Verify the dispatched source commit'));
        expect(r.ran).not.toContain('Verify the retry tag matches the package');
      }
    });
  }
  test.each(['true','false'])('tag ancestry fetch handles shallow=%s before checking exact HEAD/main ancestry', shallow => {
    const r = exercise({shallow}); expect(r.status).toBe(0);
    expect(r.calls.filter(c=>c.command === 'git').map(c=>c.args)).toEqual([
      ['rev-parse','--is-shallow-repository'],
      ['fetch','--no-tags', ...(shallow === 'true' ? ['--unshallow'] : []), 'origin','refs/heads/main:refs/remotes/origin/main'],
      ['merge-base','--is-ancestor','HEAD','origin/main'],
      ['rev-parse','--verify','HEAD^{commit}'],
    ]);
    expect(r.ran.indexOf('Verify the retry tag is on main')).toBeLessThan(r.ran.indexOf('Verify the dispatched source commit'));
    expect(r.ran.indexOf('Verify the dispatched source commit')).toBeLessThan(r.ran.indexOf('Verify the retry tag matches the package'));
  });
  test.each([
    {scenario:{ancestryStatus:1},code:'RELEASE_TAG_NOT_ON_MAIN',calls:3},
    {scenario:{ancestryStatus:128},code:'RELEASE_TAG_ANCESTRY_LOOKUP',calls:3},
    {scenario:{gitQueryFails:true},code:'RELEASE_TAG_ANCESTRY_LOOKUP',calls:1},
    {scenario:{shallow:'unknown'},code:'RELEASE_TAG_ANCESTRY_LOOKUP',calls:1},
    {scenario:{gitFetchFails:true},code:'RELEASE_TAG_MAIN_FETCH',calls:2},
  ])('tag ancestry fails closed for %j', ({scenario,code,calls}) => {
    const r = refused(scenario, code);
    expect(r.calls.filter(c=>c.command === 'git')).toHaveLength(calls);
    expect(r.calls.some(c=>c.command === 'npm' && ['install','publish'].includes(c.args[0]) || c.command === 'bun')).toBe(false);
    expect(r.ran).not.toContain('Verify the retry tag matches the package');
    if (code !== 'RELEASE_TAG_NOT_ON_MAIN') expect(r.output).not.toContain('RELEASE_TAG_NOT_ON_MAIN');
  });
  test.each([{packageVersion:'1.11.0'},{packageName:'rig-play'}])('checks tagged manifest before installs/publish %j', scenario => {
    const r = refused(scenario, 'RELEASE_TAG_VERSION'); expect(r.calls.some(c=>c.command === 'npm' && c.args[0] === 'install')).toBe(false);
  });
  test('canonical build-hook failure prevents aliases and confirmation', () => {
    const r = exercise({buildFails:true}); expect(r.status).not.toBe(0); expect(published(r)).toEqual([]);
    expect(r.calls.some(c=>c.command === 'compared')).toBe(false);
    expect(r.calls.filter(c=>c.command === 'prepublishOnly')).toHaveLength(1);
  });
  test('push with a new release has unchanged steps and no dispatch preflight', () => {
    const r = exercise({event:'push',created:'true',ref:'refs/heads/main',runSha:otherSha,tag:'bad-input',aliasVersion:'ignored'});
    expect(r.status).toBe(0); expect(published(r)).toEqual(['@rig-c/play',...ALIASES]);
    expect(r.actions.find(a=>a.uses === 'actions/checkout@v4')?.ref).toBe('v1.12.0');
    expect(r.actions[0].uses).toBe('googleapis/release-please-action@v4');
    expect(r.calls.some(c=>c.command === 'gh' || c.args.includes('--json'))).toBe(false);
    expect(r.ran).not.toContain('Verify the retry tag matches the package');
    expect(r.calls.some(c=>c.command === 'git')).toBe(false);
  });
  test('push without a release remains a no-op', () => {
    const r = exercise({event:'push',created:'false'}); expect(r.status).toBe(0);
    expect(r.outputs.publish).toBe('false'); expect(r.calls).toEqual([]); expect(r.aliasRan).toBe(false);
    expect(r.actions.map(a=>a.uses)).toEqual(['googleapis/release-please-action@v4']);
  });
  test('same-SHA tag-ref alias-only dispatch uses served canonical, named missing alias, no canonical republish/build', () => {
    const r = exercise({tag:'',aliasVersion:'1.12.0',aliasNames:'spine-html',served:['@rig-c/play','rig-play']});
    expect(r.status).toBe(0); expect(r.aliasRan).toBe(true); expect(published(r)).toEqual(['spine-html']);
    expect(r.actions.find(a=>a.uses === 'actions/checkout@v4')?.ref).toBe('v1.12.0');
    expect(r.calls.some(c=>c.command === 'prepublishOnly' || c.command === 'gh' || c.command === 'bun' || c.command === 'npm' && c.args[0] === 'install' && !c.args.includes('-g'))).toBe(false);
    expect(r.calls.filter(c=>c.command === 'git').map(c=>c.args)).toEqual([['rev-parse','--verify','HEAD^{commit}']]);
    expect(r.calls.findIndex(c=>c.command === 'git')).toBeLessThan(r.calls.findIndex(c=>c.command === 'npm'));
    const pack = r.calls.find(c=>c.command === 'node' && c.args[1] === 'pack');
    expect(pack.args).toContain('--tarball');
    expect(r.calls.filter(c=>c.command === 'compared').map(c=>c.args)).toEqual([['@rig-c/play','spine-html','1.12.0']]);
  });
});
