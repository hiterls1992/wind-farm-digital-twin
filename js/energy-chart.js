/* Yearless hourly kWh -> MWh display; no fabricated reporting year. */
window.renderHourlyChart = (function(){
  var data, canvas, context, points=[], hover=-1, initialized=false;
  var seriesKey='',cachedSeries=[],framePending=false;
  function scheduleDraw(){if(framePending)return;framePending=true;requestAnimationFrame(function(){framePending=false;draw();});}
  var rangeStart=0,rangeEnd=null,seriesLength=0;
  function zoomRange(start,end,total,ratio,factor,minPoints){
    var span=end-start;
    var next=Math.min(total,Math.max(Math.min(minPoints,total),Math.round(span*factor)));
    var anchor=start+ratio*span;
    var first=Math.max(0,Math.min(total-next,Math.round(anchor-ratio*next)));
    return [first,first+next];
  }
  function draw(){
    if(!data || canvas.clientWidth<10)return;
    var month=Number(document.getElementById('energyMonth').value), mode=document.getElementById('energyGranularity').value;
    var key=month+':'+mode;
    if(key!==seriesKey){
    points=[];
    data.values.forEach(function(v,i){
      if(month && data.months[i]!==month)return;
      var label=mode==='hour'?data.labels[i]:mode==='day'?data.labels[i].slice(0,5):data.labels[i].slice(0,2)+'月';
      var last=points[points.length-1];
      if(last && last.label===label)last.value+=v/1000;else points.push({label:label,value:v/1000});
    });
      cachedSeries=points;seriesKey=key;
    }
    points=cachedSeries;
    var displayed=points.map(function(p){return p.value;});
    seriesLength=points.length;
    var end=rangeEnd===null?seriesLength:Math.min(seriesLength,rangeEnd);
    rangeStart=Math.max(0,Math.min(rangeStart,Math.max(0,end-1)));
    points=points.slice(rangeStart,end);
    displayed=displayed.slice(rangeStart,end);
    document.getElementById('energyResetRange').disabled=rangeStart===0 && end===seriesLength;
    var w=canvas.clientWidth,h=canvas.clientHeight,dpr=window.devicePixelRatio||1;
    canvas.width=w*dpr;canvas.height=h*dpr;context.setTransform(dpr,0,0,dpr,0,0);context.clearRect(0,0,w,h);
    var left=48,right=w-16,top=12,bottom=h-25,max=Math.max(1,...points.map(p=>p.value))*1.08;
    context.font='10px sans-serif';context.fillStyle='#9eb9cd';context.strokeStyle='rgba(120,170,200,.18)';
    for(var j=0;j<=3;j++){var y=bottom-(bottom-top)*j/3;context.beginPath();context.moveTo(left,y);context.lineTo(right,y);context.stroke();context.fillText((max*j/3).toFixed(mode==='hour'?0:1),2,y+3);}
    var x=function(i){return left+(right-left)*(i+.5)/Math.max(1,points.length);};
    function path(){
      context.beginPath();
      if(!points.length)return;
      context.moveTo(x(0),bottom-displayed[0]/max*(bottom-top));
      for(var i=1;i<points.length;i++){
        var prevY=bottom-displayed[i-1]/max*(bottom-top),nextY=bottom-displayed[i]/max*(bottom-top);
        context.quadraticCurveTo(x(i-1),prevY,(x(i-1)+x(i))/2,(prevY+nextY)/2);
      }
      context.lineTo(x(points.length-1),bottom-displayed[points.length-1]/max*(bottom-top));
    }
    var gradient=context.createLinearGradient(0,top,0,bottom);
    gradient.addColorStop(0,'rgba(34,211,238,0.58)');
    gradient.addColorStop(1,'rgba(34,211,238,0.025)');
    context.fillStyle=gradient;
    if(mode==='month'){
      points.forEach(function(p,i){var y=bottom-p.value/max*(bottom-top);context.fillRect(x(i)-(right-left)/points.length*.3,y,(right-left)/points.length*.6,bottom-y);});
    }else if(points.length){
      path();context.lineTo(x(points.length-1),bottom);context.lineTo(x(0),bottom);context.closePath();context.fill();
      path();context.strokeStyle='#42dded';context.lineWidth=1.6;context.lineJoin='round';context.stroke();
    }
    context.fillStyle='#9eb9cd';[0,Math.floor(points.length/2),points.length-1].forEach(function(i){if(points[i])context.fillText(points[i].label,Math.min(right-65,Math.max(left,x(i)-20)),h-7);});
    var total=points.reduce((sum,p)=>sum+p.value,0);
    document.getElementById('energyChartNote').textContent=(rangeStart>0 || end<seriesLength ? points[0].label+' — '+points[points.length-1].label : (month?month+'月':'全年'))+' · '+points.length+'个'+(mode==='hour'?'小时':mode==='day'?'日':'月')+' · 电量 '+total.toLocaleString('zh-CN',{maximumFractionDigits:1})+' MWh'+' · 原始数据';
    if(hover>=0 && points.length){var i=Math.min(points.length-1,hover);context.strokeStyle='#ffb020';context.beginPath();context.moveTo(x(i),top);context.lineTo(x(i),bottom);context.stroke();document.getElementById('energyChartNote').textContent=points[i].label+' · 原值 '+points[i].value.toLocaleString('zh-CN',{maximumFractionDigits:2})+' MWh';}
  }
  return function(payload){
    if(data!==payload)seriesKey='';
    data=payload;if(!data)return;
    if(!initialized){
      canvas=document.getElementById('energyCanvas');context=canvas.getContext('2d');
      ['energyMonth','energyGranularity'].forEach(function(id){document.getElementById(id).addEventListener('change',function(){hover=-1;rangeStart=0;rangeEnd=null;scheduleDraw();});});
      canvas.addEventListener('mousemove',function(e){var next=Math.max(0,Math.min(points.length-1,Math.floor((e.offsetX-48)/(canvas.clientWidth-64)*points.length)));if(next===hover)return;hover=next;scheduleDraw();});
      canvas.addEventListener('wheel',function(e){
        e.preventDefault();e.stopPropagation();
        if(!seriesLength || !e.deltaY)return;
        var ratio=Math.max(0,Math.min(1,(e.offsetX-48)/(canvas.clientWidth-64)));
        var mode=document.getElementById('energyGranularity').value;
        var end=rangeEnd===null?seriesLength:rangeEnd;
        var next=zoomRange(rangeStart,end,seriesLength,ratio,e.deltaY<0?.8:1.25,mode==='hour'?6:2);
        rangeStart=next[0];rangeEnd=next[1];hover=-1;scheduleDraw();
      },{passive:false});
      function resetRange(){rangeStart=0;rangeEnd=null;hover=-1;scheduleDraw();}
      document.getElementById('energyResetRange').addEventListener('click',resetRange);
      canvas.addEventListener('dblclick',resetRange);
      canvas.addEventListener('mouseleave',function(){hover=-1;scheduleDraw();});
      new ResizeObserver(scheduleDraw).observe(canvas);initialized=true;
    }
    scheduleDraw();
  };
})();
