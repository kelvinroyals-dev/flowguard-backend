// Disposable PGlite only. Never loads config/database or any .env file.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const {PGlite}=require('@electric-sql/pglite');
const express=require('express');
const request=require('supertest');
const {prepareDueDraft,prepareDuePlans}=require('../utils/servicePlans');
(async()=>{
  const numericAssignments=process.argv.includes('--numeric-assignments');
  const pg=new PGlite();let server;
  try{
  await pg.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,user_type TEXT,account_owner_id INT,client_role TEXT,is_active BOOLEAN DEFAULT TRUE);
    INSERT INTO users VALUES(1),(2),(3),(4),(5),(6);
    CREATE TABLE properties(property_id VARCHAR(50) PRIMARY KEY,user_id INTEGER,property_name TEXT,id SERIAL UNIQUE);
    INSERT INTO properties(property_id,user_id,property_name) VALUES('A',1,'Estate A'),('B',2,'Estate B');
    UPDATE users SET user_type=CASE WHEN id IN (1,2) THEN 'client' WHEN id IN (3,4) THEN 'service_provider' ELSE 'internal' END;
    CREATE TABLE service_provider_organisations(id INTEGER PRIMARY KEY,status TEXT,name TEXT,contact_person TEXT,email TEXT,phone TEXT);
    INSERT INTO service_provider_organisations(id,status,name) VALUES(10,'active','Provider A'),(20,'active','Provider B');
    CREATE TABLE service_provider_property_assignments(property_id ${numericAssignments?'INTEGER REFERENCES properties(id)':'VARCHAR(50) REFERENCES properties(property_id)'},service_provider_org_id INTEGER,active BOOLEAN);
    INSERT INTO service_provider_property_assignments VALUES(${numericAssignments?'1':"'A'"},10,TRUE);
    CREATE TABLE jobs(id SERIAL PRIMARY KEY,reference VARCHAR(24) UNIQUE,property_id VARCHAR(50),job_type TEXT,title TEXT,description TEXT,status TEXT,required_evidence JSONB,created_by INTEGER,scheduled_for TIMESTAMPTZ,service_provider_org_id INTEGER);
    CREATE TABLE job_events(id SERIAL PRIMARY KEY,job_id INTEGER,event_type TEXT,to_status TEXT,actor_id INTEGER,actor_type TEXT,note TEXT,meta JSONB);
    CREATE TABLE job_evidence_templates(job_type TEXT,required JSONB);
    INSERT INTO job_evidence_templates VALUES('inspection','[{"key":"before","required":true}]');`);
  for(const f of ['2026-10-10-service-requests.sql','2026-10-10-service-plans.sql'])await pg.exec(fs.readFileSync(path.join(__dirname,'../migrations',f),'utf8'));
  const pool={query:(...args)=>pg.query(...args),connect:async()=>({query:(...args)=>pg.query(...args),release(){}})};
  const users={c1:{id:1,role:'client'},c2:{id:2,role:'client'},sp1:{id:3,user_type:'service_provider',spo:10},sp2:{id:4,user_type:'service_provider',spo:20},staff:{id:5,user_type:'internal',role:'dispatcher'},analyst:{id:6,user_type:'internal',role:'analyst'}};
  const original=Module._load;
  Module._load=function(name,parent,...rest){
    if(name==='../config/database')return pool;
    if(name==='../middleware/auth')return {authenticateToken(req,res,next){req.user=users[req.headers['x-test-user']];return req.user?next():res.status(401).json({});}};
    if(name==='../middleware/rate-limit')return {writeLimiter:(req,res,next)=>next()};
    if(name==='../utils/permissions')return {requirePermission:()=> (req,res,next)=>req.user.role==='dispatcher'?next():res.status(403).json({})};
    if(name==='../utils/scope')return {propertyIdsForUser:async id=>(await pg.query('SELECT property_id FROM properties WHERE user_id=$1',[id])).rows.map(r=>r.property_id)};
    return original.call(this,name,parent,...rest);
  };
  let intake,plans;
  try{intake=require('../routes/serviceRequests');plans=require('../routes/servicePlans');}finally{Module._load=original;}
  const app=express();app.use(express.json());app.use('/requests',intake);app.use('/plans',plans);
  server=await new Promise((resolve,reject)=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));s.on('error',reject);});
  const call=(method,url,user,body)=>{const r=request(server)[method](url).set('x-test-user',user);return body?r.send(body):r;};
  const input={property_id:'A',route:'flowguard',job_type:'inspection',title:'Inspect collector',description:'Client request'};
  assert.equal((await call('post','/requests','c2',input)).status,403);
  assert.equal((await call('post','/requests','sp1',input)).status,403);
  assert.equal((await call('get','/requests/providers','c1')).body.data.length,1);
  assert.equal((await call('get','/requests/providers','c2')).body.data.length,0);
  assert.equal((await call('post','/requests','c1',{...input,route:'direct_provider',service_provider_org_id:20})).status,403);
  const managed=(await call('post','/requests','c1',input));assert.equal(managed.status,201);
  const id=managed.body.data.id;
  assert.equal((await call('get','/requests/'+id,'c2')).status,404);
  assert.equal((await call('get','/requests/'+id,'sp1')).status,404);
  assert.equal((await call('post',`/requests/${id}/draft`,'c1')).status,403);
  assert.equal((await call('post',`/requests/${id}/draft`,'analyst')).status,403);
  const draft=await call('post',`/requests/${id}/draft`,'staff');assert.equal(draft.status,201);
  const retry=await call('post',`/requests/${id}/draft`,'staff');assert.equal(retry.body.data.job_id,draft.body.data.job_id);
  const direct=await call('post','/requests','c1',{...input,route:'direct_provider',service_provider_org_id:10});assert.equal(direct.status,201);
  const directId=direct.body.data.id;
  assert.equal((await call('post',`/requests/${directId}/draft`,'staff')).status,409);
  assert.equal((await call('get',`/requests/${directId}`,'sp2')).status,404);
  assert.equal((await call('post',`/requests/${directId}/events`,'staff',{event_type:'completed',note:'Not allowed'})).status,403);
  assert.equal((await call('post',`/requests/${directId}/events`,'sp1',{event_type:'completed',note:'Provider-reported completion'})).status,201);
  const visible=await call('get',`/requests/${directId}`,'c1');assert.equal(visible.body.data.flowguard_role,'visibility_only');assert.equal(visible.body.data.events.length,1);
  assert.equal((await call('get','/requests','c2')).body.data.length,0);
  assert.equal((await call('get','/requests','sp1')).body.data.length,1);
  assert.equal((await call('post','/plans','c1',{})).status,403);
  assert.equal((await call('post','/plans','staff',{...input,interval_days:30,next_due:'2026-02-30'})).status,400);
  const created=await call('post','/plans','staff',{...input,interval_days:30,next_due:'2026-10-10'});assert.equal(created.status,201);
  const planId=created.body.data.id;
  assert.deepEqual(await prepareDueDraft(pool,planId,5,'2026-10-09'),{created:false});
  const due=await prepareDueDraft(pool,planId,5,'2026-10-10');assert.equal(due.created,true);
  assert.deepEqual(await prepareDueDraft(pool,planId,5,'2026-10-10'),{created:false});
  const jobs=(await pg.query('SELECT * FROM jobs')).rows;assert.equal(jobs.length,2);
  for(const job of jobs){assert.equal(job.status,'draft');assert.equal(job.service_provider_org_id,null);assert.equal(job.required_evidence[0].key,'before');}
  // Force the final update to fail: neither a job nor an occurrence may remain.
  await pg.query("UPDATE service_plans SET next_due='2026-11-09' WHERE id=$1",[planId]);
  const failing={connect:async()=>({release(){},query(sql,args){if(sql.startsWith('UPDATE service_plans'))throw new Error('Injected failure');return pg.query(sql,args);}})};
  await assert.rejects(prepareDueDraft(failing,planId,5,'2026-11-09','2026-11-09'));
  assert.equal((await pg.query('SELECT COUNT(*)::int AS n FROM jobs')).rows[0].n,2);
  assert.equal((await pg.query('SELECT COUNT(*)::int AS n FROM service_plan_occurrences')).rows[0].n,1);
  // An overdue catch-up retry must not silently prepare a second occurrence.
  const catchup=await prepareDueDraft(pool,planId,5,'2027-01-01','2026-11-09');assert.equal(catchup.created,true);
  assert.deepEqual(await prepareDueDraft(pool,planId,5,'2027-01-01','2026-11-09'),{created:false});
  assert.equal((await call('post',`/plans/${planId}/active`,'staff',{active:false})).status,200);
  assert.equal((await prepareDuePlans(pool,'2027-01-01')).length,0);
  assert.equal((await call('post',`/plans/${planId}/active`,'c1',{active:true})).status,403);
  await call('post',`/plans/${planId}/active`,'staff',{active:true});
  assert.equal((await prepareDuePlans(pool,'2027-01-01'))[0].created,true);
  const auto=(await pg.query("SELECT * FROM job_events WHERE actor_type='system'")).rows;
  assert.equal(auto.length,1);assert.equal(auto[0].actor_id,null);
  assert.equal((await pg.query("SELECT COUNT(*)::int AS n FROM jobs WHERE status<>'draft' OR service_provider_org_id IS NOT NULL")).rows[0].n,0);
  }finally{if(server)await new Promise(resolve=>server.close(resolve));await pg.close();}
  console.log('Service contract: tenant isolation, visibility-only routing, retry-safe drafts, evidence snapshot, recurrence and rollback PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
