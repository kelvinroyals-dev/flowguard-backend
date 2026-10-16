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
const distance=(a,b)=>{const rad=v=>v*Math.PI/180,x=Math.sin(rad(a.lat-b.lat)/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(rad(a.lon-b.lon)/2)**2;return 6371*2*Math.atan2(Math.sqrt(x),Math.sqrt(Math.max(0,1-x)));};
function parse(forecast,history,point,now,historyFailure=null){
  const grid={lat:forecast.location?.lat,lon:forecast.location?.lon};
  if(!validPoint(point)||!validPoint(grid)||forecast.location?.tz_id!=='Africa/Lagos')throw Error('Invalid weather location or timezone');
  if(!Array.isArray(forecast.forecast?.forecastday)||!forecast.forecast.forecastday.length)throw Error('Weather forecast was not supplied');
  const boundary=Math.floor(now/HOUR)*HOUR;
  const hours=new Map();
  function ingest(days,target,source){
    for(const day of days||[]){
      if(!Array.isArray(day.hour))continue;
      for(const h of day.hour){
        const stamp=typeof h.time_epoch==='number'?h.time_epoch*1000:NaN;
        if(!Number.isFinite(stamp)||stamp%HOUR!==0)throw Error('Invalid weather hour timestamp');
        if(watDate(stamp)!==day.date)throw Error('Weather hour does not match its calendar date');
        if(target.has(stamp))throw Error('Duplicate weather hour');
        target.set(stamp,{start:stamp,v:mm(h.precip_mm),prob:probability(h.chance_of_rain),source});
      }
    }
  }
  const today=watDate(now);
  const forecastDays=forecast.forecast.forecastday.filter(d=>typeof d.date==='string'&&d.date>=today&&d.date<=watDate(now+48*HOUR)).slice(0,3);
  ingest(forecastDays,hours,'forecast');
  const yesterday=watDate(now-24*HOUR);
  let archive=null,historyReason=historyFailure;
  const historicalHours=new Map();
  const totalFrom=(map,start,count)=>{
    let sum=0;
    for(let i=0;i<count;i++){const value=map.get(start+i*HOUR)?.v;if(mm(value)===null)return null;sum+=value;}
    return Number(sum.toFixed(3));
  };
  const toHour=(map,start,future)=>{const h=map.get(start);return {t:new Date(start+HOUR).toISOString(),start:new Date(start).toISOString(),v:h?.v??null,prob:h?.prob??null,source:h?.source??null,future};};
  if(history){
    try{
      const historyGrid={lat:history.location?.lat,lon:history.location?.lon};
      if(!validPoint(historyGrid)||history.location?.tz_id!=='Africa/Lagos')throw Error('Invalid history location');
      const days=(history.forecast?.forecastday||[]).filter(d=>d.date===yesterday);
      if(days.length!==1)throw Error('History date missing');
      ingest(days,historicalHours,'archive');
      const start=Date.parse(yesterday+'T00:00:00+01:00');
      const series=Array.from({length:24},(_,i)=>toHour(historicalHours,start+i*HOUR,false));
      const available=series.filter(h=>h.v!==null).length;
      archive={date:yesterday,grid:historyGrid,gridDistanceKm:distance(historyGrid,point),total:totalFrom(historicalHours,start,24),providerDailyTotal:mm(days[0].day?.totalprecip_mm),hrs:series,available,expected:24};
      historyReason=available===24?null:{code:'incomplete_history',message:'Some historical hours are missing or invalid.'};
    }catch(_){historyReason={code:'invalid_history',message:'Historical response has invalid location, date or hour data.'};}
  }
  if(!archive&&!historyReason)historyReason={code:'history_unavailable',message:'The provider has not supplied historical hours.'};
  const sameLocation=archive&&archive.grid.lat===grid.lat&&archive.grid.lon===grid.lon;
  // Separate valid history is useful even if the provider chose a different
  // matched location. Never mix those cells into a continuous rolling total.
  if(sameLocation)for(const [stamp,h] of historicalHours)if(stamp<boundary&&!hours.has(stamp))hours.set(stamp,h);
  const total=(start,count)=>totalFrom(hours,start,count);
  const past=Array.from({length:24},(_,i)=>toHour(hours,boundary-(24-i)*HOUR,false));
  // Keep explicit nulls for gaps. Never stretch fewer provider hours to a
  // longer requested horizon or turn a missing hour into zero.
  const lastForecast=Math.max(...[...hours.keys()].filter(t=>t>=boundary));
  if(!Number.isFinite(lastForecast))throw Error('Weather forecast coverage is out of date');
  const future=Array.from({length:Math.min(72,Math.floor((lastForecast-boundary)/HOUR)+1)},(_,i)=>toHour(hours,boundary+i*HOUR,true));
  const pastAvailable=past.filter(h=>h.v!==null).length,forecastAvailable=future.slice(0,6).filter(h=>h.v!==null).length;
  const rollingReason=archive&&!sameLocation?{code:'different_provider_locations',message:'History and forecast use different provider locations; their hours are not combined.'}:pastAvailable<24?historyReason||{code:'incomplete_history',message:'The rolling 24-hour window is incomplete.'}:null;
  const daily=forecastDays.map(day=>({date:day.date,mm:mm(day.day?.totalprecip_mm),prob:probability(day.day?.daily_chance_of_rain),code:null,condition:typeof day.day?.condition?.text==='string'?day.day.condition.text:null}));
  return {source:'WeatherAPI.com',provider:'weatherapi',sourceKind:'model_estimate',units:'mm',point,grid,
    gridDistanceKm:distance(grid,point),fetchedAt:new Date(now).toISOString(),windowEnd:new Date(boundary).toISOString(),
    last24:total(boundary-24*HOUR,24),prev24:null,latest:hours.get(boundary-HOUR)?.v??null,next6:total(boundary,6),
    hrs:past.concat(future.slice(0,6)),forecast:future,daily,forecastDays:daily.length,historyAvailable:false,
    history:archive,historyFailure:historyReason,historyLocationMatchesForecast:Boolean(sameLocation),rolling24Reason:rollingReason,
    coverage:{past24:{available:pastAvailable,expected:24},forecast6:{available:forecastAvailable,expected:6}},
    historyStatus:archive?'provider_archive':'unavailable',persistencePolicy:'memory_only',modelRun:null};
}
async function request({fetcher,key,point,now,signal}){
  if(typeof key!=='string'||!key.trim())throw Error('WeatherAPI.com key is not configured');
  async function get(method,params){
    const url=new URL('https://api.weatherapi.com/v1/'+method+'.json');
    url.search=new URLSearchParams({key,q:point.lat+','+point.lon,...params}).toString();
    let response;
    try{response=await fetcher(url.href,{signal,redirect:'error'});}catch(_){throw Error('WeatherAPI.com connection unavailable');}
    if(!response.ok){const error=Error('WeatherAPI.com request rejected (HTTP '+response.status+').');error.code='http_'+response.status;error.status=response.status;throw error;}
    let data;try{data=await response.json();}catch(_){throw Error('WeatherAPI.com returned an unreadable response');}
    if(data.error)throw Error('WeatherAPI.com request unavailable');
    return data;
  }
  const forecast=await get('forecast',{days:'3',aqi:'no',alerts:'no'});
  let history=null,historyFailure=null;
  try{history=await get('history',{dt:watDate(now-24*HOUR)});}catch(error){
    historyFailure={code:error.code||(signal?.aborted?'timeout':'history_request_failed'),message:error.status?'The provider rejected historical data (HTTP '+error.status+').':'The historical weather request failed or timed out.',...(error.status?{status:error.status}:{})};
  }
  return parse(forecast,history,point,now,historyFailure);
}
module.exports={parse,request,watDate};
