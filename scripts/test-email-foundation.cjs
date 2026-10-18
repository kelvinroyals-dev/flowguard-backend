// Disposable PostgreSQL-compatible database + fake provider only. No .env or inbox access.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const {createOutbox}=require('../utils/emailOutbox');
test('durable email retries, deduplication, leases, opt-outs, expiry and truthful invoice state',async()=>{
  const pg=new PGlite();
  const pool={query:(...a)=>pg.query(...a),connect:async()=>({query:(...a)=>pg.query(...a),release(){}})};
  let calls=[],response={accepted:true,providerId:'fake-provider-id'};
  const q=createOutbox({pool,transport:async(p,key)=>{calls.push({p,key});return response;}});
  try{
    await pg.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,user_type TEXT,is_active BOOLEAN,role TEXT,account_owner_id INTEGER,client_role TEXT);
      CREATE TABLE user_preferences(user_id INTEGER PRIMARY KEY,notification_preferences JSONB);
      CREATE TABLE app_settings(id INTEGER PRIMARY KEY,settings JSONB);
      CREATE TABLE invoices(invoice_id VARCHAR(50) PRIMARY KEY,user_id INTEGER DEFAULT 1,sent_at TIMESTAMPTZ,sent_count INTEGER DEFAULT 0,status TEXT,updated_at TIMESTAMPTZ);
      CREATE TABLE properties(property_id TEXT,user_id INTEGER);
      INSERT INTO properties VALUES('ESTATE-A',1);
      INSERT INTO users VALUES(1,'client@example.invalid','client',true,'client',NULL,NULL),(2,'staff@example.invalid','internal',true,'operations_manager',NULL,NULL);
      ALTER TABLE users ADD COLUMN service_provider_org_id INTEGER;
      INSERT INTO user_preferences VALUES(1,'{}'),(2,'{}');
      INSERT INTO app_settings VALUES(1,'{}');INSERT INTO invoices(invoice_id,status)VALUES('INV-TEST','draft');`);
    const migration=fs.readFileSync(path.join(__dirname,'../migrations/2026-10-17-email-outbox.sql'),'utf8');
    await pg.exec(migration);await pg.exec(migration);
    const payload={to:['client@example.invalid'],subject:'Synthetic test',html:'<p>not a real email</p>'};
    let r=await q.send(payload,{eventKey:'invoice-test',invoiceId:'INV-TEST'});
    assert.equal(r.accepted,true);assert.equal(calls.length,1);
    assert.equal((await q.send(payload,{eventKey:'invoice-test',invoiceId:'INV-TEST'})).id,r.id);
    assert.equal(calls.length,1);assert.equal((await pg.query('SELECT sent_count FROM invoices')).rows[0].sent_count,1);
    assert.equal((await pg.query('SELECT payload FROM email_outbox WHERE id=$1',[r.id])).rows[0].payload,null);
    response={accepted:false,retryable:true,error:'provider_http_503'};
    r=await q.send(payload,{eventKey:'retry',invoiceId:'INV-TEST'});assert.equal(r.queued,true);
    assert.equal((await pg.query('SELECT sent_count FROM invoices')).rows[0].sent_count,1);
    await pg.query("UPDATE email_outbox SET next_attempt_at=NOW()-INTERVAL '1 minute' WHERE id=$1",[r.id]);
    response={accepted:true,providerId:'fake-retry'};await q.sweep();
    assert.equal((await q.receipt(r.id)).accepted,true);assert.equal(calls.at(-1).key,calls.at(-2).key);
    assert.equal((await pg.query('SELECT sent_count FROM invoices')).rows[0].sent_count,2);
    response={accepted:false,retryable:true,error:'provider_http_429'};
    r=await q.send(payload,{eventKey:'opt-out-before-retry',category:'digest'});
    await pg.exec(`UPDATE user_preferences SET notification_preferences='{"email_alerts":false}' WHERE user_id=1`);
    await pg.query("UPDATE email_outbox SET next_attempt_at=NOW()-INTERVAL '1 minute' WHERE id=$1",[r.id]);
    const count=calls.length;await q.sweep();assert.equal(calls.length,count);assert.equal((await q.receipt(r.id)).status,'suppressed');
    r=await q.send(payload,{eventKey:'security',category:'security'});assert.equal(r.queued,true);assert.equal(calls.length,count+1);
    await pg.query("UPDATE email_outbox SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[r.id]);await q.sweep();
    assert.equal((await q.receipt(r.id)).status,'expired');
    response={accepted:false,retryable:false,error:'provider_http_403'};
    r=await q.send(payload,{eventKey:'permanent'});assert.equal(r.status,'failed');assert.equal(r.queued,false);
    response={accepted:true,providerId:'fake-concurrent'};
    const pair=await Promise.all([q.send(payload,{eventKey:'concurrent'}),q.send(payload,{eventKey:'concurrent'})]);
    assert.equal(pair[0].id,pair[1].id);assert.equal(calls.filter(c=>c.key==='fg-'+pair[0].id).length,1);
    await pg.exec(`UPDATE user_preferences SET notification_preferences='{}' WHERE user_id=1`);
    response={accepted:false,retryable:true,error:'provider_http_503'};
    r=await q.send(payload,{eventKey:'scoped-brief',category:'briefing',scope:{kind:'client',ownerId:1,propertyIds:['ESTATE-A']}});assert.equal(r.queued,true);
    await pg.exec('UPDATE properties SET user_id=2');
    await pg.query("UPDATE email_outbox SET next_attempt_at=NOW()-INTERVAL '1 minute' WHERE id=$1",[r.id]);
    const scopedCount=calls.length;await q.sweep();assert.equal(calls.length,scopedCount);assert.equal((await q.receipt(r.id)).status,'suppressed');
    assert.equal((await q.send(payload,{category:'briefing',eventKey:'unscoped'})).status,'suppressed');
    r=await q.send(payload,{eventKey:'invoice-owner-change',invoiceId:'INV-TEST',scope:{kind:'invoice',invoiceId:'INV-TEST',ownerId:1}});assert.equal(r.queued,true);
    await pg.exec('UPDATE invoices SET user_id=2');
    await pg.query("UPDATE email_outbox SET next_attempt_at=NOW()-INTERVAL '1 minute' WHERE id=$1",[r.id]);await q.sweep();
    assert.equal((await q.receipt(r.id)).status,'suppressed');
    r=await q.send(payload,{eventKey:'reclaim-lease'});
    await pg.query("UPDATE email_outbox SET status='sending',lease_until=NOW()-INTERVAL '1 minute',next_attempt_at=NOW()-INTERVAL '1 minute' WHERE id=$1",[r.id]);
    response={accepted:true,providerId:'fake-recovered'};await q.sweep();assert.equal((await q.receipt(r.id)).accepted,true);
    response={accepted:false,retryable:true,error:'provider_http_503'};r=await q.send(payload,{eventKey:'attempt-limit'});
    await pg.query("UPDATE email_outbox SET attempts=5,next_attempt_at=NOW()-INTERVAL '1 minute' WHERE id=$1",[r.id]);await q.sweep();
    assert.equal((await q.receipt(r.id)).status,'failed');assert.equal((await pg.query('SELECT payload FROM email_outbox WHERE id=$1',[r.id])).rows[0].payload,null);
    await assert.rejects(q.send({...payload,to:['a@example.invalid','b@example.invalid']}),/Invalid email recipient/);
    const noDb=createOutbox({pool:{query:async()=>{throw Error('offline');}},transport:async()=>{throw Error('must not send');}});
    await assert.rejects(noDb.send(payload,{category:'alert'}),/offline/);
  }finally{await pg.close();}
});
test('invoice endpoint never marks queued or failed email as sent',async()=>{
  const Module=require('node:module'),original=Module._load;let result,updates=0;
  const pool={query:async sql=>{
    if(sql.includes('SELECT i.*'))return {rows:[{invoice_id:'INV-TEST',client_email:'client@example.invalid',total_amount:10,balance_due:10}]};
    if(sql.startsWith('UPDATE invoices'))updates++;
    return {rows:[{sent_at:null,sent_count:0}]};
  }};
  Module._load=function(name,parent,...rest){
    if(name==='../config/database')return pool;
    if(name==='../middleware/auth')return {authenticateToken:(_r,_s,n)=>n(),requireRole:()=> (_r,_s,n)=>n()};
    if(name==='../utils/permissions')return {requirePermission:()=> (_r,_s,n)=>n()};
    if(name==='../utils/scope')return {isClient:()=>false,isSpUser:()=>false};
    if(name==='../utils/audit')return {logAction(){}};
    if(name==='../utils/mailer')return {sendInvoice:async()=>result};
    if(name==='pdfkit')return class {constructor(){throw Error('PDF deliberately unavailable in test');}};
    return original.call(this,name,parent,...rest);
  };
  try{
    const router=require('../routes/billing');
    const handler=router.stack.find(l=>l.route?.path==='/invoices/:id/send').route.stack.at(-1).handle;
    const call=async()=>{const res={code:200,status(c){this.code=c;return this;},json(b){this.body=b;return this;}};await handler({params:{id:'INV-TEST'},body:{},user:{id:1}},res);return res;};
    result={accepted:false,queued:false};assert.equal((await call()).code,503);assert.equal(updates,0);
    result={accepted:false,queued:true,ids:['fake-id']};const r=await call();assert.equal(r.code,202);assert.equal(r.body.data.queued,true);assert.equal(updates,0);
    result={accepted:true,queued:false,durable:false};assert.equal((await call()).code,200);assert.equal(updates,1);
    result={accepted:true,queued:false,durable:true};assert.equal((await call()).code,200);assert.equal(updates,1);
  }finally{Module._load=original;}
});
test('preference route persists first save, merges partial updates and rejects invalid values',async()=>{
  const pg=new PGlite(),Module=require('node:module');
  await pg.exec(`CREATE TABLE user_preferences(user_id INTEGER PRIMARY KEY,notification_preferences JSONB DEFAULT '{}',show_demo_data BOOLEAN,onboarding_completed BOOLEAN,onboarding_step TEXT,onboarding_skipped BOOLEAN,preferred_language TEXT,timezone TEXT,updated_at TIMESTAMPTZ);`);
  const original=Module._load;
  Module._load=function(name,parent,...rest){
    if(name==='../config/database')return {query:(...a)=>pg.query(...a)};
    if(name==='../middleware/auth')return {authenticateToken:(_r,_s,n)=>n()};
    if(name==='../utils/clientPermissions')return {clientRoleInfo:()=>({})};
    return original.call(this,name,parent,...rest);
  };
  let router;try{router=require('../routes/account');}finally{Module._load=original;}
  const call=async(method,body)=>{
    const handler=router.stack.find(l=>l.route?.path==='/preferences'&&l.route.methods[method]).route.stack.at(-1).handle;
    const res={code:200,status(n){this.code=n;return this;},json(v){this.body=v;return this;}};
    await handler({user:{id:1},body},res);return res;
  };
  try{
    let res=await call('put',{email_alerts:false,weekly_digest:false});assert.equal(res.code,200);assert.equal(res.body.data.email_alerts,false);
    assert.equal((await pg.query('SELECT notification_preferences FROM user_preferences')).rows[0].notification_preferences.weekly_digest,false);
    res=await call('put',{notification_preferences:{sms_alerts:true}});assert.equal(res.body.data.email_alerts,false);assert.equal(res.body.data.sms_alerts,true);
    assert.equal((await call('get')).body.data.weekly_digest,false);
    assert.equal((await call('put',{email_alerts:'false'})).code,400);
    assert.equal((await call('put',{notification_preferences:{other:true}})).code,400);
    assert.equal((await call('put',{email_alerts:true,notification_preferences:{email_alerts:false}})).code,400);
  }finally{await pg.close();}
});
test('provider transport uses timeout, safe errors and acceptance receipts without real network',async()=>{
  const vm=require('node:vm');let request;
  const context={module:{exports:{}},exports:{},process:{env:{RESEND_API_KEY:'synthetic-not-a-key'}},console:{warn(){},error(){}},Buffer,AbortSignal,Date,URL,
    require:()=>{throw Error('Unexpected dependency');},fetch:async(url,options)=>{request={url,options};return {ok:true,json:async()=>({id:'fake-receipt'})};}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../utils/mailer.js'),'utf8'),context);
  const mail=context.module.exports;
  assert.equal(await mail.sendEmail({to:'fake@example.invalid',subject:'Test',html:'<p>test</p>'}),true);
  assert.equal(request.url,'https://api.resend.com/emails');assert.equal(request.options.redirect,'error');assert.ok(request.options.signal);
  await mail.sendPropertyReceived('fake@example.invalid','<script>name</script>','<img src=x onerror=alert(1)>','ESTATE');
  let html=JSON.parse(request.options.body).html;assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<img src=x'));assert.ok(!html.includes('<script>'));
  await mail.sendReportNote('fake@example.invalid','Fake','<report>','PRIVATE REVIEW BODY');html=JSON.parse(request.options.body).html;assert.ok(!html.includes('PRIVATE REVIEW BODY'));assert.ok(html.includes('&lt;report&gt;'));
  await assert.rejects(mail.sendPasswordReset('fake@example.invalid','javascript:alert(1)'),/HTTPS/);
  context.fetch=async()=>({ok:false,status:503});
  const r=await mail.sendEmail({to:'fake@example.invalid',subject:'Test',html:'test',returnReceipt:true});assert.equal(r.accepted,false);assert.equal(r.status,'failed');
});
