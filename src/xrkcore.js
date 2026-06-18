// ===== XRK core: pure parse + analysis (no DOM). Usable in node and browser. =====
(function(root){
'use strict';
const NG=600;

// ---- byte helpers ----
function findAll(buf,pat){const res=[],n=buf.length,m=pat.length,p0=pat[0];
  for(let i=0;i+m<=n;i++){if(buf[i]===p0){let ok=true;for(let j=1;j<m;j++){if(buf[i+j]!==pat[j]){ok=false;break;}}if(ok)res.push(i);}}return res;}
function findFirst(buf,pat){const n=buf.length,m=pat.length,p0=pat[0];
  for(let i=0;i+m<=n;i++){if(buf[i]===p0){let ok=true;for(let j=1;j<m;j++){if(buf[i+j]!==pat[j]){ok=false;break;}}if(ok)return i;}}return -1;}
function bytesOf(s){return Array.from(s).map(c=>c.charCodeAt(0));}

// ---- math helpers ----
const mean=a=>a.reduce((x,y)=>x+y,0)/a.length;
function std(a){if(a.length<2)return 0;const m=mean(a);return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1));}
function median(a){const b=a.slice().sort((x,y)=>x-y),n=b.length;return n%2?b[(n-1)/2]:(b[n/2-1]+b[n/2])/2;}
function percentile(a,p){const b=a.slice().sort((x,y)=>x-y);if(b.length===1)return b[0];const idx=(p/100)*(b.length-1),lo=Math.floor(idx),hi=Math.ceil(idx);return b[lo]+(b[hi]-b[lo])*(idx-lo);}
function smooth(a,k){if(k<=1)return a.slice();const n=a.length,out=new Array(n),h=Math.floor(k/2);
  for(let i=0;i<n;i++){let s=0,c=0;for(let j=-h;j<=h;j++){const t=i+j;if(t>=0&&t<n){s+=a[t];c++;}}out[i]=s/c;}return out;}
function gradient(a){const n=a.length,g=new Array(n);if(n<2){return a.map(()=>0);}
  g[0]=a[1]-a[0];g[n-1]=a[n-1]-a[n-2];for(let i=1;i<n-1;i++)g[i]=(a[i+1]-a[i-1])/2;return g;}
function unwrap(a){const out=a.slice();let off=0;for(let i=1;i<a.length;i++){let d=a[i]-a[i-1];if(d>Math.PI)off-=2*Math.PI;else if(d<-Math.PI)off+=2*Math.PI;out[i]=a[i]+off;}return out;}
function interp(xq,xp,fp){ // xp ascending
  const out=new Array(xq.length);let j=0;
  for(let q=0;q<xq.length;q++){const x=xq[q];
    while(j<xp.length-2 && xp[j+1]<x)j++;
    let x0=xp[j],x1=xp[j+1],y0=fp[j],y1=fp[j+1];
    if(x1===x0)out[q]=y0;else out[q]=y0+(y1-y0)*(x-x0)/(x1-x0);
    if(x<=xp[0])out[q]=fp[0];if(x>=xp[xp.length-1])out[q]=fp[fp.length-1];
  }return out;}

// ---- ECEF -> geodetic not needed; we use ENU with shared origin ----

// ---- parse one file ----
function parseXRK(u8){
  const dv=new DataView(u8.buffer,u8.byteOffset,u8.byteLength);
  const GPSPAT=bytesOf("<hGPS").concat([0x00,0x38,0x00,0x00,0x00,0x01,0x3e]);
  const gpsHits=findAll(u8,GPSPAT);
  const gps=new Array(gpsHits.length);
  for(let k=0;k<gpsHits.length;k++){const b=gpsHits[k]+GPSPAT.length;
    gps[k]={mc:dv.getInt32(b,true),itow:dv.getInt32(b+4,true),
            X:dv.getInt32(b+16,true)/100,Y:dv.getInt32(b+20,true)/100,Z:dv.getInt32(b+24,true)/100};}
  const LAPPAT=bytesOf("<hLAP");
  const lapHits=findAll(u8,LAPPAT);
  const laps=[];
  for(const p of lapHits){const base=p+12;
    laps.push({num:dv.getUint16(base+2,true),dur:dv.getUint32(base+4,true)/1000,start:dv.getUint32(base+16,true)});}
  function meta(tag){const pat=bytesOf("<h"+tag).concat([0x00]);const i=findFirst(u8,pat);if(i<0)return null;
    const lenOff=i+pat.length;const len=dv.getUint32(lenOff,true);const start=lenOff+6;
    let s='';for(let j=0;j<len;j++){const c=u8[start+j];if(c===0)break;s+=String.fromCharCode(c);}return s;}
  return {gps,laps,date:meta("TMD"),time:meta("TMT"),device:meta("NDV"),
          vehicle:meta("VEH"),racer:meta("RCR"),champ:meta("CMP")};
}

// ---- ENU projection given shared origin ----
function makeENU(originXYZ){
  const [x0,y0,z0]=originXYZ;
  const lat0=Math.atan2(z0,Math.hypot(x0,y0)),lon0=Math.atan2(y0,x0);
  const sl=Math.sin(lat0),cl=Math.cos(lat0),so=Math.sin(lon0),co=Math.cos(lon0);
  return (X,Y,Z)=>{const dx=X-x0,dy=Y-y0,dz=Z-z0;
    return [-so*dx+co*dy, -sl*co*dx-sl*so*dy+cl*dz];};
}

// ---- corner detection on ref speed (circular, prominence-ish) ----
function detectCorners(v){const n=v.length,W=14,prom=3,maxv=Math.max.apply(null,v);
  const at=i=>v[((i%n)+n)%n];const cand=[];
  for(let i=0;i<n;i++){let isMin=true,lo=at(i);
    for(let k=-W;k<=W;k++){if(at(i+k)<lo-1e-9){isMin=false;break;}}
    if(!isMin)continue;let lmax=lo;for(let k=1;k<=2*W;k++){lmax=Math.max(lmax,at(i-k));if(at(i-k)<lo)break;}
    let rmax=lo;for(let k=1;k<=2*W;k++){rmax=Math.max(rmax,at(i+k));if(at(i+k)<lo)break;}
    if(Math.min(lmax,rmax)-lo>=prom && lo<maxv*0.985)cand.push(i);}
  // dedupe within W keeping lowest
  cand.sort((a,b)=>a-b);const apex=[];
  for(const i of cand){if(!apex.length||i-apex[apex.length-1]>W)apex.push(i);
    else if(at(i)<at(apex[apex.length-1]))apex[apex.length-1]=i;}
  return apex;
}

// ---- build full dataset from parsed files + driver map ----
// parsedList: [{code, parsed}]  driverMap: {code: "Driver X"}
function buildDataset(parsedList, driverMap){
  // shared origin from first file with gps
  const first=parsedList.find(p=>p.parsed.gps.length);
  if(!first) throw new Error("No GPS data found in any file.");
  const g0=first.parsed.gps;let sx=0,sy=0,sz=0;for(const s of g0){sx+=s.X;sy+=s.Y;sz+=s.Z;}
  const enu=makeENU([sx/g0.length,sy/g0.length,sz/g0.length]);
  const order=parsedList.map(p=>p.code);
  const allLaps=[];
  for(const {code,parsed} of parsedList){
    const G=parsed.gps;if(!G.length||!parsed.laps.length)continue;
    const mc=G.map(s=>s.mc);const EN=G.map(s=>enu(s.X,s.Y,s.Z));
    const E=EN.map(p=>p[0]),N=EN.map(p=>p[1]);
    let dt=[];for(let i=0;i<mc.length-1;i++)dt.push((mc[i+1]-mc[i])/1000);dt.push(dt[dt.length-1]||0.1);
    dt=dt.map(x=>x<=0?0.1:x);
    const gE=gradient(E),gN=gradient(N);
    const ds=E.map((_,i)=>Math.hypot(gE[i],gN[i]));
    let v=smooth(ds.map((d,i)=>d/dt[i]),7);
    const headRaw=unwrap(N.map((_,i)=>Math.atan2(gN[i],gE[i])));
    const longg=smooth(gradient(v).map((g,i)=>g/dt[i]),9).map(x=>x/9.81);
    const yaw=smooth(gradient(headRaw).map((g,i)=>g/dt[i]),9);
    const latg=v.map((vv,i)=>vv*yaw[i]/9.81);
    const laps=parsed.laps;
    for(let li=0;li<laps.length;li++){
      const lo = li===0 ? mc[0]-1 : laps[li-1].start;
      const hi = laps[li].start;
      const idx=[];for(let i=0;i<mc.length;i++){if(mc[i]>lo&&mc[i]<=hi)idx.push(i);}
      if(idx.length<20)continue;
      const eE=idx.map(i=>E[i]),eN=idx.map(i=>N[i]),ev=idx.map(i=>v[i]),
            elg=idx.map(i=>longg[i]),etg=idx.map(i=>latg[i]),emc=idx.map(i=>mc[i]);
      const cd=[0];for(let i=1;i<eE.length;i++)cd.push(cd[i-1]+Math.hypot(eE[i]-eE[i-1],eN[i]-eN[i-1]));
      const L=cd[cd.length-1];const geo_ok=L>2000&&L<4500;
      const t=emc.map(m=>(m-emc[0])/1000);
      const frac=cd.map(d=>L>0?d/L:0);
      const grid=[];for(let i=0;i<NG;i++)grid.push(i/(NG-1));
      const rs=arr=>interp(grid,frac,arr);
      allLaps.push({code,driver:driverMap[code],num:laps[li].num,dur:laps[li].dur,L,geo_ok,
        gv:rs(ev).map(x=>x*2.236936),glg:rs(elg),gtg:rs(etg),gE:rs(eE),gN:rs(eN),gt:rs(t)});
    }
  }
  if(!allLaps.length) throw new Error("No valid laps with telemetry found.");
  // classify green per code
  const byCode={};allLaps.forEach(l=>{(byCode[l.code]=byCode[l.code]||[]).push(l);});
  for(const c in byCode){const med=median(byCode[c].map(l=>l.dur));
    byCode[c].forEach(l=>l.green=l.dur<med+18&&l.dur<140&&l.geo_ok);}
  const green=allLaps.filter(l=>l.green).sort((a,b)=>a.dur-b.dur);
  if(!green.length) throw new Error("No clean (green) laps found.");
  const ref=green[0];
  // segments
  const apex=detectCorners(ref.gv);
  let mids=[];for(let i=0;i<apex.length-1;i++)mids.push((apex[i]+apex[i+1])/2/NG);
  let bnds=[0].concat(mids).concat([1]);let segments=[];
  for(let i=0;i<bnds.length-1;i++){let a=bnds[i],b=bnds[i+1];
    if(b-a>0.14){const k=Math.floor((b-a)/0.10)+1;for(let j=0;j<k;j++)segments.push([a+(b-a)*j/k,a+(b-a)*(j+1)/k]);}
    else segments.push([a,b]);}
  const NS=segments.length;
  const gridx=[];for(let i=0;i<NG;i++)gridx.push(i/(NG-1));
  allLaps.forEach(l=>{const total=l.gt[NG-1],scale=total>0?l.dur/total:1;
    l.seg=segments.map(([a,b])=>(interp([b],gridx,l.gt)[0]-interp([a],gridx,l.gt)[0])*scale);});
  // distance array from ref path
  const distm=[0];for(let i=1;i<NG;i++)distm.push(distm[i-1]+Math.hypot(ref.gE[i]-ref.gE[i-1],ref.gN[i]-ref.gN[i-1]));
  // order + best5
  order.sort();const ordU=parsedList.map(p=>p.code);
  allLaps.sort((a,b)=>ordU.indexOf(a.code)-ordU.indexOf(b.code)||a.num-b.num);
  const best5=new Set(green.slice(0,5));
  const laps_json=allLaps.map((l,i)=>({id:i,code:l.code,driver:l.driver,num:l.num,t:+l.dur.toFixed(3),
    green:!!l.green,best5:best5.has(l),seg:l.seg.map(x=>+x.toFixed(3)),
    v:l.gv.map(x=>+x.toFixed(1)),lng:l.glg.map(x=>+x.toFixed(2)),lat:l.gtg.map(x=>+x.toFixed(2)),
    x:l.gE.map(x=>+x.toFixed(1)),y:l.gN.map(x=>+x.toFixed(1)),ct:l.gt.map((x,j)=>+( (l.dur/(l.gt[NG-1]||1))*x ).toFixed(2))}));
  const seg_centers=segments.map(([a,b])=>[+interp([(a+b)/2],gridx,ref.gE)[0].toFixed(1),+interp([(a+b)/2],gridx,ref.gN)[0].toFixed(1)]);
  const driversU=[...new Set(parsedList.map(p=>driverMap[p.code]))];
  const DATA={track:first.parsed.device||"Track",date:first.parsed.date||"",
    drivers:driverMap,order:ordU,driversList:driversU,dist:distm.map(x=>+x.toFixed(1)),
    refpath:ref.gE.map((x,i)=>[+x.toFixed(1),+ref.gN[i].toFixed(1)]),
    segments:segments.map(s=>[+s[0].toFixed(4),+s[1].toFixed(4)]),seg_centers,ngrid:NG,laps:laps_json};
  // STATS
  function pstat(d){return {n:d.length,mean:mean(d),med:median(d),best:Math.min.apply(null,d),
    std:std(d),p95:percentile(d,95),p99:percentile(d,99),cv:d.length>1?std(d)/mean(d)*100:0};}
  const groups={};allLaps.forEach(l=>{const g=groups[l.driver]=groups[l.driver]||{green:[],all:[]};g.all.push(l.dur);if(l.green)g.green.push(l.dur);});
  const segBest=new Array(NS).fill(1e9),segWho=new Array(NS).fill('');
  const dsb={},dsl={};driversU.forEach(d=>{dsb[d]=new Array(NS).fill(1e9);dsl[d]=Array.from({length:NS},()=>[]);});
  allLaps.forEach(l=>{if(!l.green)return;for(let s=0;s<NS;s++){const t=l.seg[s];dsl[l.driver][s].push(t);
    if(t<dsb[l.driver][s])dsb[l.driver][s]=t;if(t<segBest[s]){segBest[s]=t;segWho[s]=l.driver;}}});
  const STATS={ideal:segBest.reduce((a,b)=>a+b,0),ref:{t:ref.dur,driver:ref.driver},NS,
    seg_best:segBest,seg_who:segWho,drv_seg_best:dsb,
    drv_seg_mean:{},drivers:{}};
  driversU.forEach(d=>{STATS.drv_seg_mean[d]=dsl[d].map(a=>a.length?mean(a):null);
    const s=pstat(groups[d].green);STATS.drivers[d]={n:s.n,best:s.best,mean:s.mean,med:s.med,std:s.std,cv:s.cv,
      p95:s.p95,p99:s.p99,caution:groups[d].all.length-s.n,theo:dsb[d].reduce((a,b)=>a+b,0)};});
  return {DATA,STATS,driversU};
}

const api={parseXRK,buildDataset,NG};
if(typeof module!=='undefined'&&module.exports)module.exports=api;
root.XRKCORE=api;
})(typeof window!=='undefined'?window:globalThis);
