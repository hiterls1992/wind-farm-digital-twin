/* Generic 6–10 MW visual envelope; not manufacturer fabrication geometry.
 * Local axes: x=rotor tangent, y=up, z=shaft towards wind. Units: metres. */
(function(root){
'use strict';
function mesh(){return {positions:[],normals:[],indices:[]};}
function triangle(m,a,b,c){
 var u=b.map((v,i)=>v-a[i]),v=c.map((w,i)=>w-a[i]);
 var n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],l=Math.hypot(...n)||1;
 var i=m.positions.length/3;[a,b,c].forEach(p=>{m.positions.push(...p);m.normals.push(...n.map(v=>v/l));});m.indices.push(i,i+1,i+2);
}
function loft(m,rings){
 var count=rings[0].length;
 for(var j=0;j<rings.length-1;j++)for(var k=0;k<count;k++){
  var next=(k+1)%count;triangle(m,rings[j][k],rings[j][next],rings[j+1][next]);triangle(m,rings[j][k],rings[j+1][next],rings[j+1][k]);
 }
 // Close end sections.
 [0,rings.length-1].forEach(function(j){var r=rings[j],center=r.reduce((a,p)=>a.map((v,i)=>v+p[i]/count),[0,0,0]);for(var k=0;k<count;k++){
  if(j===0)triangle(m,center,r[(k+1)%count],r[k]);else triangle(m,center,r[k],r[(k+1)%count]);
 }});
}
function build(radius){
 var rotor=mesh(),body=mesh(),segments=32;
 // Smoothly varying chord, thickness ratio, twist and swept tip.
 var stations=[[.025,2.4,1,20],[.05,3.2,.65,19],[.10,4.6,.38,16],[.18,5.1,.27,12],[.28,4.7,.23,9],[.42,3.8,.20,6],[.60,2.8,.18,3],[.78,1.8,.16,1],[.92,.85,.14,0],[.985,.27,.12,-1],[1,.03,.10,-1]];
 for(var blade=0;blade<3;blade++){
  var phase=blade*Math.PI*2/3;
  var rings=stations.map(function(s){var ring=[],tw=s[3]*Math.PI/180;
   for(var k=0;k<segments;k++){
    var a=k*2*Math.PI/segments,xc=(1-Math.cos(a))/2;
    var thick=5*s[2]*(.2969*Math.sqrt(xc)-.126*xc-.3516*xc*xc+.2843*xc**3-.1036*xc**4);
    var chord=(xc-.30)*s[1],depth=Math.sign(Math.sin(a))*thick*s[1];
    var x=chord*Math.cos(tw)-depth*Math.sin(tw)+1.8*s[0]**4;
    var y=radius*s[0],z=chord*Math.sin(tw)+depth*Math.cos(tw)+1.5*s[0]**3;
    ring.push([x*Math.cos(phase)-y*Math.sin(phase),x*Math.sin(phase)+y*Math.cos(phase),z]);
   }return ring;
  });loft(rotor,rings);
 }
 // Rounded rectangular nacelle, narrowing aft; rotor plane sits ahead of tower.
 var sections=[[-17,.25,.35],[-16,1.7,1.9],[-14,2.25,2.35],[-6,2.45,2.45],[-3,2.1,2.15],[-2.5,1.7,1.8]];
 loft(body,sections.map(s=>Array.from({length:32},(_,k)=>{var a=k*Math.PI/16,c=Math.cos(a),v=Math.sin(a);return [s[1]*Math.sign(c)*Math.sqrt(Math.abs(c)),s[2]*Math.sign(v)*Math.sqrt(Math.abs(v))+.6,s[0]];})));
 // Streamlined spinner, pointed into wind.
 loft(rotor,[[-2.5,2.25],[-1,2.65],[.5,2.4],[2,1.6],[3.2,.15]].map(s=>Array.from({length:32},(_,k)=>[s[1]*Math.cos(k*Math.PI/16),s[1]*Math.sin(k*Math.PI/16),s[0]])));
 // Average normals at coincident loft vertices for a continuous moulded surface.
 [rotor,body].forEach(function(m){
  var sums=new Map(),keys=[];
  for(var i=0;i<m.positions.length;i+=3){var key=m.positions.slice(i,i+3).map(v=>v.toFixed(6)).join(',');keys.push(key);var sum=sums.get(key)||[0,0,0];for(var c=0;c<3;c++)sum[c]+=m.normals[i+c];sums.set(key,sum);}
  keys.forEach(function(key,i){var n=sums.get(key),l=Math.hypot(...n)||1;for(var c=0;c<3;c++)m.normals[i*3+c]=n[c]/l;});
 });
 return {rotor:rotor,body:body};
}
if(typeof module!=='undefined')module.exports=build;else root.buildTurbineMesh=build;
})(typeof window!=='undefined'?window:globalThis);
