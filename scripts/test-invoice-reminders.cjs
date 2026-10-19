// No .env, inboxes or production database. Invoice guard + real SQL in PGlite.
const test=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {eligible}=require('../utils/invoiceReminder');
const {reminderStillApplies}=require('../utils/emailDomainPolicy');
test('invoice reminders require actual issuance, an active owner and a reconciled same-currency ledger',async()=>{
 const pg=new PGlite();
 try{
  await pg.exec(`CREATE TABLE users(id INTEGER,user_type TEXT,role TEXT,account_owner_id INTEGER,service_provider_org_id INTEGER,is_active BOOLEAN);
   CREATE TABLE payments(invoice_id TEXT,status TEXT,amount NUMERIC,currency TEXT);
   INSERT INTO users VALUES(1,'client','client',NULL,NULL,TRUE);`);
  const invoice={invoice_id:'SYNTHETIC',user_id:1,status:'sent',payment_status:'pending',sent_at:new Date(Date.now()-86400000),sent_count:1,total_amount:100,amount_paid:0,balance_due:100,currency:'NGN',due_date:new Date(Date.now()-86400000)};
  assert.equal(await eligible(pg,invoice),true);
  for(const patch of [{status:'draft'},{status:'void'},{status:'cancelled'},{status:'paid'},{status:'unknown'},{sent_at:null},{sent_at:new Date(Date.now()+86400000)},{sent_count:0},{user_id:null},{user_id:99},{currency:null},{currency:'bad'},{total_amount:null},{amount_paid:null},{balance_due:null},{balance_due:0},{payment_status:'paid'},{amount_paid:20},{balance_due:80}])assert.equal(await eligible(pg,{...invoice,...patch}),false,JSON.stringify(patch));
  await pg.exec("INSERT INTO payments VALUES('SYNTHETIC','successful',20,'NGN')");
  const partial={...invoice,amount_paid:20,balance_due:80,payment_status:'partial'};
  assert.equal(await eligible(pg,partial),true);
  await pg.exec("UPDATE payments SET currency='USD'");assert.equal(await eligible(pg,partial),false);
  await pg.exec("UPDATE payments SET currency='NGN',amount=100");
  assert.equal(await eligible(pg,partial),false);
  assert.equal(await reminderStillApplies(pg,{after_values:{notification_type:'invoice_overdue'}},{row:partial}),false,'payment after enqueue suppresses the stale reminder');
  await pg.exec("UPDATE payments SET amount=20;UPDATE users SET is_active=FALSE");assert.equal(await eligible(pg,partial),false);
  await pg.exec("UPDATE users SET is_active=TRUE,account_owner_id=2");assert.equal(await eligible(pg,partial),false);
  await pg.exec("UPDATE users SET account_owner_id=NULL,service_provider_org_id=10");assert.equal(await eligible(pg,partial),false);
 }finally{await pg.close();}
});
