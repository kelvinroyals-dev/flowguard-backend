'use strict';
const pool=require('../config/database'),weather=require('./estateWeather');
let running=false,timer=null;
async function refresh(){
 if(running)return {skipped:true};running=true;
 try{
  const {rows}=await pool.query("SELECT property_id,latitude,longitude FROM properties WHERE parent_property_id IS NULL AND latitude IS NOT NULL AND longitude IS NOT NULL");
  const unique=[...new Map(rows.filter(r=>weather.location(r)).map(r=>{const p=weather.location(r);return [p.lat+','+p.lon,r];})).values()];let index=0,available=0,failed=0;
  await Promise.all(Array.from({length:4},async()=>{while(index<unique.length){const record=unique[index++];try{await weather.load(record);available++;}catch(_){failed++;}}}));
  return {available,failed,total:unique.length};
 }finally{running=false;}
}
function start(){
 if(process.env.WEATHER_REFRESH_ENABLED!=='true'||timer)return;
 const run=()=>refresh().then(s=>console.log('[weather refresh]',s)).catch(()=>console.error('[weather refresh] unavailable'));
 run();timer=setInterval(run,300000);timer.unref?.();
}
function stop(){if(timer)clearInterval(timer);timer=null;}
module.exports={refresh,start,stop};
