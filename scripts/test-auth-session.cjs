'use strict';
// Real JWT verification, fake DB only. Never loads .env or configured database.
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const jwt=require('jsonwebtoken'),roles=require('../utils/roles');
const secret='synthetic-auth-regression-secret-not-a-production-credential';
const validUser={id:1,email:'test@example.invalid',role:'analyst',user_type:'internal',is_active:true,token_version:0};
function middleware(query){
  const context=vm.createContext({module:{exports:{}},process:{env:{JWT_SECRET:secret}},console:{error:()=>{}},require:name=>{
    if(name==='jsonwebtoken')return jwt;
    if(name==='../config/database')return {query};
    if(name==='../utils/roles')return roles;
    throw Error('Unexpected dependency');
  }});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../middleware/auth.js'),'utf8'),context);
  return context.module.exports;
}
async function request(query,{claims={},token,expiresIn='1h'}={}){
  const auth=middleware(query),req={headers:{authorization:'Bearer '+(token??jwt.sign({id:1,email:'old@example.invalid',role:'super_admin',user_type:'internal',tv:0,...claims},secret,{expiresIn}))}};
  const res={code:200,status(n){this.code=n;return this;},json(body){this.body=body;return this;}};
  let next=0;await auth.authenticateToken(req,res,()=>next++);
  return {auth,req,res,next};
}
test('uses live identity and role rather than privileged stale JWT claims',async()=>{
  const result=await request(async()=>({rows:[validUser]}));
  assert.equal(result.next,1);assert.equal(result.req.user.role,'analyst');assert.equal(result.req.user.email,validUser.email);
  let authorized=false;result.auth.requireRole('super_admin')(result.req,result.res,()=>{authorized=true;});
  assert.equal(authorized,false);assert.equal(result.res.code,403);
});
test('current account type changes cannot retain internal token privileges',async()=>{
  const result=await request(async()=>({rows:[{...validUser,user_type:'client',role:'client'}]}));
  assert.equal(result.next,1);assert.equal(result.req.user.role,'client');assert.equal(result.req.user.user_type,'client');
});
test('normalizes current database role aliases',async()=>{
  const result=await request(async()=>({rows:[{...validUser,role:'Operations Manager'}]}));
  assert.equal(result.req.user.role,'operations_manager');
});
test('database or missing migration errors fail closed with retryable 503',async()=>{
  for(const message of ['database unavailable','column token_version does not exist']){
    const result=await request(async()=>{throw Error(message);});
    assert.equal(result.next,0);assert.equal(result.res.code,503);
    assert.doesNotMatch(result.res.body.error,/column|token_version|database/);
  }
});
test('deleted, deactivated and revoked accounts remain denied',async()=>{
  for(const rows of [[],[{...validUser,is_active:false}],[{...validUser,token_version:1}]]){
    const result=await request(async()=>({rows}));assert.equal(result.next,0);assert.equal(result.res.code,401);
  }
});
test('invalid or expired tokens never query the database',async()=>{
  for(const options of [{token:'invalid'},{expiresIn:-1}]){
    let calls=0;const result=await request(async()=>{calls++;return {rows:[validUser]};},options);
    assert.equal(calls,0);assert.equal(result.next,0);assert.equal(result.res.code,401);
  }
});
test('purpose-scoped verification and evidence tokens are never login sessions',async()=>{
  for(const purpose of ['email_verify','email_code','email_verified','evidence','report-snapshot','']){
    let calls=0;
    const result=await request(async()=>{calls++;return {rows:[validUser]};},{claims:{purpose}});
    assert.equal(calls,0);assert.equal(result.next,0);assert.equal(result.res.code,401);
  }
});
test('provider organisation and privileges come from current account, not token',async()=>{
  const result=await request(async()=>({rows:[{...validUser,user_type:'service_provider',role:'service_provider',service_provider_org_id:22,sp_role:'field_technician'}]}),{claims:{spo:11,sp_role:'owner_admin'}});
  assert.equal(result.next,1);assert.equal(result.req.user.spo,22);assert.equal(result.req.user.sp_role,'field_technician');
  const removed=await request(async()=>({rows:[validUser]}),{claims:{spo:11,sp_role:'owner_admin'}});
  assert.equal(removed.req.user.spo,null);assert.equal(removed.req.user.sp_role,null);
});
test('malformed identities are rejected before querying an integer account key',async()=>{
  for(const id of [null,true,{},-1,'not-an-id',0]){
    let calls=0;const result=await request(async()=>{calls++;return {rows:[validUser]};},{claims:{id}});
    assert.equal(calls,0);assert.equal(result.next,0);assert.equal(result.res.code,401);
  }
});
