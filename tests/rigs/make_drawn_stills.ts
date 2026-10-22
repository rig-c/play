/**
 * Writes the reference stills `tests/player.spec.ts` holds `drawn` sets to
 * (#170): for each named combination of a rig's sets, the setup-pose rig that
 * `@rig-c/parts check --set` renders that set in, made by parts' own
 * `stillRigForSet` (which poses the set's bones through `poseRigBonesForDrawn`).
 *
 *     PARTS_SRC=<an installed @rig-c/parts>/src bun tests/rigs/make_drawn_stills.ts <rig dir> <set>[+<set>…] …
 *
 * The outputs are committed (`<rig dir>/stills/<combination>/`), so neither the
 * suite nor `fetch-assets.sh` needs `@rig-c/parts`: this script is here so the
 * references are reproducible, the way `make_parts.ts` is for the art. The
 * committed stills were written with @rig-c/parts 1.58.0. Several sets are
 * applied as one, their `slots`, `hides` and `drawn` merged — the composition
 * the player's `setSets` makes, which parts has no command for.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const partsSrc = process.env.PARTS_SRC;
if (partsSrc === undefined || partsSrc === '') {
  console.error('PARTS_SRC must name an installed @rig-c/parts src directory');
  process.exit(2);
}
const { stillRigForSet } = (await import(join(resolve(partsSrc), 'check.ts'))) as {
  stillRigForSet: (rig: Record<string, unknown>, alt: unknown, drawn?: Readonly<Record<string, number>>) => Record<string, unknown>;
};

const [rigDir, ...combinations] = process.argv.slice(2);
if (rigDir === undefined || combinations.length === 0) {
  console.error('usage: make_drawn_stills.ts <rig dir> <set>[+<set>…] …');
  process.exit(2);
}
const rig = JSON.parse(readFileSync(join(rigDir, 'rig.json'), 'utf8')) as Record<string, unknown>;
const motion = JSON.parse(readFileSync(join(rigDir, 'motion.json'), 'utf8')) as Record<string, unknown>;
const sets = (JSON.parse(readFileSync(join(rigDir, 'sets.json'), 'utf8')) as {
  sets: Record<string, { slots: Record<string, string>; hides?: string[]; drawn?: Record<string, number> }>;
}).sets;

for (const combination of combinations) {
  const names = combination.split('+');
  const alt = { name: combination, slots: {} as Record<string, string>, hides: [] as string[] };
  let drawn: Record<string, number> | undefined;
  for (const name of names) {
    const set = sets[name];
    if (set === undefined) throw new Error(`no set ${JSON.stringify(name)} in ${rigDir}/sets.json`);
    Object.assign(alt.slots, set.slots);
    alt.hides.push(...(set.hides ?? []));
    if (set.drawn !== undefined) drawn = { ...drawn, ...set.drawn };
  }
  const still = stillRigForSet(rig, alt, drawn);
  const out = join(rigDir, 'stills', combination);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'rig.json'), `${JSON.stringify(still, null, 2)}\n`);
  writeFileSync(join(out, 'motion.json'), `${JSON.stringify(motion, null, 2)}\n`);
  console.log(`  ${out}`);
}
