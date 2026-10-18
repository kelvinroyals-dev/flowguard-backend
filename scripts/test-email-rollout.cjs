const test=require('node:test'),assert=require('node:assert/strict');
const {main}=require('./check-email-delivery.cjs');
test('controlled-inbox CLI defaults to no sending and rejects malformed/multiple recipients',async()=>{
 let loads=0;await main({args:[],output(){},load(){loads++;}});assert.equal(loads,0);
 for(const recipient of ['bad','a@example.invalid,b@example.invalid','a@example.invalid; b@example.invalid','a@example.invalid\r\nBcc:x@example.invalid'])await assert.rejects(main({args:['--send'],env:{EMAIL_TEST_RECIPIENT:recipient},load(){throw Error('must not load');}}),/single private/);
});
test('controlled-inbox CLI refuses registered customer addresses and never changes account data',async()=>{
 let ended=false,queries=[];
 const pool={query:async(s,p)=>{queries.push(s);return {rows:[{exists:1}]};},end:async()=>{ended=true;}};
 await assert.rejects(main({args:['--send'],env:{EMAIL_TEST_RECIPIENT:'fake@example.invalid',RESEND_API_KEY:'synthetic',MAIL_FROM:'sender@example.invalid'},load:n=>{assert.equal(n,'../config/database');return pool;}}),/dedicated test inbox/);
 assert.equal(ended,true);assert.equal(queries.length,1);assert.ok(queries.every(s=>s.startsWith('SELECT')));
});
test('controlled-inbox CLI queues one synthetic notice without starting a worker or exposing its address',async()=>{
 const env={EMAIL_TEST_RECIPIENT:'fake@example.invalid',RESEND_API_KEY:'synthetic',MAIL_FROM:'sender@example.invalid'},lines=[];let sent=0,ended=false;
 await main({args:['--send'],env,output:l=>lines.push(l),load:n=>{
  if(n==='../config/database')return {query:async()=>({rows:[]}),end:async()=>{ended=true;}};
  if(n==='node:crypto')return {randomUUID:()=> 'synthetic-id'};
  if(n==='../utils/mailer')return {shell:(_t,b)=>b,sendEmail:async p=>{sent++;assert.equal(p.to,env.EMAIL_TEST_RECIPIENT);assert.equal(p.returnReceipt,true);assert.equal(env.MAIL_OUTBOX_ENABLED,'true');return {accepted:true,queued:false,status:'accepted',ids:['fake-delivery-id'],durable:true};}};
  throw Error('Unexpected dependency');
 }});
 assert.equal(sent,1);assert.equal(ended,true);assert.ok(!lines.join('').includes(env.EMAIL_TEST_RECIPIENT));assert.ok(!lines.join('').includes(env.RESEND_API_KEY));
});
