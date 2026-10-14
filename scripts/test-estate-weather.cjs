const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
const now=Date.parse('2026-10-13T14:30Z');
const fixture=(lat,lon)=>({latitude:lat,longitude:lon,hourly_units:{precipitation:'mm'},hourly:{time:Array.from({length:122},(_,i)=>new Date(Math.floor(now/3600000)*3600000+(i-48)*3600000).toISOString()),precipitation:Array(122).fill(.1)}});
test('weather adapter validates windows and isolates locations with bounded concurrency',async()=>{
 let calls=0,active=0,max=0;const pool={query:async(sql)=>{assert.match(sql,/fetched_at<=NOW\(\)/);assert.match(sql,/window_end<=NOW\(\)/);return {rows:[]};}};
 const c=vm.createContext({require:()=>pool,module:{exports:{}},process:{env:{}},Date,URL,URLSearchParams,AbortController,setTimeout,clearTimeout,Map,fetch:()=>{throw Error('Unexpected default fetch');}});
 vm.runInContext(read('utils/estateWeather.js'),c);const w=c.module.exports;
 const wx=w.parse(fixture(6.4,3.5),{lat:6.4,lon:3.5},now);assert.equal(wx.last24,2.4);assert.equal(wx.prev24,2.4);assert.equal(wx.next6,.6);
 const cold=await w.forEstates([{property_id:'cold',latitude:6.4,longitude:3.5}]);assert.equal(cold.get('cold'),null);assert.equal(await w.window({latitude:6.4,longitude:3.5},0,6,null),null);
 const j=fixture(6.4,3.5);j.hourly.precipitation[40]=null;assert.equal(w.parse(j,{lat:6.4,lon:3.5},now).last24,null);
 assert.throws(()=>w.parse({...j,hourly_units:{precipitation:'inch'}},{lat:6,lon:3},now),/units/);
 const service=w.createService({clock:()=>now,env:{},fetcher:async(url)=>{
  calls++;active++;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,2));active--;
  const u=new URL(url);assert.equal(u.searchParams.get('cell_selection'),'nearest');return {ok:true,json:async()=>fixture(+u.searchParams.get('latitude'),+u.searchParams.get('longitude'))};
 }});
 await assert.rejects(service.load({latitude:null,longitude:3}),/coordinates/);assert.equal(calls,0);
 await Promise.all([service.load({latitude:6,longitude:3}),service.load({latitude:6,longitude:3})]);assert.equal(calls,1);
 await service.load({latitude:6,longitude:3});assert.equal(calls,1);
 await Promise.all(Array.from({length:12},(_,i)=>service.load({latitude:7,longitude:i})));assert.ok(max<=4);
 const production=w.createService({env:{NODE_ENV:'production'}});await assert.rejects(production.load({latitude:6,longitude:3}),/Commercial/);
});
test('forecast inputs differ by estate; unknown locations and client subsets remain isolated',async()=>{
 const rows=[{property_id:'wet',name:'Wet',latitude:6,longitude:3,reporting_count:1,peak_level:40,avg_level:40,sensor_count:1},{property_id:'dry',name:'Dry',latitude:9,longitude:7,reporting_count:1,peak_level:40,avg_level:40,sensor_count:1},{property_id:'missing',name:'Missing',latitude:null,longitude:null}];
 const seen=[];const weather={window:async(e,a,b)=>{seen.push(e.property_id);return e.latitude==null?null:Array.from({length:b-a},(_,i)=>({t:new Date(now+i*3600000).toISOString(),mm:e.property_id==='wet'?10:0}));}};
 const c=vm.createContext({require:n=>({'../config/database':{query:async()=>({rows})},'./features':{computeFeatures:async()=>new Map()},'./estateWeather':weather}[n]),module:{exports:{}},Date,Map,Set,console});
 vm.runInContext(read('utils/riskForecast.js'),c);const r=c.module.exports;
 const full=await r.buildForecast(0,24),wet=full.estates.find(e=>e.property_id==='wet'),dry=full.estates.find(e=>e.property_id==='dry');
 assert.ok(wet.predicted_risk>dry.predicted_risk);assert.equal(full.estates.find(e=>e.property_id==='missing').predicted_risk,null);
 assert.equal(full.weather_coverage.available,2);assert.equal(full.weather_scope,'estate');assert.equal(full.weather_reference.property_id,'wet');
 const horizons=await r.buildHorizonForecast();assert.equal(horizons.weather_coverage.available,2);
 const scoped=r.scopeHorizonsToProperties(horizons,['missing']);assert.equal(scoped.estates.length,1);assert.equal(scoped.has_rainfall_data,false);assert.equal(scoped.weather_coverage.available,0);
 assert.equal(scoped.rain_next_3h_mm,null);assert.ok(seen.includes('wet')&&seen.includes('dry'));
});
test('estate read guard checks live roles, client permissions and organization ownership',async()=>{
 let current={id:2,user_type:'client',role:'client',account_owner_id:1,client_role:'member'},record={property_id:'p',user_id:1};
 const pool={query:async sql=>({rows:[sql.includes('FROM users')?current:record]})};
 const c=vm.createContext({require:n=>({'../config/database':pool,'./permissions':{hasPermission:async()=>false},'./clientPermissions':{clientCan:u=>u.client_role!=='finance'},'./roles':{normalizeRole:r=>r}}[n]),module:{exports:{}}});
 vm.runInContext(read('utils/propertyReadAccess.js'),c);const req={user:{id:2},params:{propertyId:'p'}},res={status(n){this.code=n;return this;},json(){return this;}};
 assert.equal((await c.module.exports.readProperty(req,res)).property_id,'p');
 record.user_id=99;assert.equal(await c.module.exports.readProperty(req,res),null);assert.equal(res.code,404);
 current.client_role='finance';assert.equal(await c.module.exports.readProperty(req,res),null);assert.equal(res.code,403);
 current={id:2,user_type:'service_provider',role:'service_provider'};assert.equal(await c.module.exports.readProperty(req,res),null);
});
