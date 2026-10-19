// Synthetic data and fake delivery only. Never loads .env or contacts a provider.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const {createLifecycle,plan}=require('../utils/emailLifecycle');
const {createSchedules}=require('../utils/emailSchedules');
const {createOutbox}=require('../utils/emailOutbox');
const {reminderStillApplies}=require('../utils/emailDomainPolicy');
const {verify,createHandler,reconcile}=require('../utils/emailWebhooks');
const {createHmac}=require('node:crypto');
async function fixture(){
 const pg=new PGlite(),pool={query:(...a)=>pg.query(...a),connect:async()=>({query:(...a)=>pg.query(...a),release(){}})};
 await pg.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,user_type TEXT,role TEXT,is_active BOOLEAN DEFAULT TRUE,account_owner_id INTEGER,client_role TEXT,service_provider_org_id INTEGER,sp_role TEXT,password_hash TEXT,locked_until TIMESTAMPTZ);
 CREATE TABLE properties(property_id TEXT PRIMARY KEY,parent_property_id TEXT,user_id INTEGER);
 CREATE TABLE user_preferences(user_id INTEGER PRIMARY KEY,notification_preferences JSONB);
 CREATE TABLE app_settings(id INTEGER PRIMARY KEY,settings JSONB);
 CREATE TABLE invoices(invoice_id VARCHAR(50) PRIMARY KEY,user_id INTEGER,property_id TEXT,balance_due NUMERIC,due_date DATE,status TEXT,sent_at TIMESTAMPTZ,sent_count INTEGER DEFAULT 0,reminder_sent_count INTEGER DEFAULT 0,last_reminder_sent TIMESTAMPTZ,updated_at TIMESTAMPTZ,total_amount NUMERIC,amount_paid NUMERIC,payment_status TEXT,currency TEXT);
 CREATE TABLE alerts(alert_id TEXT PRIMARY KEY,property_id TEXT,sensor_id TEXT,status TEXT,severity TEXT,assigned_team_id INTEGER,created_at TIMESTAMPTZ DEFAULT NOW());
 CREATE TABLE service_requests(id TEXT PRIMARY KEY,property_id TEXT,status TEXT,route TEXT,job_id TEXT,service_provider_org_id INTEGER);
 CREATE TABLE service_request_events(id SERIAL PRIMARY KEY,request_id TEXT,event_type TEXT,note TEXT);
 CREATE TABLE jobs(id TEXT PRIMARY KEY,property_id TEXT,service_provider_org_id INTEGER,status TEXT,scheduled_for TIMESTAMPTZ,sla_due_at TIMESTAMPTZ,dispatched_at TIMESTAMPTZ);
 CREATE TABLE job_comments(id SERIAL PRIMARY KEY,job_id TEXT,author_type TEXT,message TEXT);
 CREATE TABLE tickets(ticket_id TEXT PRIMARY KEY,user_id INTEGER,property_id TEXT,status TEXT,category TEXT,work_type TEXT,assigned_team TEXT,created_at TIMESTAMPTZ DEFAULT NOW());
 CREATE TABLE ticket_messages(id SERIAL PRIMARY KEY,ticket_id TEXT,author_type TEXT,message TEXT,created_at TIMESTAMPTZ DEFAULT NOW());
 CREATE TABLE inspection_reports(report_id TEXT PRIMARY KEY,property_id TEXT,status TEXT,updated_at TIMESTAMPTZ DEFAULT NOW());
 CREATE TABLE service_provider_organisations(id INTEGER PRIMARY KEY,status TEXT,email TEXT,verification_submitted_at TIMESTAMPTZ);
 CREATE TABLE payments(payment_id TEXT PRIMARY KEY,invoice_id TEXT,status TEXT,amount NUMERIC,currency TEXT DEFAULT 'NGN');
 CREATE TABLE service_plans(id TEXT PRIMARY KEY,property_id TEXT,active BOOLEAN,next_due DATE);
 CREATE TABLE sensors(sensor_id TEXT PRIMARY KEY,property_id TEXT,status TEXT,lifecycle_state TEXT,driver_id TEXT,battery_voltage NUMERIC,last_ping TIMESTAMPTZ);
 CREATE TABLE device_events(id SERIAL PRIMARY KEY,sensor_id TEXT,kind TEXT);
 CREATE TABLE device_integrity_events(id SERIAL PRIMARY KEY,sensor_id TEXT,kind TEXT);
 CREATE TABLE ingest_errors(id SERIAL PRIMARY KEY,sensor_id TEXT,payload JSONB,occurred_at TIMESTAMPTZ DEFAULT NOW());
 CREATE TABLE sla_tracking(id SERIAL PRIMARY KEY,property_id TEXT,sla_breaches JSONB);
 INSERT INTO users(id,email,user_type,role,password_hash)VALUES(1,'owner@example.invalid','client','client','secret-hash'),(2,'foreign@example.invalid','client','client','other'),(3,'ops@example.invalid','internal','super_admin','other');
 INSERT INTO users(id,email,user_type,role,account_owner_id,client_role)VALUES(4,'viewer@example.invalid','client','client',1,'viewer'),(5,'finance@example.invalid','client','client',1,'finance');
 INSERT INTO users(id,email,user_type,role,service_provider_org_id)VALUES(6,'provider@example.invalid','service_provider','service_provider',10);
 INSERT INTO properties VALUES('ESTATE',NULL,1);INSERT INTO app_settings VALUES(1,'{}');
 INSERT INTO service_provider_organisations VALUES(10,'active',NULL,NULL);`);
 for(const name of ['email-outbox','email-lifecycle']){const sql=fs.readFileSync(path.join(__dirname,'../migrations/2026-10-17-'+name+'.sql'),'utf8');await pg.exec(sql);await pg.exec(sql);}
 return {pg,pool,close:()=>pg.close()};
}
test('domain triggers are atomic, avoid secrets and cover all configured source tables',async()=>{
 const f=await fixture();try{
  assert.equal((await f.pg.query('SELECT * FROM email_source_inventory WHERE installed=FALSE')).rows.length,0);
  await f.pg.exec("BEGIN;UPDATE users SET password_hash='private-replacement' WHERE id=1;ROLLBACK;");
  assert.equal((await f.pg.query('SELECT * FROM email_domain_events')).rows.length,0);
  await f.pg.exec("UPDATE users SET password_hash='private-replacement' WHERE id=1");
  const e=(await f.pg.query('SELECT * FROM email_domain_events')).rows[0];
  assert.equal(e.after_values.password_changed,true);assert.ok(!JSON.stringify(e).includes('private-replacement'));assert.ok(!JSON.stringify(e).includes('secret-hash'));
  await f.pg.exec("INSERT INTO ticket_messages(ticket_id,author_type,message)VALUES('T1','client','PRIVATE BODY');INSERT INTO ingest_errors(sensor_id,payload)VALUES('S1','{\"token\":\"PRIVATE TOKEN\"}')");
  assert.ok(!(await f.pg.query('SELECT * FROM email_domain_events')).rows.some(r=>JSON.stringify(r).includes('PRIVATE')));
 }finally{await f.close();}
});
test('lifecycle recipient boundaries, optional preferences, overtaken state and mandatory security notices',async()=>{
 const f=await fixture();try{
  const life=createLifecycle({pool:f.pool,canStaff:async()=>true,from:'FlowGuard <test@example.invalid>'});
  await f.pg.exec("INSERT INTO service_requests VALUES('R1','ESTATE','requested','flowguard',NULL,NULL)");await life.sweep();
  let rows=(await f.pg.query('SELECT * FROM email_outbox')).rows;
  assert.deepEqual(rows.map(r=>r.recipient).sort(),['ops@example.invalid','owner@example.invalid','viewer@example.invalid']);
  await life.sweep();assert.equal((await f.pg.query('SELECT * FROM email_outbox')).rows.length,3);
  await f.pg.exec("UPDATE service_requests SET status='cancelled' WHERE id='R1'");
  const sent=[],q=createOutbox({pool:f.pool,canStaff:async()=>true,transport:async p=>{sent.push(p);return {accepted:true,providerId:'fake-'+sent.length};}});
  await q.sweep();assert.equal(sent.length,0);assert.ok((await f.pg.query('SELECT status FROM email_outbox')).rows.every(r=>r.status==='suppressed'));
  await f.pg.exec("INSERT INTO user_preferences VALUES(1,'{\"email_alerts\":false}');UPDATE users SET password_hash='next-secret' WHERE id=1");
  await life.sweep();await q.sweep();assert.equal(sent.filter(p=>p.subject==='Your password was changed').length,1);
  await f.pg.exec("INSERT INTO invoices(invoice_id,user_id,property_id,balance_due,status)VALUES('INV',1,'ESTATE',100,'open');INSERT INTO payments(payment_id,invoice_id,status,amount) VALUES('PAY','INV','successful',10)");
  await life.sweep();await q.sweep();
  assert.deepEqual(sent.filter(p=>p.subject==='Payment recorded').map(p=>p.to[0]).sort(),['finance@example.invalid','ops@example.invalid','owner@example.invalid']);
  await f.pg.exec("DELETE FROM users WHERE id=1");await life.sweep();await q.sweep();assert.equal(sent.filter(p=>p.subject==='Account removed').length,1);
 }finally{await f.close();}
});
test('scheduler SQL executes, deduplicates reminders and updates counters only after fake provider acceptance',async()=>{
 const f=await fixture();try{
  await f.pg.exec("INSERT INTO invoices(invoice_id,user_id,property_id,balance_due,due_date,status)VALUES('INV',1,'ESTATE',100,CURRENT_DATE-1,'open');INSERT INTO jobs(id,property_id,status,dispatched_at,sla_due_at)VALUES('J1','ESTATE','dispatched',NOW()-INTERVAL '2 hours',NOW()+INTERVAL '30 minutes');INSERT INTO tickets(ticket_id,user_id,status,created_at)VALUES('T1',1,'new',NOW()-INTERVAL '2 days');INSERT INTO inspection_reports VALUES('REP','ESTATE','review',NOW()-INTERVAL '3 days');INSERT INTO service_plans VALUES('PLAN','ESTATE',TRUE,CURRENT_DATE-1)");
  await f.pg.exec("UPDATE invoices SET status='sent',sent_at=NOW()-INTERVAL '1 day',sent_count=1,total_amount=100,amount_paid=0,currency='NGN',payment_status='pending'");
  await f.pg.exec(`INSERT INTO invoices(invoice_id,user_id,balance_due,due_date,status,sent_at,sent_count,total_amount,amount_paid,currency,payment_status) VALUES
   ('DRAFT',1,100,CURRENT_DATE-1,'draft',NOW()-INTERVAL '1 day',1,100,0,'NGN','pending'),
   ('UNISSUED',1,100,CURRENT_DATE-1,'open',NULL,0,100,0,'NGN','pending'),
   ('VOID',1,100,CURRENT_DATE-1,'void',NOW()-INTERVAL '1 day',1,100,0,'NGN','pending'),
   ('UNRECONCILED',1,80,CURRENT_DATE-1,'sent',NOW()-INTERVAL '1 day',1,100,0,'NGN','pending'),
   ('UNLINKED',NULL,100,CURRENT_DATE-1,'sent',NOW()-INTERVAL '1 day',1,100,0,'NGN','pending');`);
  const stampForSchedule=Date.now(),schedule=createSchedules({pool:f.pool,now:()=>stampForSchedule});await schedule.sweep();
  const count=(await f.pg.query("SELECT COUNT(*)::int AS n FROM email_domain_events WHERE action IN ('REMINDER','DIGEST')")).rows[0].n;
  assert.deepEqual((await f.pg.query("SELECT entity_key FROM email_domain_events WHERE entity='invoices' AND action='REMINDER'")).rows.map(r=>r.entity_key),['INV']);
  const watForSchedule=new Date(stampForSchedule+3600000),digestOpen=watForSchedule.getUTCDay()!==1||watForSchedule.getUTCHours()>=6;
  assert.equal(count,6+(digestOpen?6:0));await schedule.sweep();assert.equal((await f.pg.query("SELECT COUNT(*)::int AS n FROM email_domain_events WHERE action IN ('REMINDER','DIGEST')")).rows[0].n,count);
  const life=createLifecycle({pool:f.pool,canStaff:async()=>true,from:'test@example.invalid'});await life.sweep();
  assert.equal((await f.pg.query("SELECT reminder_sent_count FROM invoices WHERE invoice_id='INV'")).rows[0].reminder_sent_count,0);
  const q=createOutbox({pool:f.pool,canStaff:async()=>true,transport:async()=>({accepted:true,providerId:'fake-reminder'})});await q.sweep();
  assert.equal((await f.pg.query("SELECT reminder_sent_count FROM invoices WHERE invoice_id='INV'")).rows[0].reminder_sent_count,2); // owner and authorised finance member
  await f.pg.exec("UPDATE invoices SET balance_due=0;UPDATE jobs SET status='cancelled'");
  assert.equal(await reminderStillApplies(f.pool,{after_values:{notification_type:'invoice_reminder'}},{row:{balance_due:0}}),false);
  assert.equal(await reminderStillApplies(f.pool,{after_values:{notification_type:'visit_due'}},{row:{status:'cancelled',scheduled_for:new Date(Date.now()+1000)}}),false);
  assert.equal(await reminderStillApplies(f.pool,{after_values:{notification_type:'unknown'}},{row:{}}),false);
  const stamp=Date.now();
  assert.equal(await reminderStillApplies(f.pool,{after_values:{notification_type:'visit_due'}},{row:{status:'accepted',scheduled_for:new Date(stamp+2*86400000)}},stamp),false);
  assert.equal(await reminderStillApplies(f.pool,{after_values:{notification_type:'acceptance_overdue'}},{row:{status:'accepted',dispatched_at:new Date(stamp-7200000)}},stamp),false);
  await f.pg.exec("INSERT INTO ticket_messages(ticket_id,author_type,message)VALUES('T1','support','PRIVATE RESPONSE')");
  const ticket=(await f.pg.query("SELECT * FROM tickets WHERE ticket_id='T1'")).rows[0];
  assert.equal(await reminderStillApplies(f.pool,{after_values:{notification_type:'support_waiting'}},{row:ticket}),false);
  await require('../utils/emailHealth').record(f.pool,'weather',false);
  assert.equal(await reminderStillApplies(f.pool,{after_values:{notification_type:'weather_unavailable'}},{row:{}}),true);
  await require('../utils/emailHealth').record(f.pool,'weather',true);
  assert.equal(await reminderStillApplies(f.pool,{after_values:{notification_type:'weather_unavailable'}},{row:{}}),false);
 }finally{await f.close();}
});
test('malformed lifecycle source does not starve later events and deadletters after bounded retries',async()=>{
 const f=await fixture();try{
  await f.pg.exec("INSERT INTO email_domain_events(entity,entity_key,action,after_values)VALUES('invoices','bad','INSERT','{}');INSERT INTO service_requests VALUES('R1','ESTATE','requested','flowguard',NULL,NULL)");
  const base=f.pool.query.bind(f.pool);let fail=true;
  const broken={...f.pool,connect:async()=>({release(){},query:(s,p)=>s.startsWith('SELECT * FROM invoices')&&fail?Promise.reject(Error('synthetic')):base(s,p)})};
  // INSERT invoices intentionally has no template, so use a valid failing reminder.
  await f.pg.exec("UPDATE email_domain_events SET action='REMINDER',after_values='{\"notification_type\":\"invoice_reminder\"}' WHERE entity='invoices'");
  const life=createLifecycle({pool:broken,canStaff:async()=>true,from:'test@example.invalid'});await life.sweep();
  assert.equal((await base("SELECT attempts FROM email_domain_events WHERE entity='invoices'")).rows[0].attempts,1);
  assert.equal((await base('SELECT COUNT(*)::int n FROM email_outbox')).rows[0].n,3);
  for(let i=0;i<4;i++){await base("UPDATE email_domain_events SET retry_at=NOW()-INTERVAL '1 second' WHERE entity='invoices'");await life.sweep();}
  assert.equal((await base("SELECT attempts FROM email_domain_events WHERE entity='invoices'")).rows[0].attempts,5);
 }finally{await f.close();}
});
test('webhooks verify raw signatures, reject tampering, deduplicate and suppress bounces without leaking bodies',async()=>{
 const f=await fixture();try{
  const secret='whsec_'+Buffer.alloc(32,9).toString('base64'),now=Date.now(),timestamp=String(Math.floor(now/1000));
  const sign=(raw,id)=>({'svix-id':id,'svix-timestamp':timestamp,'svix-signature':'v1,'+createHmac('sha256',Buffer.alloc(32,9)).update(id+'.'+timestamp+'.').update(raw).digest('base64')});
  const raw=Buffer.from(JSON.stringify({type:'email.bounced',created_at:new Date(now).toISOString(),data:{email_id:'fake-id',private:'not stored'}})),headers=sign(raw,'msg_test');
  assert.equal(verify(raw,headers,secret,now).type,'email.bounced');
  assert.throws(()=>verify(Buffer.from('{}'),headers,secret,now));assert.throws(()=>verify(raw,headers,secret,now+301000));
  const handler=createHandler({pool:f.pool,secret,now:()=>now}),res={code:200,status(n){this.code=n;return this;},json(v){this.body=v;return this;}};
  await handler({body:raw,headers},res);assert.equal(res.code,200);await handler({body:raw,headers},res);
  assert.equal((await f.pg.query('SELECT * FROM email_webhook_events')).rows.length,1);
  const q=createOutbox({pool:f.pool,transport:async()=>({accepted:true,providerId:'fake-id'})});
  await q.send({to:['owner@example.invalid'],subject:'Synthetic',html:'safe'},{eventKey:'webhook-test'});await reconcile(f.pool);
  assert.equal((await f.pg.query('SELECT delivery_status FROM email_outbox')).rows[0].delivery_status,'email.bounced');
  assert.equal((await q.send({to:['owner@example.invalid'],subject:'Synthetic',html:'safe'},{eventKey:'suppressed-test'})).status,'suppressed');
  await f.pg.query("INSERT INTO email_webhook_events VALUES('late','fake-id','email.sent',NOW(),NOW())");await reconcile(f.pool);
  assert.equal((await f.pg.query('SELECT delivery_status FROM email_outbox ORDER BY created_at LIMIT 1')).rows[0].delivery_status,'email.bounced');
  assert.ok(!JSON.stringify((await f.pg.query('SELECT * FROM email_webhook_events')).rows).includes('not stored'));
 }finally{await f.close();}
});
test('templates distinguish provider completion from verified work and avoid flood claims',()=>{
 assert.match(plan({entity:'jobs',action:'UPDATE',before_values:{status:'started'},after_values:{status:'completed'}}).title,/verification pending/);
 assert.match(plan({entity:'service_request_events',action:'INSERT',after_values:{}}).note,/not FlowGuard approval/);
 assert.equal(plan({entity:'ingest_errors',action:'INSERT',after_values:{}}),null);
});
test('real authenticated HTTP guards isolate billing, manual reminders and admin delivery regeneration',async()=>{
 const f=await fixture();let server;
 try{
  await f.pg.exec(`ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 0;ALTER TABLE users ADD COLUMN full_name TEXT;
   ALTER TABLE properties ADD COLUMN property_name TEXT;ALTER TABLE invoices ADD COLUMN created_at TIMESTAMPTZ DEFAULT NOW();
   CREATE TABLE role_permissions(role TEXT,permission_key TEXT,allowed BOOLEAN,updated_at TIMESTAMPTZ,PRIMARY KEY(role,permission_key));
   INSERT INTO invoices(invoice_id,user_id,property_id,balance_due,status,payment_status)VALUES('INV',1,'ESTATE',100,'open','pending'),('FOREIGN',2,NULL,50,'open','pending');`);
  await f.pg.exec("UPDATE invoices SET status='sent',sent_at=NOW()-INTERVAL '1 day',sent_count=1,total_amount=balance_due,amount_paid=0,currency='NGN'");
  const vm=require('node:vm'),{createRequire}=require('node:module'),express=require('express'),request=require('supertest'),jwt=require('jsonwebtoken');
  const env={JWT_SECRET:'synthetic-email-http-secret',MAIL_OUTBOX_ENABLED:'true',LIFECYCLE_EMAILS_ENABLED:'true',RESEND_API_KEY:'synthetic-no-network',MAIL_FROM:'test@example.invalid'};
  let auth,permissions;
  function load(relative){const file=path.join(__dirname,'..',relative),normal=createRequire(file),context=vm.createContext({module:{exports:{}},process:{env},console:{error(){}},Buffer,URL,Date,Map,Set,require:n=>{
   if(n==='../config/database')return f.pool;
   if(n==='../middleware/auth')return auth;
   if(n==='../utils/permissions'||n==='./permissions')return permissions;
   if(n==='../utils/audit')return {logAction(){}};
   return normal(n);
  }});vm.runInContext(fs.readFileSync(file,'utf8'),context,{filename:relative});return context.module.exports;}
  auth=load('middleware/auth.js');permissions=load('utils/permissions.js');
  const app=express();app.use(express.json());app.use('/billing',load('routes/billing.js'));app.use('/email-deliveries',load('routes/emailDeliveries.js'));
  server=await new Promise((resolve,reject)=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));s.on('error',reject);});
  const call=(method,url,id,body)=>{let r=request(server)[method](url);if(id)r=r.set('Authorization','Bearer '+jwt.sign({id,tv:0},env.JWT_SECRET,{expiresIn:'5m'}));return body?r.send(body):r;};
  assert.equal((await call('get','/email-deliveries',null)).status,401);
  for(const id of [1,2,4,5,6])assert.equal((await call('get','/email-deliveries',id)).status,403);
  const overview=await call('get','/email-deliveries',3);assert.equal(overview.status,200);assert.ok(!JSON.stringify(overview.body).includes('@example.invalid'));
  assert.equal((await call('get','/billing/invoices',4)).status,403);
  const own=await call('get','/billing/invoices',5);assert.equal(own.status,200);assert.deepEqual(own.body.data.map(i=>i.invoice_id),['INV']);
  assert.equal((await call('get','/billing/invoices',6)).status,403);
  assert.equal((await call('post','/billing/invoices/INV/send-reminder',1,{})).status,403);
  await f.pg.exec("UPDATE invoices SET status='draft' WHERE invoice_id='INV'");
  assert.equal((await call('post','/billing/invoices/INV/send-reminder',3,{})).status,409);
  await f.pg.exec("UPDATE invoices SET status='sent' WHERE invoice_id='INV'");
  const request_id='00000000-0000-4000-8000-000000000001';
  assert.equal((await call('post','/billing/invoices/INV/send-reminder',3,{request_id})).status,202);
  assert.equal((await call('post','/billing/invoices/INV/send-reminder',3,{request_id})).status,202);
  assert.equal((await f.pg.query("SELECT COUNT(*)::int n FROM email_domain_events WHERE action='REMINDER'")).rows[0].n,1);
  assert.equal((await call('post','/billing/invoices/INV/send-reminder',3,{request_id:'bad'})).status,400);
  const life=createLifecycle({pool:f.pool,canStaff:async()=>true,from:'test@example.invalid'});await life.sweep();
  const notice=(await f.pg.query("SELECT * FROM email_outbox WHERE category='activity' AND recipient='owner@example.invalid' LIMIT 1")).rows[0];
  await f.pg.query("UPDATE email_outbox SET status='failed',payload=NULL WHERE id=$1",[notice.id]);
  assert.equal((await call('post','/email-deliveries/'+notice.id+'/retry',5,{})).status,403);
  assert.equal((await call('post','/email-deliveries/'+notice.id+'/retry',3,{})).status,202);
  assert.equal((await call('post','/email-deliveries/'+notice.id+'/retry',3,{})).status,202);
  assert.equal((await f.pg.query("SELECT COUNT(*)::int n FROM email_domain_events WHERE after_values ? 'email_retry_user_id'")).rows[0].n,1);
  await f.pg.exec('UPDATE invoices SET balance_due=0');
  assert.equal((await call('post','/billing/invoices/INV/send-reminder',3,{})).status,409);
  assert.equal((await call('post','/email-deliveries/'+notice.id+'/retry',3,{})).status,409);
  const event=(await f.pg.query("INSERT INTO email_domain_events(entity,entity_key,action,attempts,last_error)VALUES('invoices','INV','UPDATE',5,'processing_failed') RETURNING id")).rows[0];
  assert.equal((await call('post','/email-deliveries/events/'+event.id+'/retry',1,{})).status,403);
  assert.equal((await call('post','/email-deliveries/events/'+event.id+'/retry',3,{})).status,202);
  assert.equal((await call('post','/email-deliveries/events/'+event.id+'/retry',3,{})).status,409);
  await f.pg.query("UPDATE email_domain_events SET attempts=5,created_at=NOW()-INTERVAL '24 hours' WHERE id=$1",[event.id]);
  assert.equal((await call('post','/email-deliveries/events/'+event.id+'/retry',3,{})).status,409);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await f.close();}
});
