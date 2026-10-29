const assert = require('node:assert/strict');
global.window = {};
require('../js/tower-j1.js');
const tower = window.TowerJ1, mesh = tower.build();
assert.equal(tower.DWG.callHeight, 24);
assert.equal(mesh.height, 30.7);
assert.equal(tower.widthAt(0), 4.372);
assert.equal(tower.widthAt(24), 1.271);
assert.equal(tower.widthAt(30.7), .4);
assert.equal(tower.DWG.ARM_HIGH.h, 27.6);
assert.equal(mesh.hooks.length, 3);
assert.ok(Math.abs(mesh.hooks[0].z + tower.INS_LEN - 24) < 1e-10);
assert.ok(mesh.positions.every(Number.isFinite));
assert.ok(mesh.positions.length / 3 < 65536);
for (let i=0;i<mesh.positions.length;i+=9) {
 const p=mesh.positions,n=mesh.normals;
 const a=[p[i+3]-p[i],p[i+4]-p[i+1],p[i+5]-p[i+2]],b=[p[i+6]-p[i],p[i+7]-p[i+1],p[i+8]-p[i+2]];
 const cross=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
 assert.ok(cross[0]*n[i]+cross[1]*n[i+1]+cross[2]*n[i+2]>=-1e-8);
}
console.log('24 m J1 tower: dimensions, hooks, finite geometry and winding passed');

// Cesium transforms the positions to Earth-centred coordinates before high/low encoding.
const app = require('node:fs').readFileSync(require('node:path').join(__dirname,'../js/app.js'),'utf8');
assert.match(app, /componentDatatype: Cesium.ComponentDatatype.DOUBLE,\s*componentsPerAttribute: 3,\s*values: new Float64Array\(geo.positions\)/);
const earth = 6378137;
assert.equal(new Float32Array([earth + .05])[0], earth);
assert.ok(Math.abs(new Float64Array([earth + .05])[0] - earth - .05) < 1e-8);
