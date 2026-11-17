// node scripts/test-sequence-ui.js — Prepare's sequence controls and order.
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const S = require('../ui/sequence-logic');
const elements = new Map();
function element() {
  const classes = new Set();
  return { children: [], dataset: {}, style: {}, classList: { add: (...xs) => xs.forEach(x => classes.add(x)), remove: (...xs) => xs.forEach(x => classes.delete(x)), toggle: (x, on) => on ? classes.add(x) : classes.delete(x), contains: x => classes.has(x) }, setAttribute(k, v) { this[k] = v; }, replaceChildren() { this.children = []; }, append(x) { this.children.push(x); }, addEventListener(k, f) { this[k] = f; } };
}
const $ = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
const buttons = ['by layer','by object'].map(sequence => Object.assign(element(), { dataset: { sequence } }));
let settings = {}, remembered = 0, renders = 0;
const objects = [{ id:1, name:'Tall', foot:[[0,0],[20,0],[20,20],[0,20]], height:80 }, { id:2, name:'Short', foot:[[150,0],[170,0],[170,20],[150,20]], height:10 }];
const PR = { objects, assoc:'object', bed:{w:270,d:270}, rowDrag:null };
const ctx = { ...S, PR, $, document: { querySelectorAll: s => s === '#p-seq [data-sequence]' ? buttons : [], createElement: element }, addEventListener(){},
  prTowerSetting:k => settings[k], prTowerRawSetting:k => settings[k], prTowerVirtualUsed:() => ctx.virtual || false,
  plSliced:xs => xs, bedState:()=>'on', shape:o=>({ zmin:0,zmax:o.height }), footprint:o=>o.foot,
  tr:(k,p)=> k + (p ? JSON.stringify(p):''), fmtDec:n=>String(n),
  prRemember:()=>remembered++, prSave(){}, prRenderInspector:()=>renders++, prSchedule(){},
  SL:{ memory:{} }, rememberFor:()=>({}), prTowerProfileName:()=>({machine:'U1'}),
  localStorage:{setItem(){}}, prTowerChanged(){}, advSet:(k,v)=>{settings[k]=v;},
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('ui/prepare-sequence.js','utf8'),ctx);
const run = code=>vm.runInContext(code,ctx);
assert.strictEqual(run('prSeqCheck()'),null);
settings.print_sequence = 'by object';
let r = run('prSeqCheck()');
assert.strictEqual(r.tall[0].id,1);
ctx.result = r;
run('prSeqRender(result)');
assert.strictEqual($('p-seq-message').children.length,2,'height conflict has a repair action');
$('p-seq-message').children[1].onclick();
assert.deepStrictEqual(PR.objects.map(o=>o.id),[2,1]);
assert.strictEqual(remembered,1,'reorder creates an undo step');
assert.strictEqual(renders,1);
assert.strictEqual(run('prSeqCheck().tall.length'),0,'repair clears the height conflict');
assert.ok(run('prSeqBadge(1)').includes('>2</span>'),'row number follows the new order');
PR.assoc='height';
run('prSeqRender(prSeqCheck())');
assert.strictEqual(buttons[1].disabled,true);
assert.strictEqual(buttons[0].disabled,false,'layer mode stays available to recover');
assert.strictEqual($('p-seq-message').children.length,1,'incompatible mode has no reorder repair');
PR.assoc='object'; ctx.virtual=true;
assert.strictEqual(run('prSeqCheck().blocked'),'virtual');
ctx.virtual=false; settings.print_sequence='by layer';
run('prSeqRender(null)');
$('s-machine').value='U1';
$('p-seq').click({target:{closest:()=>buttons[1]}});
assert.strictEqual(settings.print_sequence,'by object','visible selector writes the advanced setting');
const cached = run('prSeqCheck()');
assert.strictEqual(run('prSeqCheck()'), cached, 'unchanged scene reuses collision results');
ctx.result = cached;
run('prSeqRender(result)');
const child = $('p-seq-message').children[0];
run('prSeqRender(result)');
assert.strictEqual($('p-seq-message').children[0], child, 'unchanged message keeps the repair button alive');


// Execute the existing tower/pillar visibility chain, not a duplicate rule.
const tower = require('../ui/tower-logic');
const pillar = require('../ui/pillar-logic');
const extract = (file, pattern) => fs.readFileSync(file,'utf8').match(pattern)[0];
const towers = { ptState:tower.ptState, pmKind:pillar.pmKind,
  PR:{tower:{on:true,kind:'material'}}, prTowerHeads:()=>new Set([0,1]),
  prTowerSetting:()=> 'by object', prPillarHeads:()=>[], pmOffered:()=>true };
vm.createContext(towers);
vm.runInContext(extract('ui/prepare-tower.js', /const prTowerState = [\s\S]*?;/),towers);
vm.runInContext(extract('ui/prepare-pillars.js', /function prTowerKindNow[\s\S]*?\n}/),towers);
vm.runInContext(extract('ui/prepare-pillars.js', /const prPillarsShown = [^;]*;/),towers);
vm.runInContext(extract('ui/prepare-pillars.js', /function prPillarsRequest\(\)[\s\S]*?\n}/),towers);
assert.strictEqual(vm.runInContext('prPillarsShown()',towers),false,'sequential mode hides material towers');
assert.strictEqual(vm.runInContext('prPillarsRequest().length',towers),0,'sequential requests contain no pillars');

// Undo's real snapshot serializer/restorer preserve the object order.
const prepareSource = fs.readFileSync('ui/prepare.js', 'utf8');
vm.runInContext(prepareSource.slice(prepareSource.indexOf('const prSnap ='), prepareSource.indexOf('/* A state back:')), ctx);
vm.runInContext(extract('ui/prepare.js', /function prUnsnap\(snapshot\)[\s\S]*?\n}/), ctx);
const snapshot = run('prSnap()');
const oldIds = PR.objects.map(o => o.id);
PR.objects.reverse();
ctx.snapshot = snapshot;
run('prUnsnap(snapshot)');
assert.deepStrictEqual(Array.from(PR.objects, o => o.id), oldIds, 'Undo restores print order');
const unchanged = run('prSeqCheck()');
PR.objects[0].height += 5;
assert.notStrictEqual(run('prSeqCheck()'), unchanged, 'geometry edits invalidate the collision cache');
const rawCtx = { ADV: { rawDefaults: { max_layer_height:[.2,.3] }, defaults:{max_layer_height:.2} },
  PR:{towerProfile:{raw:{nozzle_diameter:[.4,.6]}}}, prTowerAdv:()=>({}), prTowerProfileValue:()=>0 };
vm.createContext(rawCtx);
vm.runInContext(extract('ui/prepare-tower.js', /function prTowerRawSetting\(k\)[\s\S]*?\n}/),rawCtx);
assert.deepStrictEqual(vm.runInContext('prTowerRawSetting("max_layer_height")',rawCtx),[.2,.3],'slice profile arrays reach clearance rules intact');
assert.deepStrictEqual(vm.runInContext('prTowerRawSetting("nozzle_diameter")',rawCtx),[.4,.6],'Prepare profile arrays stay intact before opening the sheet');
rawCtx.prTowerAdv = ()=>({max_layer_height:[.25,.35]});
assert.deepStrictEqual(vm.runInContext('prTowerRawSetting("max_layer_height")',rawCtx),[.25,.35],'advanced overrides take priority over raw profile');
// Exercise the actual async profile loader with a serialized Details shape:
// nozzle/layer arrays exist only in geometry, not in process values.
(async () => {
  const profile = { values:{skirt_type:'perobject',skirt_loops:'1',skirt_height:'9',skirt_distance:'4',initial_layer_line_width:'125%',support_filament:'2'}, geometry:{nozzle_diameter:['0.4','0.6'],max_layer_height:['0.2','0.3']} };
  Object.assign(profile.geometry, profile.values);
  const loader = { PR:{}, prTowerProfileName:()=>({machine:'Machine',process:'Process'}), invoke:async()=>profile, prTowerChanged(){} };
  vm.createContext(loader);
  vm.runInContext(extract('ui/prepare-tower.js', /async function prTowerLoadProfile\(\)[\s\S]*?\n}/), loader);
  await vm.runInContext('prTowerLoadProfile()', loader);
  const c = S.sqClearance(k=>loader.PR.towerProfile.raw[k]);
  assert.strictEqual(c.skirt.initial,.75,'machine-only nozzle arrays reach the clearance calculation');
  assert.strictEqual(S.sqGap([{height:10}],c),81.8,'machine-only layer heights reach the tall skirt calculation');
  console.log('sequence UI: ok');
})().catch(error=>{ console.error(error); process.exitCode=1; });
