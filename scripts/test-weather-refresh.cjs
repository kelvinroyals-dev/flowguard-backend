const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
test('refresh deduplicates coordinates, bounds concurrency and skips overlapping runs',async()=>{
 let active=0,max=0,queries=0;const calls=[],pending=[];
 const records=[{latitude:'6.400',longitude:'3.500'},{latitude:6.4,longitude:3.5},...Array.from({length:6},(_,i)=>({latitude:8+i,longitude:7})),{latitude:null,longitude:4}];
 const weather={location:r=>r.latitude==null?null:{lat:Number(r.latitude),lon:Number(r.longitude)},load:r=>{
  calls.push(r);active++;max=Math.max(max,active);
  return new Promise(resolve=>pending.push(()=>{active--;resolve();}));
 }};
 const context=vm.createContext({require:n=>n==='../config/database'?{query:async()=>{queries++;return {rows:records};}}:weather,module:{exports:{}},process:{env:{}},console,setInterval,clearInterval,Map,Promise});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../utils/weatherRefresh.js'),'utf8'),context);
 const worker=context.module.exports;worker.start();assert.equal(queries,0,'refresh is opt-in');
 const tick=()=>new Promise(resolve=>setImmediate(resolve));
 const run=worker.refresh();await tick();assert.equal(calls.length,4);
 assert.equal((await worker.refresh()).skipped,true);
 while(pending.length){pending.shift()();await tick();}
 const result=await run;assert.equal(result.total,7);assert.equal(result.available,7);assert.equal(result.failed,0);assert.equal(max,4);assert.equal(queries,1);
});
