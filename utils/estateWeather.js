'use strict';
// Shared estate-coordinate weather adapter. No regional coordinate fallback.
const pool=require('../config/database');
const valid=v=>v!=null&&typeof v!=='boolean'&&String(v).trim()!==''&&Number.isFinite(Number(v));
function location(r){return valid(r?.latitude)&&valid(r?.longitude)&&Math.abs(Number(r.latitude))<=90&&Math.abs(Number(r.longitude))<=180?{lat:Number(r.latitude),lon:Number(r.longitude)}:null;}
const time=v=>typeof v==='string'?Date.parse(/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/.test(v)?v+'+01:00':v):NaN;
const number=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
function parse(j,point,now){
 const times=j.hourly?.time,values=j.hourly?.precipitation;
 if(j.hourly_units?.precipitation!=='mm'||!Array.isArray(times)||!Array.isArray(values)||times.length!==values.length||!times.length)throw Error('Invalid weather series or units');
 const stamps=times.map(time);if(stamps.some((t,i)=>!Number.isFinite(t)||i&&t-stamps[i-1]!==3600000))throw Error('Invalid hourly coverage');
 const end=stamps.filter(t=>t<=now).length;if(!end||now-stamps[end-1]>=3600000)throw Error('Stale weather coverage');
 const total=(a,b)=>a<0||values.slice(a,b).length!==b-a||values.slice(a,b).some(v=>number(v)===null)?null:Number(values.slice(a,b).reduce((s,v)=>s+v,0).toFixed(3));
 const grid=location(j);if(!grid)throw Error('Weather grid not supplied');
 const rad=v=>v*Math.PI/180,a=Math.sin(rad(grid.lat-point.lat)/2)**2+Math.cos(rad(point.lat))*Math.cos(rad(grid.lat))*Math.sin(rad(grid.lon-point.lon)/2)**2;
 const all=stamps.map((t,i)=>({t:new Date(t).toISOString(),v:number(values[i]),future:i>=end}));
 return {source:'Open-Meteo',sourceKind:'model_estimate',units:'mm',point,grid,gridDistanceKm:6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(Math.max(0,1-a))),fetchedAt:new Date(now).toISOString(),windowEnd:new Date(stamps[end-1]).toISOString(),last24:total(end-24,end),prev24:total(end-48,end-24),latest:number(values[end-1]),next6:total(end,end+6),hrs:all.slice(Math.max(0,end-24),end+6),forecast:all.slice(end),modelRun:null};
}
function createService({fetcher=(...args)=>fetch(...args),clock=Date.now,store=null,env=process.env}={}){
 const cache=new Map(),pending=new Map(),waiters=[];let active=0;
 async function acquire(){if(active>=4)await new Promise(resolve=>waiters.push(resolve));else active++;}
 function release(){const next=waiters.shift();if(next)next();else active--;}
 async function load(record){
  const point=location(record);if(!point)throw Error('Estate coordinates unavailable');
  if(env.NODE_ENV==='production'&&!env.OPEN_METEO_API_KEY)throw Error('Commercial weather provider is not configured');
  const key=point.lat+','+point.lon,cached=cache.get(key);
  if(cached&&clock()-cached.saved>=0&&clock()-cached.saved<300000&&clock()-Date.parse(cached.value.windowEnd)>=0&&clock()-Date.parse(cached.value.windowEnd)<3600000)return cached.value;
  if(pending.has(key))return pending.get(key);
  if(waiters.length>=1000)throw Error('Weather service busy');
  const task=(async()=>{
   await acquire();const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
   try{
    const host=env.OPEN_METEO_API_KEY?'https://customer-api.open-meteo.com':'https://api.open-meteo.com';
    const url=new URL(host+'/v1/forecast');url.search=new URLSearchParams({latitude:point.lat,longitude:point.lon,hourly:'precipitation',precipitation_unit:'mm',past_hours:'48',forecast_hours:'73',timezone:'Africa/Lagos',cell_selection:'nearest',...(env.OPEN_METEO_API_KEY?{apikey:env.OPEN_METEO_API_KEY}:{})}).toString();
    const r=await fetcher(url.href,{signal:controller.signal});if(!r.ok)throw Error('Weather provider unavailable');
    const value=parse(await r.json(),point,clock());value.historyAvailable=false;
    if(store){try{await store(key,value);value.historyAvailable=true;}catch(_){/* Explicit historyAvailable=false, no false persistence claim. */}}
    cache.set(key,{saved:clock(),value});if(cache.size>500)cache.delete(cache.keys().next().value);return value;
   }finally{clearTimeout(timer);release();pending.delete(key);}
  })();pending.set(key,task);return task;
 }
 async function peek(record){
  const point=location(record);if(!point)return null;const key=point.lat+','+point.lon,hit=cache.get(key);
  const fresh=v=>v&&clock()-Date.parse(v.fetchedAt)>=0&&clock()-Date.parse(v.fetchedAt)<900000&&clock()-Date.parse(v.windowEnd)>=0&&clock()-Date.parse(v.windowEnd)<3600000;
  if(hit&&fresh(hit.value))return hit.value;
  return null;
 }
 return {load,peek};
}
const service=createService({store:async(key,value)=>{
 await pool.query('INSERT INTO weather_snapshots (coordinate_key,fetched_at,window_end,payload) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (coordinate_key,fetched_at) DO NOTHING',[key,value.fetchedAt,value.windowEnd,JSON.stringify({...value,historyAvailable:true})]);
}});
async function forEstates(records){
 const keys=records.map(r=>{const p=location(r);return p?p.lat+','+p.lon:null;}).filter(Boolean),byKey=new Map();
 try{const {rows}=await pool.query('SELECT DISTINCT ON (coordinate_key) coordinate_key,payload FROM weather_snapshots WHERE coordinate_key=ANY($1::text[]) AND fetched_at<=NOW() AND fetched_at>NOW()-INTERVAL \'15 minutes\' AND window_end<=NOW() AND window_end>NOW()-INTERVAL \'1 hour\' ORDER BY coordinate_key,fetched_at DESC',[keys]);for(const r of rows)byKey.set(r.coordinate_key,r.payload);}catch(_){/* Migration/history unavailable: cached values only; no network fan-out. */}
 const result=new Map();
 for(const r of records){const p=location(r),cached=await service.peek(r);result.set(String(r.property_id),cached||(p?byKey.get(p.lat+','+p.lon):null)||null);}
 return result;
}
async function window(record,start,end,snapshot){
 try{const wx=snapshot===undefined?await service.peek(record):snapshot;if(!wx||!Array.isArray(wx.forecast))return null;const hours=wx.forecast.slice(start,end);if(hours.length!==end-start||hours.some(h=>number(h.v)===null))return null;return hours.map(h=>({t:h.t,mm:h.v,prob:null}));}catch(_){return null;}
}
module.exports={...service,window,forEstates,location,parse,createService};
