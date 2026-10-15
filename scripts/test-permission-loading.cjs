'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function load(query){
  let now=100000;
  const context=vm.createContext({require:()=>({query}),module:{exports:{}},console:{error:()=>{}},Date:{now:()=>now},Map});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../utils/permissions.js'),'utf8'),context);
  return {permissions:context.module.exports,advance:ms=>{now+=ms;}};
}
const deny={role:'dispatcher',permission_key:'jobs.manage',allowed:false};
test('simultaneous checks await loaded overrides rather than reading an empty default cache',async()=>{
  let finish,calls=0;
  const {permissions:p}=load(async()=>{calls++;return new Promise(resolve=>{finish=resolve;});});
  let firstDone=false,secondDone=false;
  const a=p.hasPermission('dispatcher','jobs.manage').then(value=>{firstDone=true;return value;});
  const b=p.hasPermission('dispatcher','jobs.manage').then(value=>{secondDone=true;return value;});
  await Promise.resolve();assert.equal(firstDone,false);assert.equal(secondDone,false);assert.equal(calls,1);
  finish({rows:[deny]});assert.equal(await a,false);assert.equal(await b,false);
});
test('permission database errors never become cached default grants and can recover',async()=>{
  let fail=true,calls=0;
  const {permissions:p}=load(async()=>{calls++;if(fail)throw Error('database unavailable');return {rows:[deny]};});
  await assert.rejects(p.hasPermission('dispatcher','jobs.manage'),/unavailable/);
  fail=false;assert.equal(await p.hasPermission('dispatcher','jobs.manage'),false);assert.equal(calls,2);
});
test('an in-flight load invalidated by a permission save cannot republish stale grants',async()=>{
  let finish,calls=0;
  const {permissions:p}=load(async()=>{calls++;if(calls===1)return new Promise(resolve=>{finish=resolve;});return {rows:[deny]};});
  const old=p.hasPermission('dispatcher','jobs.manage');p.invalidate();
  finish({rows:[{...deny,allowed:true}]});assert.equal(await old,false);assert.equal(calls,2);
});
test('expired permission caches do not mask database failures',async()=>{
  let fail=false;
  const {permissions:p,advance}=load(async()=>{if(fail)throw Error('database unavailable');return {rows:[]};});
  assert.equal(await p.hasPermission('dispatcher','jobs.manage'),true);
  advance(30001);fail=true;await assert.rejects(p.hasPermission('dispatcher','jobs.manage'),/unavailable/);
});
test('middleware reports unavailable verification without allowing a request',async()=>{
  const {permissions:p}=load(async()=>{throw Error('sensitive internal database detail');});
  let next=false;const res={status(n){this.code=n;return this;},json(body){this.body=body;}};
  await p.requirePermission('jobs.manage')({user:{role:'dispatcher'}},res,()=>{next=true;});
  assert.equal(next,false);assert.equal(res.code,503);assert.doesNotMatch(res.body.error,/sensitive|database detail/);
});
