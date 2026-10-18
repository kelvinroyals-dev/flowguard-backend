// Synthetic records in disposable PGlite; enqueue only. Never loads .env.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const {createOperationalEmails,alertTransition,coverage,coverageTransition}=require('../utils/operationalEmails');
const {createOutbox}=require('../utils/emailOutbox');
test('incident transition policy and coverage never equate missing readings to safe drains',()=>{
  assert.equal(alertTransition(null,{status:'active',severity:'critical'},false),null);
  assert.equal(alertTransition(null,{status:'active',severity:'critical'},true),'opened');
  assert.equal(alertTransition({status:'active',severity:'high'},{status:'active',severity:'critical'}),'escalated');
  assert.equal(alertTransition({status:'active',severity:'critical',notified:true},{status:'resolved'}),'resolved');
  assert.equal(alertTransition({status:'active',severity:'critical',notified:false},{status:'resolved'}),'resolved');
  assert.equal(alertTransition({status:'active',severity:'moderate',notified:false},{status:'resolved'}),null);
  const now=Date.now(),recent=new Date(now-60000).toISOString();
  assert.deepEqual(coverage([{status:'active',last_ping:recent,reading_time:recent,level:'0'}],now),{healthy:1,total:1});
  for(const level of [null,'',false,101,-1])assert.equal(coverage([{status:'active',last_ping:recent,reading_time:recent,level}],now).healthy,0);
  assert.equal(coverage([{status:'active',last_ping:recent,reading_time:new Date(now+60000),level:0}],now).healthy,0);
  assert.deepEqual(coverage([{status:'active',last_ping:null},{status:'maintenance',last_ping:recent}],now),{healthy:0,total:0});
  assert.equal(coverageTransition({healthy:2,total:2},{healthy:0,total:2}),'lost');
  assert.equal(coverageTransition({healthy:0,total:2},{healthy:1,total:2}),'improved');
  assert.equal(coverageTransition({healthy:0,total:2},{healthy:0,total:0}),null);
});
test('client alert links resolve canonical estate ownership, member permissions and manual property links',async()=>{
  const pg=new PGlite(),Module=require('node:module'),original=Module._load;
  try{
    await pg.exec(`CREATE TABLE users(id INT,user_type TEXT,is_active BOOLEAN,account_owner_id INT,client_role TEXT);
      INSERT INTO users VALUES(1,'client',true,NULL,NULL),(2,'client',true,NULL,NULL),(3,'client',true,1,'finance'),(4,'client',true,1,'viewer'),(5,'client',false,1,'viewer');
      CREATE TABLE properties(property_id TEXT PRIMARY KEY,parent_property_id TEXT,user_id INT,property_name TEXT,latitude NUMERIC,longitude NUMERIC);
      INSERT INTO properties(property_id,parent_property_id,user_id,property_name)VALUES('A',NULL,1,'Estate A'),('DRAIN-A','A',NULL,'Drain A'),('B',NULL,2,'Estate B');
      CREATE TABLE sensors(sensor_id TEXT PRIMARY KEY,property_id TEXT,name TEXT,latitude NUMERIC,longitude NUMERIC);
      INSERT INTO sensors(sensor_id,property_id,name)VALUES('SA','DRAIN-A','Node A'),('SB','B','Node B');
      CREATE TABLE clients(id INT,name TEXT);
      CREATE TABLE field_teams(team_id INT,team_name TEXT);
      CREATE TABLE jobs(id INT,source_alert_id TEXT,created_at TIMESTAMPTZ);
      CREATE TABLE tickets(ticket_id TEXT,alert_id TEXT,created_at TIMESTAMPTZ);
      CREATE TABLE alerts(alert_id TEXT PRIMARY KEY,property_id TEXT,sensor_id TEXT,client_id INT,severity TEXT,alert_type TEXT,description TEXT,location TEXT,status TEXT DEFAULT 'active',assigned_team_id INT,created_at TIMESTAMPTZ DEFAULT NOW(),resolved_at TIMESTAMPTZ);
      INSERT INTO alerts(alert_id,property_id,sensor_id,client_id,severity)VALUES('A-ALERT',NULL,'SA',NULL,'critical'),('B-ALERT','B','SB',99,'critical'),('LEGACY',NULL,NULL,99,'high');`);
    Module._load=function(name,parent,...rest){
      if(name==='../config/database')return {query:(...a)=>pg.query(...a)};
      if(name==='../middleware/auth')return {authenticateToken:(_r,_s,n)=>n()};
      if(name==='../utils/permissions')return {requirePermission:()=> (_r,_s,n)=>n(),hasPermission:async()=>true};
      if(name==='../utils/scope')return {isClient:r=>r.user.role==='client',isSpUser:()=>false,clientIdsForUser:async id=>id===1?[99]:[],teamIdsForUser:async()=>[]};
      if(name==='../realtime/io')return {events:{alertNew(){}}};
      return original.call(this,name,parent,...rest);
    };
    const router=require('../routes/alerts');
    const accountGuard=router.stack.filter(l=>!l.route)[1].handle;
    for(const user of [{role:'admin',user_type:'client'},{role:'admin',user_type:'service_provider'},{role:'admin',user_type:null}]){
      const res={status(c){this.code=c;return this;},json(){}};accountGuard({user},res,()=>assert.fail('inconsistent account must not pass'));assert.equal(res.code,403);
    }
    const call=async(method,id,body={})=>{const h=router.stack.find(l=>l.route?.path==='/'&&l.route.methods[method]).route.stack.at(-1).handle;
      const res={code:200,status(c){this.code=c;return this;},json(b){this.body=b;return this;}};
      await h({user:{id,role:method==='get'?'client':'dispatcher'},body},res);return res;};
    assert.deepEqual((await call('get',1)).body.data.map(a=>a.alert_id).sort(),['A-ALERT','LEGACY']);
    assert.deepEqual((await call('get',2)).body.data.map(a=>a.alert_id),['B-ALERT']);
    assert.equal((await call('get',3)).code,403);assert.equal((await call('get',5)).code,403);
    assert.deepEqual((await call('get',4)).body.data.map(a=>a.alert_id).sort(),['A-ALERT','LEGACY']);
    const manual=await call('post',10,{property_id:'A',severity:'critical'});assert.equal(manual.code,201);assert.equal(manual.body.data.property_id,'A');
    assert.equal((await call('post',10,{property_id:'B',sensor_id:'SA'})).code,409);
    assert.equal((await call('post',10,{property_id:'NOT-REAL'})).code,400);
    assert.equal((await call('post',10,{severity:'bogus'})).code,400);
  }finally{Module._load=original;await pg.close();}
});
test('operational emails baseline, deduplicate, debounce, isolate estates and recheck access',async()=>{
  const pg=new PGlite();
  const pool={query:(...a)=>pg.query(...a),connect:async()=>({query:(...a)=>pg.query(...a),release(){}})};
  const canStaff=async(role,key)=>role==='dispatcher'&&['alerts.view','devices.view'].includes(key);
  let clock=Date.now();const service=createOperationalEmails({pool,canStaff,now:()=>clock,from:'Synthetic <test@example.invalid>'});
  try{
    await pg.exec(`CREATE TABLE users(id INT PRIMARY KEY,email TEXT,role TEXT,user_type TEXT,account_owner_id INT,client_role TEXT,is_active BOOLEAN);
      CREATE TABLE user_preferences(user_id INT PRIMARY KEY,notification_preferences JSONB DEFAULT '{}');
      CREATE TABLE app_settings(id INT PRIMARY KEY,settings JSONB DEFAULT '{}');
      CREATE TABLE properties(property_id TEXT PRIMARY KEY,parent_property_id TEXT,user_id INT,property_name TEXT);
      CREATE TABLE sensors(sensor_id TEXT PRIMARY KEY,property_id TEXT,status TEXT,last_ping TIMESTAMPTZ);
      CREATE TABLE sensor_readings(sensor_id TEXT,time TIMESTAMPTZ,water_level_percent NUMERIC);
      CREATE TABLE alerts(alert_id TEXT PRIMARY KEY,property_id TEXT,sensor_id TEXT,status TEXT,severity TEXT,created_at TIMESTAMPTZ,resolved_at TIMESTAMPTZ);
      INSERT INTO properties VALUES('A',NULL,1,'Estate <A>'),('B',NULL,2,'Estate B');
      INSERT INTO users VALUES(1,'owner-a@example.invalid','client','client',NULL,NULL,true),(2,'owner-b@example.invalid','client','client',NULL,NULL,true),
        (3,'dispatch@example.invalid','dispatcher','internal',NULL,NULL,true),(4,'finance@example.invalid','finance','client',1,'finance',true),
        (5,'viewer@example.invalid','client','client',1,'viewer',true),(6,'provider@example.invalid','service_provider','service_provider',NULL,NULL,true);
      INSERT INTO user_preferences(user_id)SELECT id FROM users;INSERT INTO app_settings(id)VALUES(1);
      ALTER TABLE users ADD COLUMN service_provider_org_id INTEGER;
      INSERT INTO users(id,email,role,user_type,account_owner_id,client_role,is_active,service_provider_org_id)VALUES(7,'misclassified-provider@example.invalid','client','client',1,'viewer',true,9);
      INSERT INTO sensors VALUES('S1','A','active',NOW()),('S2','B','active',NOW());
      INSERT INTO sensor_readings VALUES('S1',NOW(),20),('S2',NOW(),0);
      INSERT INTO alerts VALUES('OLD','A','S1','active','critical',NOW()-INTERVAL '1 day',NULL);`);
    for(const name of ['2026-10-17-email-outbox.sql','2026-10-17-operational-email-state.sql'])await pg.exec(fs.readFileSync(path.join(__dirname,'../migrations',name),'utf8'));
    clock=Date.now();
    await service.sweep();assert.equal((await pg.query('SELECT COUNT(*)::int n FROM email_outbox')).rows[0].n,0);
    await pg.exec(`INSERT INTO alerts VALUES('NEW','A','S1','active','high',NOW()+INTERVAL '1 second',NULL)`);
    await service.sweep();let rows=(await pg.query('SELECT * FROM email_outbox ORDER BY recipient')).rows;
    assert.equal(rows.length,3);assert.deepEqual(rows.map(r=>r.recipient),['dispatch@example.invalid','owner-a@example.invalid','viewer@example.invalid']);
    assert.ok(rows.every(r=>r.payload.html.includes('Estate &lt;A&gt;')&&r.payload.html.includes('Flooding is not confirmed')));
    await service.sweep();assert.equal((await pg.query('SELECT COUNT(*)::int n FROM email_outbox')).rows[0].n,3);
    await pg.exec("UPDATE alerts SET severity='critical' WHERE alert_id='NEW'");await service.sweep();assert.equal((await pg.query('SELECT COUNT(*)::int n FROM email_outbox')).rows[0].n,6);
    let transportCalls=0;const q=createOutbox({pool,canStaff,transport:async()=>{transportCalls++;return {accepted:true,providerId:'fake'};}});
    await pg.exec("UPDATE alerts SET status='resolved',resolved_at=NOW() WHERE alert_id='NEW'");await service.sweep();
    await q.sweep();assert.equal(transportCalls,3); // obsolete open/escalation suppressed, only resolution sent
    await pg.exec("UPDATE sensor_readings SET time=NOW()-INTERVAL '1 hour' WHERE sensor_id='S1'");
    await service.sweep();const before=(await pg.query('SELECT COUNT(*)::int n FROM email_outbox')).rows[0].n;
    await service.sweep();assert.equal((await pg.query('SELECT COUNT(*)::int n FROM email_outbox')).rows[0].n,before);
    clock+=6*60000;await service.sweep();assert.equal((await pg.query('SELECT COUNT(*)::int n FROM email_outbox')).rows[0].n,before+3);
    // Role/access revocation before delivery suppresses that recipient.
    await pg.exec("UPDATE users SET client_role='finance' WHERE id=5");transportCalls=0;await q.sweep();assert.equal(transportCalls,2);
    await pg.exec("INSERT INTO sensor_readings VALUES('S1',NOW(),15)");
    await service.sweep();clock+=6*60000;await service.sweep();
    rows=(await pg.query("SELECT * FROM email_outbox WHERE status='pending'")).rows;
    assert.equal(rows.length,2);assert.ok(rows.every(r=>r.payload.subject.includes('restored')));
    await pg.exec('UPDATE properties SET user_id=2 WHERE property_id=\'A\'');transportCalls=0;await q.sweep();assert.equal(transportCalls,1); // ops only, former owner denied
    await pg.exec("INSERT INTO alerts VALUES('ROLLBACK','A','S1','active','critical',NOW(),NULL)");
    const priorCount=(await pg.query('SELECT COUNT(*)::int n FROM email_outbox')).rows[0].n;
    let inserts=0;const broken={...pool,connect:async()=>({release(){},query:async(sql,args)=>{if(sql.includes('INSERT INTO email_outbox')&&++inserts===2)throw Error('synthetic enqueue failure');return pg.query(sql,args);}})};
    const failing=createOperationalEmails({pool:broken,canStaff,now:()=>clock});
    await assert.rejects(failing.observe('alert','ROLLBACK',{status:'active',severity:'critical',resolvedAt:null,propertyId:'A'},{propertyId:'A',propertyName:'Estate A',createdAt:new Date(clock)},new Date(0)),/synthetic enqueue failure/);
    assert.equal((await pg.query("SELECT COUNT(*)::int n FROM operational_email_state WHERE entity_key='ROLLBACK'")).rows[0].n,0);
    assert.equal((await pg.query('SELECT COUNT(*)::int n FROM email_outbox')).rows[0].n,priorCount);
  }finally{await pg.close();}
});
