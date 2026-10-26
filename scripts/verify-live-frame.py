"""Run the live-frame controls with four CPUs and a six-GiB process-tree budget."""
import json
import atexit
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import time

root = Path.cwd()
out = root.parent / 'evidence' / 'live-frame'
out.mkdir(parents=True, exist_ok=True)
limit = 6 * 1024 ** 3
records = []
cpus = sorted(os.sched_getaffinity(0))[:4]
os.sched_setaffinity(0, cpus)
os.environ.update(UV_THREADPOOL_SIZE='4', NODE_OPTIONS='--max-old-space-size=3072', GOMAXPROCS='4')

def tree_rss(group):
    table = {}
    for path in Path('/proc').iterdir():
        if not path.name.isdigit():
            continue
        try:
            fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
            table[int(path.name)] = (int(fields[1]), int(fields[2]), int(fields[21]) * os.sysconf('SC_PAGE_SIZE'))
        except (FileNotFoundError, ProcessLookupError, PermissionError, IndexError):
            continue
    chosen = {pid for pid, (_, pgid, _) in table.items() if pgid == group}
    while True:
        descendants = {pid for pid, (parent, _, _) in table.items() if parent in chosen}
        if descendants <= chosen:
            break
        chosen |= descendants
    return sum(table[pid][2] for pid in chosen if pid in table)

def run(name, command):
    print('LIVE_FRAME_COMMAND', json.dumps(command), flush=True)
    with (out / f'{name}.log').open('wb') as log:
        child = subprocess.Popen(command, cwd=root, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        peak = 0
        rejected = False
        while child.poll() is None:
            peak = max(peak, tree_rss(child.pid))
            if peak > limit:
                rejected = True
                os.killpg(child.pid, signal.SIGKILL)
                break
            time.sleep(0.1)
        code = child.wait()
    records.append({'name': name, 'command': command, 'exit': code, 'peakTreeRssBytes': peak, 'budgetRejected': rejected})
    (out / 'commands.json').write_text(json.dumps({'cpus': cpus, 'memoryLimitBytes': limit, 'commands': records}, indent=2))
    print('LIVE_FRAME_EXIT', json.dumps(records[-1]), flush=True)
    if code or rejected:
        print((out / f'{name}.log').read_text()[-12000:], flush=True)
        sys.exit(code if code > 0 else 1)

if '--bench' in sys.argv or '--final-controls' in sys.argv:
    def cleanup_host():
        shutil.rmtree(root / 'node_modules/.cache/adapters-host', ignore_errors=True)
        (root / 'node_modules/.cache/adapters-host.tar.gz').unlink(missing_ok=True)
    atexit.register(cleanup_host)

run('typecheck', ['bunx', '--no-install', 'tsc', '--noEmit'])
run('lease-controls', ['bun', 'test', 'tests/liveFrame.unit.test.ts'])
run('browser-install', ['bunx', '--no-install', 'playwright', 'install', 'chromium'])
if '--precheck' in sys.argv:
    fixture = root / 'public/rigs/turned'
    shutil.copytree(root / 'tests/rigs/turned', fixture, dirs_exist_ok=True)
    run('build-turned', ['bun', 'node_modules/rig-c/bin/rigc.cjs', 'build', '--rig', str(fixture / 'rig.json'), '--motion', str(fixture / 'motion.json'), '--atlas-in', str(fixture / 'art/turned.atlas'), '--out', str(fixture)])
    run('browser-precheck', ['bunx', '--no-install', 'playwright', 'test', '--config', 'playwright.live-frame.config.ts', '--grep', 'turned|composition|null attachment key'])
elif '--allocation' in sys.argv:
    fixture = root / 'public/rigs/turned'
    shutil.copytree(root / 'tests/rigs/turned', fixture, dirs_exist_ok=True)
    run('build-turned', ['bun', 'node_modules/rig-c/bin/rigc.cjs', 'build', '--rig', str(fixture / 'rig.json'), '--motion', str(fixture / 'motion.json'), '--atlas-in', str(fixture / 'art/turned.atlas'), '--out', str(fixture)])
    run('allocation-turned', ['bun', 'scripts/live-frame-allocation.mjs', 'public/rigs/turned/skeleton.model.json', 'hold'])
elif '--bench' in sys.argv or '--final-controls' in sys.argv:
    run('bench-host', ['bun', 'scripts/prepare-runtime-bench.mjs'])
    run('library', ['bun', 'run', 'build:lib'])
    run('same-frame-bench', ['bun', 'scripts/live-frame-bench.mjs'] + (['--probe-only'] if '--final-controls' in sys.argv else ['--events-diagnostic'] + (['--raptor-only'] if '--raptor-only' in sys.argv else [])))
    if '--final-controls' in sys.argv:
        run('fixtures', ['bun', 'run', 'fetch-assets'])
        for rig, animation in [('walk', 'walk'), ('portrait', 'idle'), ('portrait', 'gaze'), ('glow', 'burn'), ('glow', 'canary'), ('turned', 'hold')]:
            run(f'allocation-{rig}-{animation}', ['bun', 'scripts/live-frame-allocation.mjs', f'public/rigs/{rig}/skeleton.model.json', animation])
        run('browser-install-webkit', ['bunx', '--no-install', 'playwright', 'install', 'webkit'])
        run('live-frame-contracts', ['bunx', '--no-install', 'playwright', 'test', '--config', 'playwright.live-frame.config.ts'])
elif '--regression' in sys.argv:
    os.environ['TEST_PORT'] = '4342'
    run('browser-install-webkit', ['bunx', '--no-install', 'playwright', 'install', 'webkit'])
    run('production-regression', ['bunx', '--no-install', 'playwright', 'test', '--config', 'playwright.config.ts'])
else:
    run('fixtures', ['bun', 'run', 'fetch-assets'])
    run('browser-install-webkit', ['bunx', '--no-install', 'playwright', 'install', 'webkit'])
    run('live-frame-contracts', ['bunx', '--no-install', 'playwright', 'test', '--config', 'playwright.live-frame.config.ts'])
print('LIVE_FRAME_VERIFICATION_DONE', flush=True)
