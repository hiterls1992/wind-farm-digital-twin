/* Estimated allocation only: farm hourly kWh / 1h = mean kW. */
(function(root){
function allocate(total,turbines){
 var out=turbines.map(function(){return 0;}),remaining=Math.max(0,total);
 var active=turbines.map(function(t,i){return i;});
 while(active.length && remaining>1e-9){
  var sum=active.reduce(function(s,i){return s+turbines[i].rated_kw*turbines[i].hours;},0);
  if(sum<=0)break;
  var capped=active.filter(function(i){return remaining*turbines[i].rated_kw*turbines[i].hours/sum>turbines[i].rated_kw;});
  if(!capped.length){active.forEach(function(i){out[i]=remaining*turbines[i].rated_kw*turbines[i].hours/sum;});remaining=0;break;}
  capped.forEach(function(i){out[i]=turbines[i].rated_kw;remaining-=out[i];});
  active=active.filter(function(i){return capped.indexOf(i)<0;});
 }
 return {power_kw:out,unallocated_kw:Math.max(0,remaining)};
}
if(typeof module!=='undefined')module.exports=allocate;else root.allocateHourlyPower=allocate;
})(typeof window!=='undefined'?window:globalThis);
