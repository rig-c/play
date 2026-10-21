/** TEST ONLY: unchanged released Review reader and placement formula.
 * Source: https://github.com/rig-c/review/blob/9c1338e53281bb0ebac4d8dd984966668c6e12c1/src/setup-mesh.ts
 * Original SHA-256: 8f3d6eb19ccb2bfaaa37f81c7f21d3945d0e138eeb0f06bde75a860b82989f98
 * Placement is lines 83-143 in that source. Never import this into production.
 * This stored-only compatibility reference does not apply setup-slider deform.
 */
/**
 * The setup-space mesh reader shared by Setup · Weights (#107) and Edit Mesh (#100): one slot's mesh attachment read
 * from the compiled model document as stored, plus the published player's skinning formula that places it. Pure — no
 * DOM, no I/O; nothing here edits, normalises or infers a vertex or a weight.
 *
 * `rigc-compiled/3` stores a mesh attachment's setup-pose vertices at `skins[].attachments.<slot>.<name>.vertices`:
 * `{weighted: false, xy}` — x, y pairs local to the slot's bone, so every vertex is the slot's bone at 1.0 — or
 * `{weighted: true, bindings}` — one list per vertex of `{bone, x, y, weight}` (the bone by name). A `linkedmesh`
 * carries no vertices of its own; it draws its source mesh's (`{skin, slot, source}`), read here the same way.
 *
 * Each caller names its refusals (`SetupMeshCodes`), so a missing document is `WEIGHTS_MODEL_UNAVAILABLE` in the
 * weights block and `MESH_EDIT_MODEL_UNAVAILABLE` in Edit Mesh, from the same check.
 */
export interface SetupMeshCodes {
 /** No model document, or not `rigc-compiled/3`. */
 unavailable:string;
 /** No slot selected (whole rig). */
 select:string;
 /** The slot has no mesh attachment there. */
 noMesh:string;
 /** The stored entry does not read. */
 invalid:string;
 /** What the caller reads from the document, for the refusal text ("weights are", "the mesh is"). */
 subject:string;
 /** The select refusal's own text after the code. */
 selectText:string;
}

/** One stored influence of one vertex: the bone, the vertex in that bone's space and the weight, as stored. */
export interface WeightInfluence {bone:string;x:number;y:number;weight:number}
export interface SetupMeshRead {
 slot:string;skin:string;attachment:string;
 /** Where the vertices were read: the attachment itself, or a linked mesh's source. */
 source:{skin:string;slot:string;attachment:string};
 /** The attachment is a `linkedmesh` (its vertices are its source's). */
 linked:boolean;
 weighted:boolean;
 /** Per vertex, the influences in stored order. */
 vertices:WeightInfluence[][];
 /** Every bone that influences a vertex, in first-stored order. */
 bones:string[];
 /** The read entry's triangle indices, as stored. */
 triangles:number[];
 /** The read entry's `hull` (the first `hull` vertices, in order, are the outline), or null when it stores none. */
 hull:number|null;
 /** The attachment's own entry as stored (the linked mesh itself when linked) — what a source hash is taken over. */
 entry:Record<string,unknown>;
}
export type SetupMeshReadResult={ok:true;mesh:SetupMeshRead}|{ok:false;code:string};

type Obj=Record<string,unknown>;
const isObject=(v:unknown):v is Obj=>!!v&&typeof v==='object'&&!Array.isArray(v);
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);

/** The compiled model document, or the refusal that names why there is none (a package without one). */
export function setupModel(model:unknown,codes:Pick<SetupMeshCodes,'unavailable'|'subject'>):{ok:true;model:Obj}|{ok:false;code:string} {
 if(model===null||model===undefined)return {ok:false,code:`${codes.unavailable}: the package supplies no compiled model document (skeleton.model.json); ${codes.subject} read from it`};
 if(!isObject(model)||model.spec!=='rigc-compiled/3')return {ok:false,code:`${codes.unavailable}: the model document is not rigc-compiled/3`};
 return {ok:true,model};
}

function attachmentOf(model:Obj,skin:string,slot:string,name:string):Obj|undefined {
 const skins=Array.isArray(model.skins)?model.skins:[];
 const found=skins.find(s=>isObject(s)&&s.name===skin) as Obj|undefined;
 const slots=found&&isObject(found.attachments)?found.attachments[slot]:undefined;
 const entry=isObject(slots)?slots[name]:undefined;
 return isObject(entry)?entry:undefined;
}
/** Without an identity: the slot's mesh attachment named like the slot, else its only mesh (first skin that has it). */
function guessFree(model:Obj,slot:string):{skin:string;attachment:string}|null {
 const found:{skin:string;attachment:string}[]=[];
 for(const s of Array.isArray(model.skins)?model.skins:[]){
  if(!isObject(s)||typeof s.name!=='string'||!isObject(s.attachments)||!isObject(s.attachments[slot]))continue;
  for(const [name,a]of Object.entries(s.attachments[slot] as Obj))if(isObject(a)&&(a.kind==='mesh'||a.kind==='linkedmesh'))found.push({skin:s.name,attachment:name});
 }
 return found.find(f=>f.attachment===slot)??(found.length===1?found[0]!:null);
}

/**
 * The setup-pose mesh of `slot`'s attachment `active` (the identity the setup pose resolved; null takes the slot's mesh
 * named like the slot, else its only one), exactly as stored.
 */
export function readSetupMesh(model:unknown,slot:string|null,active:{skin:string;attachment:string}|null,codes:SetupMeshCodes):SetupMeshReadResult {
 const doc=setupModel(model,codes);if(!doc.ok)return doc;
 if(!slot)return {ok:false,code:`${codes.select}: ${codes.selectText}`};
 const slots=Array.isArray(doc.model.slots)?doc.model.slots:[];
 const slotEntry=slots.find(s=>isObject(s)&&s.name===slot) as Obj|undefined;
 if(!slotEntry||typeof slotEntry.bone!=='string')return {ok:false,code:`${codes.noMesh} ${slot}: the model has no such slot`};
 const key=active??guessFree(doc.model,slot);
 if(!key)return {ok:false,code:`${codes.noMesh} ${slot}: no mesh attachment`};
 const own=attachmentOf(doc.model,key.skin,slot,key.attachment);let entry=own,source={skin:key.skin,slot,attachment:key.attachment};
 if(entry?.kind==='linkedmesh'){
  if(typeof entry.skin!=='string'||typeof entry.slot!=='string'||typeof entry.source!=='string')return {ok:false,code:`${codes.invalid}: ${slot} / ${key.attachment} is a linked mesh without skin, slot and source`};
  source={skin:entry.skin,slot:entry.slot,attachment:entry.source};entry=attachmentOf(doc.model,source.skin,source.slot,source.attachment);
 }
 if(!own||!entry||entry.kind!=='mesh')return {ok:false,code:`${codes.noMesh} ${slot}: ${key.skin} / ${key.attachment} is not a mesh attachment`};
 const bones=new Set((Array.isArray(doc.model.bones)?doc.model.bones:[]).map(b=>isObject(b)&&typeof b.name==='string'?b.name:'').filter(Boolean));
 const v=entry.vertices,invalid=(why:string)=>({ok:false as const,code:`${codes.invalid}: ${source.slot} / ${source.attachment} ${why}`});
 if(!isObject(v)||typeof v.weighted!=='boolean')return invalid('vertices are not { weighted, xy | bindings }');
 const vertices:WeightInfluence[][]=[];
 if(!v.weighted){
  if(!Array.isArray(v.xy)||v.xy.length%2||!v.xy.every(finite))return invalid('xy is not an even list of finite numbers');
  const bone=slotEntry.bone as string;
  for(let i=0;i<v.xy.length;i+=2)vertices.push([{bone,x:v.xy[i] as number,y:v.xy[i+1] as number,weight:1}]);
 }else{
  if(!Array.isArray(v.bindings))return invalid('bindings is not a list');
  for(const [i,influences]of v.bindings.entries()){
   if(!Array.isArray(influences)||!influences.length)return invalid(`bindings[${i}] is not a non-empty list`);
   const row:WeightInfluence[]=[];
   for(const b of influences){
    if(!isObject(b)||typeof b.bone!=='string'||!bones.has(b.bone)||!finite(b.x)||!finite(b.y)||!finite(b.weight))return invalid(`bindings[${i}] names an unknown bone or a non-finite x, y or weight`);
    row.push({bone:b.bone,x:b.x,y:b.y,weight:b.weight});
   }
   vertices.push(row);
  }
 }
 const triangles=entry.triangles;
 if(!Array.isArray(triangles)||triangles.length%3||!triangles.every(t=>Number.isSafeInteger(t)&&(t as number)>=0&&(t as number)<vertices.length))return invalid('triangles are not whole indices into its vertices');
 const hull=Number.isSafeInteger(entry.hull)&&(entry.hull as number)>=0&&(entry.hull as number)<=vertices.length?entry.hull as number:null;
 const order:string[]=[];for(const row of vertices)for(const i of row)if(!order.includes(i.bone))order.push(i.bone);
 return {ok:true,mesh:{slot,skin:key.skin,attachment:key.attachment,source,linked:own.kind==='linkedmesh',weighted:v.weighted,vertices,bones:order,triangles:[...triangles] as number[],hull,entry:own}};
}

/** A bone's world transform as the published player reports it (`BoneWorld`'s x, y, a, b, c, d). */
export interface WorldTransform {x:number;y:number;a:number;b:number;c:number;d:number}
/**
 * One vertex's world position from its stored influences and the bones' world transforms: the published player's own
 * skinning formula (`worldVertices` in `@rig-c/play`: coordinates and weights through `Math.fround`, each influence
 * `(x·a + y·b + worldX, x·c + y·d + worldY) · weight`, summed; an unweighted vertex is its slot bone's transform at 1).
 */
export function skinVertex(influences:readonly WeightInfluence[],world:(bone:string)=>WorldTransform,weighted:boolean):{x:number;y:number} {
 let wx=0,wy=0;
 for(const i of influences){
  const t=world(i.bone),x=Math.fround(i.x),y=Math.fround(i.y),w=weighted?Math.fround(i.weight):1;
  wx+=(x*t.a+y*t.b+t.x)*w;wy+=(x*t.c+y*t.d+t.y)*w;
 }
 return {x:wx,y:wy};
}
/** Every vertex of a read mesh placed in world space through `world` (flat x, y pairs), or null when one is not finite. */
export function placeSetupMesh(mesh:Pick<SetupMeshRead,'vertices'|'weighted'>,world:(bone:string)=>WorldTransform):number[]|null {
 const out:number[]=[];
 for(const influences of mesh.vertices){const p=skinVertex(influences,world,mesh.weighted);if(!Number.isFinite(p.x)||!Number.isFinite(p.y))return null;out.push(p.x,p.y);}
 return out;
}
