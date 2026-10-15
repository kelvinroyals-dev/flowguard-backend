'use strict';
// WeatherAPI Free: yesterday's history + three calendar days of forecast.
// Hour entries represent an hour beginning at time_epoch. Completed-hour
// totals exclude the current unfinished hour. Historical data is archived
// model output, not a rain gauge at the estate.
const HOUR=3600000;
const mm=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
const probability=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=100?v:null;
const validPoint=p=>p&&typeof p.lat==='number'&&typeof p.lon==='number'&&Number.isFinite(p.lat)&&Number.isFinite(p.lon)&&Math.abs(p.lat)<=90&&Math.abs(p.lon)<=180;
const watDate=stamp=>new Date(stamp+HOUR).toISOString().slice(0,10);
function parse(forecast,history,point,now){
  const grid={lat:forecast.location?.lat,lon:forecast.location?.lon};
  if(!validPoint(point)||!validPoint(grid)||forecast.location?.tz_id!=='Africa/Lagos')throw Error('Invalid weather location or timezone');
  if(!Array.isArray(forecast.forecast?.forecastday)||!forecast.forecast.forecastday.length)throw Error('Weather forecast was not supplied');
  const boundary=Math.floor(now/HOUR)*HOUR;
  const hours=new Map();
  function ingest(days,archived){
    for(const day of days||[]){
      if(!Array.isArray(day.hour))continue;
      for(const h of day.hour){
        const stamp=typeof h.time_epoch==='number'?h.time_epoch*1000:NaN;
        if(!Number.isFinite(stamp)||stamp%HOUR!==0)throw Error('Invalid weather hour timestamp');
        if(archived&&stamp>=boundary)continue;
        if(hours.has(stamp))throw Error('Duplicate weather hour');
        hours.set(stamp,{start:stamp,v:mm(h.precip_mm),prob:probability(h.chance_of_rain)});
      }
    }
  }
  const today=watDate(now);
  const forecastDays=forecast.forecast.forecastday.filter(d=>typeof d.date==='string'&&d.date>=today&&d.date<=watDate(now+48*HOUR)).slice(0,3);
  ingest(forecastDays,false);
  const yesterday=watDate(now-24*HOUR);
  const historyAccepted=history?.location?.tz_id==='Africa/Lagos'&&history.location.lat===grid.lat&&history.location.lon===grid.lon;
  if(historyAccepted){
    ingest((history.forecast?.forecastday||[]).filter(d=>d.date===yesterday),true);
  }
  const total=(start,count)=>{
    let sum=0;
    for(let i=0;i<count;i++){const value=hours.get(start+i*HOUR)?.v;if(mm(value)===null)return null;sum+=value;}
    return Number(sum.toFixed(3));
  };
  const toHour=(start,future)=>{const h=hours.get(start);return {t:new Date(start+HOUR).toISOString(),start:new Date(start).toISOString(),v:h?.v??null,prob:h?.prob??null,future};};
  const past=Array.from({length:24},(_,i)=>toHour(boundary-(24-i)*HOUR,false));
  // Keep explicit nulls for gaps. Never stretch fewer provider hours to a
  // longer requested horizon or turn a missing hour into zero.
  const lastForecast=Math.max(...[...hours.keys()].filter(t=>t>=boundary));
  if(!Number.isFinite(lastForecast))throw Error('Weather forecast coverage is out of date');
  const future=Array.from({length:Math.min(72,Math.floor((lastForecast-boundary)/HOUR)+1)},(_,i)=>toHour(boundary+i*HOUR,true));
  const rad=v=>v*Math.PI/180,a=Math.sin(rad(grid.lat-point.lat)/2)**2+Math.cos(rad(point.lat))*Math.cos(rad(grid.lat))*Math.sin(rad(grid.lon-point.lon)/2)**2;
  const daily=forecastDays.map(day=>({date:day.date,mm:mm(day.day?.totalprecip_mm),prob:probability(day.day?.daily_chance_of_rain),code:null,condition:typeof day.day?.condition?.text==='string'?day.day.condition.text:null}));
  return {source:'WeatherAPI.com',provider:'weatherapi',sourceKind:'model_estimate',units:'mm',point,grid,
    gridDistanceKm:6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(Math.max(0,1-a))),fetchedAt:new Date(now).toISOString(),windowEnd:new Date(boundary).toISOString(),
    last24:total(boundary-24*HOUR,24),prev24:null,latest:hours.get(boundary-HOUR)?.v??null,next6:total(boundary,6),
    hrs:past.concat(future.slice(0,6)),forecast:future,daily,forecastDays:daily.length,historyAvailable:false,
    historyStatus:historyAccepted?'provider_archive':'unavailable',persistencePolicy:'memory_only',modelRun:null};
}
async function request({fetcher,key,point,now,signal}){
  if(typeof key!=='string'||!key.trim())throw Error('WeatherAPI.com key is not configured');
  async function get(method,params){
    const url=new URL('https://api.weatherapi.com/v1/'+method+'.json');
    url.search=new URLSearchParams({key,q:point.lat+','+point.lon,...params}).toString();
    let response;
    try{response=await fetcher(url.href,{signal,redirect:'error'});}catch(_){throw Error('WeatherAPI.com connection unavailable');}
    if(!response.ok)throw Error(response.status===401||response.status===403?'WeatherAPI.com key, free-plan access or quota unavailable':'WeatherAPI.com provider unavailable');
    let data;try{data=await response.json();}catch(_){throw Error('WeatherAPI.com returned an unreadable response');}
    if(data.error)throw Error('WeatherAPI.com request unavailable');
    return data;
  }
  const forecast=await get('forecast',{days:'3',aqi:'no',alerts:'no'});
  let history=null;
  try{history=await get('history',{dt:watDate(now-24*HOUR)});}catch(_){/* Forecast remains useful if free history is unavailable. */}
  return parse(forecast,history,point,now);
}
module.exports={parse,request,watDate};
