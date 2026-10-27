/** Focused fixture producer; the normal build gate, including A18, owns emission. */
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=resolve(root,'public/rigs/physics-scope');mkdirSync(output,{recursive:true});
cpSync(resolve(root,'tests/rigs/physics-scope'),output,{recursive:true});
const cli=fileURLToPath(import.meta.resolve('rig-c/cli'));
const result=spawnSync('bun',[cli,'build','--rig','rig.json','--motion','motion.json','--out','.'],{cwd:output,stdio:'inherit'});
if(result.status!==0)throw new Error(`physics-scope fixture build exit ${result.status}`);
