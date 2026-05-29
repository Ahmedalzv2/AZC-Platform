import { readFileSync, readdirSync } from 'node:fs';
import { decideStep } from '../strategy-trend-trail.mjs';
const H=3600000, TAKER=0.0006, SLIP=0.001, RISK=0.005;
const P={don:30,atrN:14,atrMult:2,trail:3,regimeN:20,erMin:0.35};
function bucket(b,ms){const m=new Map();for(const x of b){const k=Math.floor(x.t/ms)*ms;const e=m.get(k);if(!e)m.set(k,{t:k,o:x.o,h:x.h,l:x.l,c:x.c});else{e.h=Math.max(e.h,x.h);e.l=Math.min(e.l,x.l);e.c=x.c;}}return[...m.values()].sort((a,b)=>a.t-b.t);}
const syms=readdirSync('tests/fixtures').filter(f=>/-1095d-Min60\.json$/.test(f)).map(f=>({sym:f.split('-')[0],bars:bucket(JSON.parse(readFileSync('tests/fixtures/'+f,'utf8')),4*H)}));
const timeline=[...new Set(syms.flatMap(s=>s.bars.map(b=>b.t)))].sort((a,b)=>a-b);
function sim(cap){
 const idx=syms.map(()=>0), pos=syms.map(()=>null); let open=0;
 let eqG=200,eqN=200,peakN=200,ddN=0,n=0,wins=0;
 const tsMap=syms.map(s=>{const m=new Map();s.bars.forEach((b,i)=>m.set(b.t,i));return m;});
 for(const t of timeline){
  for(let s=0;s<syms.length;s++){const i=tsMap[s].get(t);if(i===undefined)continue;
   const d=decideStep({bars:syms[s].bars,i,position:pos[s],params:P});
   if(d.action==='open'){ if(open<cap){pos[s]={initialStop:d.initialStop,dir:d.dir,entry:d.entry,atrAtEntry:d.atrAtEntry,hwm:d.entry,lwm:d.entry};open++;} }
   else if(d.action==='hold'&&pos[s]){pos[s].hwm=d.hwm;pos[s].lwm=d.lwm;}
   else if(d.action==='close'&&pos[s]){const p=pos[s];const risk=P.atrMult*p.atrAtEntry;
    const gR=(p.dir==='long'?d.exit-p.entry:p.entry-d.exit)/risk;
    const nR=gR-2*(p.entry*TAKER)/risk-2*(p.entry*SLIP)/risk;
    eqG*=(1+RISK*gR); eqN*=(1+RISK*nR); if(eqN>peakN)peakN=eqN;const dd=(peakN-eqN)/peakN;if(dd>ddN)ddN=dd;
    n++; if(nR>0)wins++; pos[s]=null; open--;}
  }}
 return {cap,n,win:(wins/n*100),eqG,eqN,ddN:ddN*100};
}
console.log('PORTFOLIO position cap · 25 symbols · 4h trend-trail · real MEXC fees · 0.5% risk/pos · gross|net\n');
console.log('cap   trades  win%  GROSS$   NET$    netDD%');
for(const cap of [99,10,6,4,3,2]){const r=sim(cap);
 console.log(`${String(r.cap==99?'∞':r.cap).padEnd(5)} ${String(r.n).padEnd(6)}  ${r.win.toFixed(0).padStart(3)}%  $${r.eqG.toFixed(0).padEnd(6)} $${r.eqN.toFixed(0).padEnd(6)} ${r.ddN.toFixed(0)}%`);}
