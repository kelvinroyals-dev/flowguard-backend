'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const adapter=require('../utils/weatherApi');
const HOUR=3600000,now=Date.parse('2026-10-15T14:30:00Z'),point={lat:6.43,lon:3.51};
function day(date,value=.1){
  const start=Date.parse(date+'T00:00:00+01:00');
  return {date,day:{totalprecip_mm:2.4,daily_chance_of_rain:30,condition:{text:'Light rain'}},hour:Array.from({length:24},(_,i)=>({time_epoch:(start+i*HOUR)/1000,precip_mm:value,chance_of_rain:30}))};
}
function fixtures(){return {forecast:{location:{...point,tz_id:'Africa/Lagos'},forecast:{forecastday:[day('2026-10-15'),day('2026-10-16'),day('2026-10-17')]}},history:{location:{...point,tz_id:'Africa/Lagos'},forecast:{forecastday:[day('2026-10-14')]}}};}
test('WAT completed-hour totals exclude the incomplete current hour',()=>{
  const {forecast,history}=fixtures();forecast.forecast.forecastday[0].hour[15].precip_mm=8;
  const result=adapter.parse(forecast,history,point,now);
  assert.equal(result.last24,2.4);assert.equal(result.latest,.1);assert.equal(result.prev24,null);
  assert.equal(result.windowEnd,'2026-10-15T14:00:00.000Z');assert.equal(result.forecast[0].start,result.windowEnd);
  assert.equal(result.forecast[0].v,8);assert.equal(result.next6,8.5);assert.equal(result.source,'WeatherAPI.com');
  assert.equal(result.daily.length,3);assert.equal(result.persistencePolicy,'memory_only');
});
test('missing, negative and truncated hours remain unknown; genuine zero is zero',()=>{
  const {forecast,history}=fixtures();history.forecast.forecastday[0].hour[20].precip_mm=null;
  let result=adapter.parse(forecast,history,point,now);assert.equal(result.last24,null);assert.equal(result.next6,.6);
  result=adapter.parse(forecast,null,point,now);assert.equal(result.last24,null);assert.equal(result.historyStatus,'unavailable');
  forecast.forecast.forecastday[0].hour[16].precip_mm=-1;
  result=adapter.parse(forecast,history,point,now);assert.equal(result.next6,null);
  const zero=fixtures();for(const data of Object.values(zero))for(const d of data.forecast.forecastday)for(const h of d.hour)h.precip_mm=0;
  result=adapter.parse(zero.forecast,zero.history,point,now);assert.equal(result.last24,0);assert.equal(result.next6,0);
});
test('rejects invalid locations/timezones and duplicate hours',()=>{
  const {forecast,history}=fixtures();forecast.location.lat=null;
  assert.throws(()=>adapter.parse(forecast,history,point,now),/location/);
  forecast.location.lat=point.lat;forecast.location.tz_id='Europe/London';
  assert.throws(()=>adapter.parse(forecast,history,point,now),/timezone/);
  forecast.location.tz_id='Africa/Lagos';forecast.forecast.forecastday[0].hour.push(forecast.forecast.forecastday[0].hour[0]);
  assert.throws(()=>adapter.parse(forecast,history,point,now),/Duplicate/);
});
test('only uses free-plan forecast/history requests; history failure preserves forecasts',async()=>{
  const seen=[],{forecast}=fixtures();
  const result=await adapter.request({point,now,key:'synthetic-key',fetcher:async raw=>{
    const url=new URL(raw);seen.push(url);assert.equal(url.origin,'https://api.weatherapi.com');assert.equal(url.searchParams.get('q'),'6.43,3.51');
    if(url.pathname.endsWith('/history.json'))return {ok:false,status:403};
    assert.equal(url.searchParams.get('days'),'3');assert.equal(url.searchParams.get('aqi'),'no');assert.equal(url.searchParams.get('alerts'),'no');
    return {ok:true,json:async()=>forecast};
  }});
  assert.equal(seen.length,2);assert.equal(seen[1].searchParams.get('dt'),'2026-10-14');
  assert.equal(result.last24,null);assert.equal(result.next6,.6);
  assert.equal(adapter.watDate(Date.parse('2026-10-14T23:30Z')),'2026-10-15');
});
test('never includes keys in errors and does not fetch without configuration',async()=>{
  const key='synthetic-private-key';let calls=0;
  await assert.rejects(adapter.request({point,now,key:'',fetcher:async()=>calls++}),/not configured/);assert.equal(calls,0);
  await assert.rejects(adapter.request({point,now,key,fetcher:async()=>{throw Error('https://example.invalid/?key='+key);}}),error=>!error.message.includes(key));
});
test('shared service coalesces, caches and never persists WeatherAPI mixed payloads',async()=>{
  let calls=0,writes=0,queries=0;const fixture=fixtures();
  const env={NODE_ENV:'production',WEATHER_PROVIDER:'weatherapi',WEATHERAPI_API_KEY:'synthetic-key'};
  const context=vm.createContext({module:{exports:{}},process:{env},Date,Map,URL,URLSearchParams,AbortController,setTimeout,clearTimeout,fetch:async()=>{throw Error('Unexpected default fetch');},require:name=>name==='./weatherApi'?adapter:{query:async()=>{queries++;return {rows:[]};}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../utils/estateWeather.js'),'utf8'),context);
  const w=context.module.exports,service=w.createService({env,clock:()=>now,store:async()=>writes++,fetcher:async raw=>{
    calls++;return {ok:true,json:async()=>new URL(raw).pathname.endsWith('/history.json')?fixture.history:fixture.forecast};
  }});
  await Promise.all([service.load({latitude:point.lat,longitude:point.lon}),service.load({latitude:point.lat,longitude:point.lon})]);
  await service.load({latitude:point.lat,longitude:point.lon});
  assert.equal(calls,2);assert.equal(writes,0);assert.equal(service.provider(),'weatherapi');
  await w.forEstates([{property_id:'p',latitude:point.lat,longitude:point.lon}]);assert.equal(queries,0,'must not mix archived Open-Meteo data into WeatherAPI');
});
