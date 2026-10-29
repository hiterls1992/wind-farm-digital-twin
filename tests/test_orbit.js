const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../js/app.js'),'utf8');
const actions={},events={};let latest,picks=0;
class V{constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}static clone(v){return new V(v.x,v.y,v.z);}static magnitude(v){return Math.hypot(v.x,v.y,v.z);}}
class M{static inverseTransformation(f){return f;}static multiplyByPoint(f,p){return V.clone(p);}} M.IDENTITY={};
class Handler{setInputAction(fn,type,modifier){actions[type+':'+modifier]=fn;}}
const controls={enableInputs:true};const camera={positionWC:new V(30,40,20),cancelFlight(){},lookAt(p,offset){latest={p,offset};},lookAtTransform(){}};
const context={Cesium:{Cartesian3:V,Cartesian2:V,Matrix4:M,Transforms:{eastNorthUpToFixedFrame:p=>p},ScreenSpaceEventHandler:Handler,ScreenSpaceEventType:{MIDDLE_DOWN:1,MOUSE_MOVE:2,MIDDLE_UP:3},KeyboardEventModifier:{SHIFT:4}},scene:{canvas:{clientWidth:800,clientHeight:600},pickPositionSupported:true,pickPosition(){picks++;return new V();},requestRender(){}},viewer:{camera},cameraControls:controls,window:{addEventListener:(name,fn)=>events[name]=fn}};
vm.runInNewContext(source.slice(source.indexOf('  var orbitDrag = null;'),source.indexOf('  scene.backgroundColor')),context);
actions['1:4']({position:{x:400,y:300}});assert.equal(controls.enableInputs,false);
for(let i=1;i<=100;i++)actions['2:4']({endPosition:{x:400+i,y:300+i/2}});
assert.equal(picks,1);assert.ok(Math.abs(V.magnitude(latest.offset)-Math.hypot(30,40,20))<1e-9);
actions['3:undefined']();assert.equal(controls.enableInputs,true);
actions['1:4']({position:{x:400,y:300}});events.blur();assert.equal(controls.enableInputs,true);
console.log('Orbit: pivot locked, radius preserved, mouseup and blur restore navigation');
