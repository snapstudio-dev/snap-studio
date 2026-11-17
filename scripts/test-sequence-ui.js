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
  prTowerSetting:k => settings[k], prTowerVirtualUsed:() => ctx.virtual || false,
  plSliced:xs => xs, bedState:()=>'on', shape:o=>({ zmin:0,zmax:o.height }), footprintPoly:o=>o.foot,
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
console.log('sequence UI: ok');
