import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

test.beforeEach(async({page})=>{await page.goto('/tests/harness.html');await page.waitForFunction(()=>Boolean(window.rigPlayHarness));});
test('fresh native A/A freezes fixture empirical peak caps BEFORE scoped A/B, with independent body and real head deform',async({page},info)=>{
  const calibration=await page.evaluate(()=>window.rigPlayHarness.physicsScopeNativeAA());
  const serialized=JSON.stringify(calibration,null,2);
  writeFileSync(info.outputPath('native-aa.json'),serialized,{flag:'wx'});
  writeFileSync(info.outputPath('native-calibration.sha256'),createHash('sha256').update(serialized).digest('hex')+'\n',{flag:'wx'});
  console.log('PHYSICS_SCOPE_PROTOCOL02_CALIBRATION '+JSON.stringify({rule:calibration.rule,cells:calibration.cells.map((c)=>({mode:c.mode,tracks:c.tracks,nativeAAError:c.nativeAAError,nativePeak:c.nativePeak,nativePeakFrame:c.nativePeakFrame,F:c.F,ulp:c.ulp,cap:c.cap,perConstraint:c.perConstraint.map(({perFrame,...count})=>count)}))}));
  for(const cell of calibration.cells){
    expect(cell.nativeAAError,'fresh native A/A deterministic control').toBe(0);
    expect(cell.perConstraint.every((c)=>c.F>0),'counted rotational steps before native peak').toBe(true);
    expect(cell.schedules.every((tape)=>tape.every((row)=>row.counts.every((c)=>c.remainderExact))),'reconstructed budget agrees exactly with actual state').toBe(true);
  }
  // No floor, epsilon, rounding, trace adaptation or calibration rewrite after this point.
  const result=await page.evaluate((c)=>window.rigPlayHarness.physicsScopeAB(c),calibration);
  writeFileSync(info.outputPath('scope-ab.json'),JSON.stringify(result,null,2));
  console.log('PHYSICS_SCOPE_AB '+JSON.stringify(result.cells.map(({rows,...cell})=>cell)));
  for(const cell of result.cells){
    expect.soft(cell.amplitudePass,`${cell.mode}/${cell.tracks}: fixture empirical PEAK cap`).toBe(true);
    expect.soft(cell.legacyCapPass,'legacy peak excess at least1000 empirical caps').toBe(true);
    expect.soft(cell.peakNoInput,'no-input chain unchanged').toBe(0);
    expect.soft(cell.bodyMismatch,'body state exact against matched baseline').toBe(0);
    expect.soft(cell.inputOutsiderMismatch,'outside state unchanged at input').toBe(0);
    expect.soft(cell.headDeformMoved,'real head mesh deform moved').toBe(true);
    expect.soft(cell.leaseHeld,'movement leaves held live frame valid').toBe(true);
    expect.soft(cell.leaseStale,'advance invalidates the held lease').toBe(true);
    expect.soft(cell.peakScoped,'selected chain responds').toBeGreaterThan(0);
    expect.soft(cell.legacyBodyDiff,'legacy whole-rig spin is a non-isolation control').toBe(true);
  }
  expect.soft(result.cells[0].rows,'DOM/canvas single physics').toEqual(result.cells[2].rows);
  expect.soft(result.cells[1].rows,'DOM/canvas composed physics').toEqual(result.cells[3].rows);
  await page.evaluate((c)=>window.rigPlayHarness.physicsScopeShow(c),calibration);
  await page.evaluate(async()=>{await Promise.all([...document.images].map((x)=>x.decode()));});
  await page.screenshot({path:info.outputPath('physics-scope.png')});
});
test('scope, units, atomic names, zero/no-input, both live forms and synchronous evaluation contracts',async({page},info)=>{
  const result=await page.evaluate(()=>window.rigPlayHarness.physicsScopeContracts());
  writeFileSync(info.outputPath('scope-contracts.json'),JSON.stringify(result,null,2));
  console.log('PHYSICS_SCOPE_CONTRACTS '+JSON.stringify(result));expect(result.problems).toEqual([]);expect(result.checks).toBeGreaterThan(0);
});
