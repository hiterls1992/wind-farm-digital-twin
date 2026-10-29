const assert = require('node:assert/strict');
const tangents = require('../js/tower-layout.js');
const towers = [{id:'a',x:0,y:0},{id:'b',x:100,y:0},{id:'c',x:200,y:0}];
for (const spans of [[{from:'a',to:'b'},{from:'b',to:'c'}],[{from:'b',to:'a'},{from:'b',to:'c'}]]) {
 const result = tangents(towers,spans);
 for (const d of Object.values(result)) {
  assert.ok(Math.abs(d.rx) < 1e-10); // east-west line => north-south crossarm
  assert.ok(Math.abs(Math.abs(d.ry)-1) < 1e-10);
  assert.ok(Math.abs(d.tx*d.rx+d.ty*d.ry)<1e-10);
 }
}
const bend = tangents([{id:'a',x:-100,y:0},{id:'b',x:0,y:0},{id:'c',x:100,y:100}], [{from:'a',to:'b'},{from:'b',to:'c'}]).b;
assert.ok(Math.abs(Math.atan2(bend.ty,bend.tx)-Math.PI/8)<1e-10);
console.log('Tower orientation: straight route, reversed span and bend passed');
