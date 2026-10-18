'use strict';
// Explicit controlled-inbox test. Never starts a worker, sweeps the queue,
// modifies accounts, or enables PM2/process-wide production sending.
async function main({args=process.argv.slice(2),env=process.env,output=console.log,load=require}={}){
 if(args.length!==1||args[0]!=='--send'){
  output('No email sent. To authorise ONE controlled test, privately configure EMAIL_TEST_RECIPIENT and run with --send.');
  return;
 }
 const recipient=env.EMAIL_TEST_RECIPIENT;
 if(typeof recipient!=='string'||!/^\S+@\S+\.\S+$/.test(recipient)||/[\r\n,;]/.test(recipient))throw Error('Configure a single private EMAIL_TEST_RECIPIENT first');
 if(!env.RESEND_API_KEY||!env.MAIL_FROM||/@resend\.dev\b/i.test(env.MAIL_FROM))throw Error('Verified production sender and provider key required');
 const pool=load('../config/database');
 try{
  const customer=await pool.query("SELECT 1 FROM users WHERE LOWER(email)=LOWER($1) AND (LOWER(COALESCE(user_type,'')) IN ('client','service_provider') OR LOWER(COALESCE(role,'')) IN ('client','service_provider')) LIMIT 1",[recipient]);
  if(customer.rows.length)throw Error('Use a dedicated test inbox, not a registered customer or provider address');
  // This override is confined to this CLI process. Do not change .env/PM2 flags.
  env.MAIL_OUTBOX_ENABLED='true';
  const mail=load('../utils/mailer');
  const result=await mail.sendEmail({to:recipient,subject:'FlowGuard — controlled email delivery test',
   html:mail.shell('Controlled delivery test','<p>This is an authorised test of FlowGuard email delivery. No customer activity, payment or drainage incident is represented by this message.</p>'),
   text:'Authorised FlowGuard email delivery test. No customer activity, payment or drainage incident is represented.',
   category:'transactional',eventKey:'controlled-test:'+load('node:crypto').randomUUID(),returnReceipt:true});
  output(JSON.stringify({accepted:result.accepted,queued:result.queued,status:result.status,deliveryIds:result.ids||[],durable:result.durable}));
  if(!result.accepted&&!result.queued)throw Error('Controlled email was not accepted or queued');
  output('Acceptance is not inbox delivery. Verify the signed delivery receipt and check the controlled inbox separately.');
 }finally{await pool.end();}
}
const safeErrors=new Set(['Configure a single private EMAIL_TEST_RECIPIENT first','Verified production sender and provider key required','Use a dedicated test inbox, not a registered customer or provider address','Controlled email was not accepted or queued']);
if(require.main===module)main().catch(e=>{console.error('FAIL:',safeErrors.has(e.message)?e.message:'Database or delivery check failed; diagnostic details withheld');process.exitCode=1;});
module.exports={main};
