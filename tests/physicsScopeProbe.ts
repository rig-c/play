import { openTrack, openTracks, physicsClockStep, underNoSkin, type LiveTrack, type LiveTracks } from 'rig-c/core';
import { loadModel, RigPlayer, type ModelAssets, type PhysicsMotion, type PhysicsMotionScope, type RenderMode } from '../src/index';
import type { ReadDocument } from '../src/loadModel';
import { PHYSICS_SCOPE_PROTOCOL as protocol, empiricalPeakCheck, nativePeakUlp, physicsScopeSample, rotationalSubsteps, type PhysicsScheduleState } from './physicsScopeProtocol';

const bits = (value: unknown): string => JSON.stringify(value, (_k, v: unknown) => typeof v === 'number' ? Object.is(v, -0) ? '-0' : String(v) : v);
type State = Record<string, number | boolean>;
type CountRecord = { step:number; x:number; y:number; rotate:number; shearX:number; scaleX:number; mix:number };
type Ctx = { states: Map<string, State>; time: number; last: number; phase: string; setupRecords?:Map<string,CountRecord> };
type Internal = { track: ({ track: { ctx: Ctx } } & LiveTrack) | null; tracks: ({ path: { ctx: Ctx } } & LiveTracks) | null };
function context(p: RigPlayer): Ctx {
  const i = p as unknown as Internal;
  return i.tracks !== null ? i.tracks.path.ctx : i.track!.track.ctx;
}
function coreContext(p: LiveTrack | LiveTracks): Ctx {
  return 'first' in p ? (p as unknown as {track:{ctx:Ctx}}).track.ctx : (p as unknown as {path:{ctx:Ctx}}).path.ctx;
}
const states = (p: RigPlayer): string => bits([...context(p).states]);
let asset: Promise<ModelAssets> | undefined;
const assets = (): Promise<ModelAssets> => asset ??= loadModel({ modelUrl:'/rigs/physics-scope/skeleton.model.json', setsUrl:null });
function player(a: ModelAssets, mode: RenderMode, tracks: boolean): RigPlayer {
  const root = document.createElement('div'); root.style.cssText='position:absolute;left:150px;top:270px;transform-origin:0 0';
  document.body.append(root);
  const p = new RigPlayer(root,a,{mode,tracks,liveFrameChecks:true});
  p.renderer.pixelRatio=1;
  const dispose=p.dispose.bind(p); p.dispose=()=>{dispose();root.remove();};
  return p;
}
const position = (p: RigPlayer): number[] => { const h=p.bone('head'),t=p.bone('hair_tip');return [h.x,h.y,t.x-h.x,t.y-h.y]; };
const countedNames = ['hair_1_phys','hair_2_phys'] as const;
function scheduleState(s:State|undefined):PhysicsScheduleState {
  if(!s||typeof s.remaining!=='number'||typeof s.lastTime!=='number'||typeof s.pending!=='boolean')throw new Error('actual physics schedule state missing');
  return {remaining:s.remaining,lastTime:s.lastTime,pending:s.pending};
}
function beforeSchedule(p:RigPlayer){
  const ctx=context(p);
  return {clock:ctx.time,phase:ctx.phase,counts:countedNames.map((name)=>{
    const record=ctx.setupRecords?.get(name);
    if(!record||record.mix!==1||record.x!==0||record.y!==0||record.scaleX!==0||record.rotate!==1||record.shearX!==0)throw new Error('counter requires the fixed active rotation-only fixture');
    return {name,record:{...record},before:scheduleState(ctx.states.get(name))};
  })};
}
function afterSchedule(p:RigPlayer,before:ReturnType<typeof beforeSchedule>,frame:number){
  const ctx=context(p);
  return {frame,beforeClock:before.clock,afterClock:ctx.time,beforePhase:before.phase,counts:before.counts.map(({name,record,before:state})=>{
    const after=scheduleState(ctx.states.get(name));const effectiveStep=ctx.setupRecords?.get(name)?.step;
    if(!Object.is(effectiveStep,record.step)||after.lastTime!==ctx.time)throw new Error('fixture step changed or constraint did not read the actual clock');
    const counted=rotationalSubsteps(state,after,record.step);
    return {name,before:state,after,...counted};
  })};
}
type ScheduleProof = ReturnType<typeof afterSchedule>;
interface ConstraintCount { name:string; effectiveStep:number; perFrame:number[]; F:number; totalSubsteps:number; cap:number }
export interface ScopeCalibrationCell { mode:RenderMode; tracks:boolean; a:number[][]; b:number[][]; nativeAAError:number; neutral:number[]; nativePeak:number; nativePeakFrame:number; ulp:number; F:number|null; cap:number|null; perConstraint:ConstraintCount[]; schedules:ScheduleProof[][] }
export interface ScopeCalibration { rule:string; cells:ScopeCalibrationCell[] }

/** Must run and return its complete immutable calibration before the A/B entry is called. */
export async function physicsScopeNativeAA():Promise<ScopeCalibration> {
  const a=await assets(); const cells:ScopeCalibrationCell[]=[];
  for(const mode of ['dom','canvas'] as const) for(const tracks of [false,true]) {
    const runs:number[][][]=[];const schedules:ScheduleProof[][]=[];const neutrals:number[][]=[];
    for(let run=0;run<2;run++) {
      const p=player(a,mode,tracks);p.play('native',{loop:false});const rows:number[][]=[];const tape:ScheduleProof[]=[];
      neutrals.push(position(p).slice(2));
      for(let f=1;f<=protocol.frames;f++){const before=beforeSchedule(p);p.advance(protocol.dt);tape.push(afterSchedule(p,before,f));p.draw();rows.push(position(p));}
      runs.push(rows);schedules.push(tape);p.dispose();
    }
    let nativeAAError=0,nativePeak=0,nativePeakFrame=0;
    for(let f=0;f<protocol.frames;f++){
      for(const c of [2,3]) nativeAAError=Math.max(nativeAAError,Math.abs(runs[0][f][c]-runs[1][f][c]));
      const amplitude=Math.hypot(runs[0][f][2]-neutrals[0][0],runs[0][f][3]-neutrals[0][1]);
      if(amplitude>nativePeak){nativePeak=amplitude;nativePeakFrame=f+1;}
    }
    if(bits(schedules[0])!==bits(schedules[1])||bits(neutrals[0])!==bits(neutrals[1]))throw new Error('fresh native A/A schedule or initial root-relative position differs');
    const ulp=nativePeakUlp(nativePeak);
    const perConstraint=countedNames.map((name)=>{
      const perFrame=schedules[0].map((row)=>row.counts.find((c)=>c.name===name)!.substeps);
      const F=perFrame.slice(0,nativePeakFrame).reduce((n,v)=>n+v,0);
      if(!Number.isSafeInteger(F)||F<=0)throw new Error('native peak has no counted rotational integration');
      return {name,effectiveStep:schedules[0][0].counts.find((c)=>c.name===name)!.step,perFrame,F,totalSubsteps:perFrame.reduce((n,v)=>n+v,0),cap:F*ulp};
    });
    const sameSchedule=perConstraint.every((c)=>bits(c.perFrame.slice(0,nativePeakFrame))===bits(perConstraint[0].perFrame.slice(0,nativePeakFrame)));
    const F=sameSchedule?perConstraint[0].F:null;
    cells.push({mode,tracks,a:runs[0],b:runs[1],nativeAAError,neutral:neutrals[0],nativePeak,nativePeakFrame,ulp,F,cap:F===null?null:F*ulp,perConstraint,schedules});
  }
  return {rule:protocol.toleranceRule,cells};
}

export async function physicsScopeAB(calibration:ScopeCalibration) {
  if(calibration.rule!==protocol.toleranceRule || calibration.cells.length!==4) throw new Error('native A/A calibration required first');
  const a=await assets(); const cells=[];
  for(const c of calibration.cells) {
    const p=player(a,c.mode,c.tracks), baseline=player(a,c.mode,c.tracks),legacy=player(a,c.mode,c.tracks),quiet=player(a,c.mode,c.tracks);
    p.play('deform',{loop:false});baseline.play('deform',{loop:false});legacy.play('deform',{loop:false});quiet.play('calm',{loop:false});
    let prev=p.bone('head').x,prevYaw=0,maxError=0,peakScoped=0,peakLegacy=0,peakNoInput=0,bodyMismatch=0,inputOutsiderMismatch=0;
    const peakNative=c.nativePeak,neutral=c.neutral;const rows=[];let headDeformMoved=false,leaseHeld=true,leaseStale=false;
    const firstHead=p.posedFrame().order.find((s)=>s.slot==='head');
    for(let f=1;f<=protocol.frames;f++) {
      const q=c.a[f-1][0]; const dx=q-prev;prev=q;
      const beforeBody=bits(context(p).states.get('body_phys'));const held=p.liveFrame();const generation=p.generation;
      p.physicsMoved({subtree:'head'},{translation:{x:dx,y:0}});
      if(bits(context(p).states.get('body_phys'))!==beforeBody)inputOutsiderMismatch++;
      try{void held.vertices.length;if(p.generation!==generation)leaseHeld=false;}catch{leaseHeld=false;}
      const yaw=physicsScopeSample(f).yaw;legacy.moved({rotation:yaw-prevYaw});prevYaw=yaw;
      for(const x of [p,baseline,legacy,quiet]){x.advance(protocol.dt);x.draw();}
      try{void held.vertices.length;}catch(e){if(String(e).includes('LIVE_FRAME_STALE'))leaseStale=true;}
      const actual=position(p),old=position(legacy),none=position(baseline);
      maxError=Math.max(maxError,Math.abs(actual[2]-c.a[f-1][2]),Math.abs(actual[3]-c.a[f-1][3]));
      peakScoped=Math.max(peakScoped,Math.hypot(actual[2]-neutral[0],actual[3]-neutral[1]));
      peakLegacy=Math.max(peakLegacy,Math.hypot(old[2]-neutral[0],old[3]-neutral[1]));
      peakNoInput=Math.max(peakNoInput,Math.hypot(none[2]-neutral[0],none[3]-neutral[1]));
      if(bits(context(p).states.get('body_phys'))!==bits(context(baseline).states.get('body_phys')))bodyMismatch++;
      const head=p.posedFrame().order.find((s)=>s.slot==='head');
      if(head&&firstHead&&head.kind==='mesh'&&firstHead.kind==='mesh'&&bits(head.vertices)!==bits(firstHead.vertices))headDeformMoved=true;
      rows.push({frame:f,native:c.a[f-1].slice(2),scoped:actual.slice(2),legacy:old.slice(2)});
    }
    const legacyBodyDiff=bits(context(legacy).states.get('body_phys'))!==bits(context(baseline).states.get('body_phys'));
    const peakChecks=c.perConstraint.map((constraint)=>({name:constraint.name,...empiricalPeakCheck(peakNative,peakScoped,peakLegacy,maxError,constraint.F)}));
    cells.push({mode:c.mode,tracks:c.tracks,nativeAAError:c.nativeAAError,nativePeakFrame:c.nativePeakFrame,F:c.F,ulp:c.ulp,cap:c.cap,perConstraint:c.perConstraint,maxError,coordinateDiagnosticUngated:true,peakChecks,amplitudePass:peakChecks.every((x)=>x.amplitudePass),legacyCapPass:peakChecks.every((x)=>x.legacyPass),peakNative,peakScoped,peakLegacy,peakNoInput,bodyMismatch,inputOutsiderMismatch,headDeformMoved,leaseHeld,leaseStale,legacyBodyDiff,rows});
    for(const x of [p,baseline,legacy,quiet])x.dispose();
  }
  return {rule:calibration.rule,cells};
}

export async function physicsScopeContracts(){
  const a=await assets();const problems:string[]=[];let checks=0;let refusalCases=0;
  const check=(ok:boolean,label:string)=>{checks++;if(!ok)problems.push(label);};
  const invalid:Array<[unknown,unknown,string]>=[
    [{bone:'missing'},{translation:{x:0,y:0}},'missing'],[{subtree:'missing'},{translation:{x:1,y:0}},'missing'],
    [{constraints:['hair_1_phys','missing']},{translation:{x:1,y:0}},'missing'],
    [{constraints:['hair_1_phys','body_ik']},{rotation:{degrees:3,pivot:[0,0]}},'body_ik'],
    [{bone:'head',subtree:'head'},{translation:{x:0,y:0}},'exactly one'],[null,{translation:{x:0,y:0}},'scope'],
    [{constraints:'hair_1_phys'},{translation:{x:0,y:0}},'constraints'],[{bone:'head'},{yaw:12},'yaw'],
    [{subtree:'head'},{translation:{x:NaN,y:0}},'translation.x'],[{subtree:'head'},{translation:{x:0,y:Infinity}},'translation.y'],
    [{subtree:'head'},{rotation:{degrees:1,pivot:[0]}},'pivot'],[{subtree:'head'},{rotation:{degrees:NaN,pivot:[0,0]}},'degrees'],
    [{subtree:'head'},{rotation:{degrees:1,pivot:[0,Infinity]}},'pivot[1]'],[{constraints:[7]},{translation:{x:0,y:0}},'name'],
    [{subtree:'head'},{translation:{x:1,y:0},rotation:{degrees:1,pivot:[0,0]}},'exactly one'],
  ];
  for(const mode of ['dom','canvas'] as const)for(const tracks of [false,true]){
    const p=player(a,mode,tracks);
    for(const [scope,motion,name]of invalid){const gen=p.generation;let error='';try{p.physicsMoved(scope as PhysicsMotionScope,motion as PhysicsMotion);}catch(e){error=String(e);}check(error.includes(name),`preplay ${mode}/${tracks} ${name} not refused`);check(p.generation===gen,`preplay refusal changed generation`);refusalCases++;}
    const shared=(a.document as ReadDocument).doc.constraints.filter((c)=>c.name==='hair_1_phys');
    check(shared.length===2&&shared[0].kind==='transform'&&shared[1].kind==='physics','shared-name fixture must place transform before physics');
    let sharedError='';try{p.physicsMoved({constraints:['hair_1_phys']},{translation:{x:0,y:0}});}catch(e){sharedError=String(e);}
    check(sharedError==='','preplay shared physics name must be accepted: '+sharedError);
    p.physicsMoved({subtree:'head'},{translation:{x:1,y:0}});p.play('deform',{loop:false});
    const doc=underNoSkin((a.document as ReadDocument).doc);
    const reference:LiveTrack|LiveTracks=tracks?openTracks(doc,{reset:'animation',clock:physicsClockStep}):openTrack(doc,'deform',{loop:false,reset:'animation',clock:physicsClockStep});
    if('start'in reference){reference.setAnimation(0,'deform',{loop:false,mixDuration:0});reference.start();}
    for(let f=0;f<20;f++){
      const before=states(p),gen=p.generation;
      for(const scope of [{subtree:'head'},{constraints:[]},{bone:'head'}] as PhysicsMotionScope[]){p.physicsMoved(scope,{translation:{x:0,y:-0}});p.physicsMoved(scope,{rotation:{degrees:0,pivot:[123,456]}});}
      check(states(p)===before&&p.generation===gen,'valid zero changed state/generation');
      p.advance(protocol.dt);reference.step(protocol.dt);check(states(p)===bits([...coreContext(reference).states]),'no-input player differs from plain core');
    }
    for(const [scope,motion,name]of invalid){const before=states(p),time=p.time;let error='';try{p.physicsMoved(scope as PhysicsMotionScope,motion as PhysicsMotion);}catch(e){error=String(e);}check(error.includes(name),'live refusal not named '+name);check(states(p)===before&&p.time===time,'atomic refusal mutated state '+name);refusalCases++;}
    const before=states(p);p.physicsMoved({bone:'head'},{translation:{x:3,y:2}});check(states(p)===before,'exact head selection incorrectly includes descendants');
    for(const [scope,names]of [[{bone:'hair_1'},['hair_1_phys']],[{subtree:'head'},['hair_1_phys','hair_2_phys']],[{constraints:['hair_2_phys']},['hair_2_phys']]] as [PhysicsMotionScope,string[]][]){
      p.physicsMoved(scope,{translation:{x:2,y:-1}});reference.physicsTranslate(2,-1,names);check(states(p)===bits([...coreContext(reference).states]),'scope did not select exact public-core names');
      p.physicsMoved(scope,{rotation:{degrees:7,pivot:[3,180]}});reference.physicsRotate(3,180,7,names);check(states(p)===bits([...coreContext(reference).states]),'rotation pivot/units differs from public core');
    }
    p.pause();const paused=states(p);p.physicsMoved({subtree:'head'},{translation:{x:1,y:0}});const applied=states(p);p.advance(0);check(paused!==applied&&states(p)===applied,'paused/zero advance should retain synchronous input');p.resume();
    reference.physicsTranslate(1,0,['hair_1_phys','hair_2_phys']);p.repose();reference.step(0);check(states(p)===bits([...coreContext(reference).states]),'repose does not follow core step(0)');
    p.dispose();
  }
  return {checks,refusalCases,problems};
}

/** A separate 48-frame picture receipt, after numerical A/A and A/B have finished. */
export async function physicsScopeShow(calibration:ScopeCalibration){
  const a=await assets();document.body.style.background='#eee';
  for(const [index,mode]of (['dom','canvas'] as const).entries()){
    const p=player(a,mode,false);p.play('deform',{loop:false});let prev=p.bone('head').x;
    for(let f=0;f<48;f++){const q=calibration.cells.find((c)=>c.mode===mode&&!c.tracks)!.a[f][0];p.physicsMoved({subtree:'head'},{translation:{x:q-prev,y:0}});prev=q;p.advance(protocol.dt);}
    const root=(p.renderer as unknown as {root:HTMLElement}).root;
    if(root)root.style.left=`${160+index*300}px`;
    p.draw();p.pause();
  }
}
