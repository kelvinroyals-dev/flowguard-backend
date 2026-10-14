// Registration state validation with a disposable in-memory query stub.
// No configured database, real credentials, email or notification delivery.
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const states=require('../utils/nigeriaStates');
function harness(){
 const handlers={},queries=[],router={post(p,...fn){handlers[p]=fn.at(-1);},get(){},use(){}};
 const client={release(){},query:async(sql,args=[])=>{queries.push({sql,args});if(sql.startsWith('SELECT id FROM users'))return {rows:[]};if(sql.includes('INSERT INTO service_provider_organisations'))return {rows:[{id:9,name:'Provider',status:'pending'}]};if(sql.includes('INSERT INTO users'))return {rows:[{id:1,email:'test@example.invalid',full_name:'Test',email_verified:true,role:'client',user_type:'client'}]};return {rows:[]};}};
 const mailer=new Proxy({},{get:()=>async()=>{}}),notify=()=>{};
 const context=vm.createContext({module:{exports:{}},process:{env:{JWT_SECRET:'test-only'}},console,require:name=>{
  if(name==='express')return {Router:()=>router};
  if(name==='bcryptjs')return {hash:async()=> 'not-a-real-hash'};
  if(name==='jsonwebtoken')return {sign:()=> 'not-a-real-token',verify:()=>({})};
  if(name==='crypto')return require('node:crypto');
  if(name==='../config/database')return {connect:async()=>client};
  if(name==='../utils/nigeriaStates')return states;
  if(name==='../utils/clientPermissions')return {clientRoleInfo:()=>({})};
  if(name==='../middleware/auth')return {authenticateToken(){}};
  if(name==='../utils/mailer')return mailer;
  if(name==='../utils/notify')return {notifyInternal:notify};
  throw Error('Unexpected import '+name);
 }});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../routes/auth.js'),'utf8'),context);
 return {queries,async register(body){const res={statusCode:200,status(code){this.statusCode=code;return this;},json(value){this.body=value;return this;}};await handlers['/register']({body:{fullName:'Test',email:'test@example.invalid',password:'test-only-123',...body}},res);return res;}};
}
test('canonical states are shared, stable, and reject misspellings',()=>{
 assert.equal(states.names.length,37);assert.equal(new Set(states.names).size,37);
 assert.equal(states.canonical(' lagos '),'Lagos');assert.equal(states.canonical('FCT'),'Federal Capital Territory');assert.equal(states.canonical('Abuja'),'Federal Capital Territory');assert.equal(states.canonical('Lagoss'),null);assert.equal(states.canonical({}),null);
 for(const file of ['../../operations/js/nigeria-states.js','../../client-portal/js/nigeria-states.js','../../../ClientPortal/flowguard-frontend/js/nigeria-states.js','../../../backend/utils/nigeriaStates.js'])assert.equal(fs.readFileSync(path.join(__dirname,file),'utf8'),fs.readFileSync(path.join(__dirname,'../utils/nigeriaStates.js'),'utf8'));
});
test('registration persists canonical property state; invalid state creates no account',async()=>{
 const h=harness();const body={locationSchema:'ng-states-v1',property:{name:'New estate',location:'12 Example Road',state:' lagos '}};
 assert.equal((await h.register(body)).statusCode,201);
 assert.equal(h.queries.find(q=>q.sql.includes('INSERT INTO properties')).args[6],'Lagos');
 for(const state of ['Lagoss','',undefined]){
  const invalid=harness();assert.equal((await invalid.register({...body,property:{...body.property,state}})).statusCode,400);
  assert.ok(!invalid.queries.some(q=>q.sql.includes('INSERT INTO users')));
 }
});
test('provider coverage is validated and derived from selected states, not free text',async()=>{
 const h=harness();assert.equal((await h.register({accountType:'service_provider',company:'Provider',locationSchema:'ng-states-v1',coverageStates:['lagos','Ogun','Lagos'],coverageArea:'Misspelled ignored'})).statusCode,201);
 assert.equal(h.queries.find(q=>q.sql.includes('INSERT INTO service_provider_organisations')).args[4],'Lagos, Ogun');
 const bad=harness();assert.equal((await bad.register({accountType:'service_provider',company:'Provider',locationSchema:'ng-states-v1',coverageStates:['Lagoss']})).statusCode,400);assert.ok(!bad.queries.some(q=>q.sql.includes('INSERT INTO')));
});
