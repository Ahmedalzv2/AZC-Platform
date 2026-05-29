import { readFileSync, readdirSync } from 'node:fs';
import { decideStep, tradeNetR, STRATEGY_PARAMS as BP } from '../strategy-trend-trail.mjs';
const H=3600000, DAY=86400000;
function bucket(bars,ms){const m=new Map();for(const x of bars){const k=Math.floor(x.t/ms)*ms;const e=m.get(k);if(!e)m.set(k,{t:k,o:x.o,h:x.h,l:x.l,c:x.c});else{e.h=Math.max(e.h,x.h);e.l=Math.min(e.l,x.l);e.c=x.c;}}return[...m.values()].sort((a,b)=>a.t-b.t);}
function replay(bars,P){const t=[];let pos=null;for(let i=0;i<bars.length;i++){const d=decideStep({bars,i,position:pos,params:P});if(d.action==='open')pos={dir:d.dir,entry:d.entry,initialStop:d.initialStop,atrAtEntry:d.atrAtEntry,hwm:d.entry,lwm:d.entry};else if(d.action==='hold'&&pos){pos.hwm=d.hwm;pos.lwm=d.lwm;}else if(d.action==='close'&&pos){t.push({t:bars[i].t,netR:tradeNetR({dir:pos.dir,entry:pos.entry,exit:d.exit,atrAtEntry:pos.atrAtEntry,params:P}).netR});pos=null;}}return t;}
const files=readdirSync('tests/fixtures').filter(f=>/-1095d-Min60\.json$/.test(f));
const raws=files.map(f=>JSON.parse(readFileSync('tests/fixtures/'+f,'utf8')));
// build daily-PnL series for a set of TFs, each sleeve at riskPct/numSleeves
function portfolio(tfsH){
 const risk=BP.riskPct/tfsH.length; const daily=new Map();
 for(const raw of raws) for(const tf of tfsH){
   const P={...BP,don:tf===2?40:tf===8?20:30}; // scale lookback loosely by TF
   for(const tr of replay(bucket(raw,tf*H),P)){const d=Math.floor(tr.t/DAY)*DAY;daily.set(d,(daily.get(d)||0)+risk*tr.netR);}
 }
 const days=[...daily.keys()].sort((a,b)=>a-b);
 let eq=1,peak=1,dd=0;const rets=[];for(const d of days){const r=daily.get(d);eq*=(1+r);if(eq>peak)peak=eq;const x=(peak-eq)/peak;if(x>dd)dd=x;rets.push(r);}
 const span=(days.at(-1)-days[0])/DAY/30;
 const mean=rets.reduce((a,b)=>a+b,0)/rets.length,sd=Math.sqrt(rets.reduce((a,b)=>a+(b-mean)**2,0)/rets.length)||1e-9;
 return {eq,monthly:(eq**(1/span)-1)*100,dd:dd*100,sharpe:mean/sd*Math.sqrt(365),ret2dd:((eq-1)*100)/(dd*100)};
}
const f=m=>`$200→$${(200*m.eq).toFixed(0)} (${m.monthly.toFixed(1)}%/mo) Sharpe=${m.sharpe.toFixed(2)} maxDD=${m.dd.toFixed(0)}% return/DD=${m.ret2dd.toFixed(1)}`;
console.log('25 symbols · full 3yr · daily-combined equity · 0.5% total risk budget');
console.log('4h only      :',f(portfolio([4])));
console.log('2h+4h+8h ens :',f(portfolio([2,4,8])));
