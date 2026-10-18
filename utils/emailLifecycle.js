const {createOutbox}=require('./emailOutbox');
const {context,canReceive}=require('./emailDomainPolicy');
const {shell}=require('./mailer');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function plan(e){
 const a=e.after_values||{},b=e.before_values||{},insert=e.action==='INSERT',change=k=>a[k]!==b[k];
 const event=(title,audiences,category='activity',note='Review the recorded update in your portal.')=>({title,audiences,category,note});
 if(e.action==='REMINDER'){
  const types={invoice_due:['Invoice due soon',['client','ops']],invoice_overdue:['Invoice overdue',['client','ops']],invoice_reminder:['Invoice payment reminder',['client']],visit_due:['Upcoming scheduled visit',['client','provider','ops']],acceptance_overdue:['Provider acceptance overdue',['provider','ops']],sla_warning:['Work-order deadline approaching',['provider','ops']],sla_breach:['Work-order deadline exceeded',['provider','ops']],support_waiting:['Support request awaiting response',['ops']],report_waiting:['Report awaiting approval',['ops']],maintenance_due:['Maintenance plan due',['ops']],incident_waiting:['Critical incident awaiting acknowledgement',['ops']],ingest_failures:['Repeated device ingestion failures',['ops']],battery_low:['Device battery below configured voltage threshold',['ops']],weather_unavailable:['Weather input unavailable',['ops']],email_failure:['Email delivery needs attention',['ops']]};
  const type=types[a.notification_type];return type?event(type[0],type[1],'activity','This is a reminder based on recorded dates or status. It does not confirm attendance, payment or contractual liability.'):null;
 }
 if(e.action==='DIGEST')return event('Your weekly FlowGuard update',['client','ops','provider'],'digest','A current, access-scoped overview is ready. Missing data is not proof of healthy drainage.');
 switch(e.entity){
 case 'service_requests':
  if(insert)return event('Service request received',a.route==='direct_provider'?['client','provider']:['client','ops'],'activity',a.route==='direct_provider'?'Sent to your selected provider. Provider progress is not FlowGuard verification.':'Your request was received. A visit is not confirmed until scheduled.');
  if(change('status')||change('job_id'))return event('Service request updated',['client','ops']);break;
 case 'service_request_events':if(insert)return event('Provider reported service progress',['client'],'activity','This is provider-reported progress, not FlowGuard approval or verification.');break;
 case 'jobs':
  if(insert&&a.status==='draft')return null;
  if(insert||change('status')||change('scheduled_for')||change('assigned_technician_id')||change('service_provider_org_id'))return event(a.status==='completed'?'Work completed — verification pending':a.status==='verified'?'Work verified':a.status==='cancelled'?'Work cancelled':a.status==='declined'?'Provider declined work':change('scheduled_for')?'Visit schedule updated':a.status==='dispatched'?'New work dispatched':'Work order updated',['ops','provider','client'],'activity',a.status==='completed'?'The provider recorded completion. FlowGuard verification is still pending.':'Review the current work-order status and schedule in your portal.');break;
 case 'job_comments':if(insert)return event('New work-order message',a.author_type==='internal'?['provider']:['ops']);break;
 case 'tickets':if(insert)return event(['payment','billing'].includes(a.category)?'Payment reported — reconciliation required':'Support request received',['client','ops']);if(change('status'))return event(['resolved','closed'].includes(a.status)?'Support request resolved':'Support request reopened or updated',['client','ops']);break;
 case 'ticket_messages':if(insert)return event('New support reply',a.author_type==='client'?['ops']:['client']);break;
 case 'inspection_reports':if(a.status==='draft')return null;if(insert||change('status'))return event(a.status==='rejected'?'Report requires correction':a.status==='review'?'Report awaiting approval':'Report review updated',['ops']);break;
 case 'service_provider_organisations':if(insert)return event('Provider application received',['provider','ops']);if(change('verification_submitted_at'))return event('Provider application submitted for review',['ops']);if(change('status')&&a.status==='suspended')return event('Provider account suspended',['provider','ops'],'transactional');break;
 case 'users':
  if(e.action==='DELETE'||a.password_changed||a.locked_until&&change('locked_until')||!insert&&['is_active','role','user_type','account_owner_id','client_role','sp_role','email','service_provider_org_id'].some(change))return event(e.action==='DELETE'?'Account removed':a.password_changed?'Your password was changed':a.locked_until&&change('locked_until')?'Sign-in temporarily locked':change('email')?'Your sign-in email was changed':'Account access changed',['security'],'security','If you did not expect this change, contact FlowGuard support. No password or sign-in token is included in this email.');break;
 case 'payments':if(a.status==='successful'&&(insert||b.status!=='successful'))return event('Payment recorded',['client','ops'],'transactional','A successful payment was recorded in the ledger. Review the invoice for the current balance; this is not an independent bank confirmation.');break;
 case 'service_plans':if(insert||change('active')||change('next_due'))return event('Maintenance plan updated',['ops']);break;
 case 'device_events':if(insert)return event('Device activity recorded',['ops'],'activity','A maintenance or diagnostic event was recorded. Review the device timeline for details.');break;
 case 'device_integrity_events':if(insert)return event(['tamper_raised','clock_drift','geofence_breach'].includes(a.kind)?'Device integrity requires review':'Device integrity updated',['ops']);break;
 case 'ingest_errors':return null; // aggregated by reminders, never mail each rejected payload
 case 'sla_tracking':if(Number(a.breach_count)>Number(b.breach_count||0))return event('Recorded SLA breach requires review',['ops']);break;
 case 'alerts':if(!insert&&change('backup_requested_at')&&a.backup_requested_at)return event('Field team requested backup',['ops']);if(!insert&&(change('assigned_team_id')))return event('Incident assignment updated',['ops']);break;
 case 'sensors':if(!insert&&(change('lifecycle_state')||change('status')))return event('Device status changed',['ops']);break;
 }
 return null;
}
function createLifecycle({pool,canStaff,from,now=()=>Date.now()}){
 async function process(e,db){
  const p=plan(e);if(!p)return;
  const q=createOutbox({pool:db,canStaff,transport:async()=>{throw Error('enqueue only');}});
  if(p.audiences.includes('security')){
   for(const email of new Set([e.before_values?.email,e.after_values?.email].filter(Boolean)))await emit(email,{kind:'domain',eventId:e.id,audience:'security'},p,q,e);
   return;
  }
  const c=await context(db,e.entity,e.entity_key);if(!c)return;
  const users=(await db.query(e.action==='DIGEST'?'SELECT * FROM users WHERE is_active=TRUE AND id=$1':'SELECT * FROM users WHERE is_active=TRUE',e.action==='DIGEST'?[e.entity_key]:[])).rows;
  for(const u of users){
   const audience=u.user_type==='internal'?'ops':u.user_type==='service_provider'?'provider':'client';
   if(!p.audiences.includes(audience)||!u.email)continue;
   // No speculative estate job visibility: client follows linked service request
   // or their own support ticket, not the provider-only jobs API.
   if(e.after_values?.email_retry_user_id&&String(e.after_values.email_retry_user_id)!==String(u.id))continue;
   if(audience==='client'&&['jobs','job_comments'].includes(e.entity)){
    const request=(await db.query('SELECT * FROM service_requests WHERE job_id=$1',[c.parent.id])).rows[0];
    if(!request)continue;
    // Use request ownership for delivery, while retaining original event identity.
    if(!c.estate||String(c.estate.user_id)!==String(u.account_owner_id||u.id))continue;
   }
   const scope={kind:'domain',eventId:e.id,audience,userId:u.id,expectedStatus:['jobs','tickets','service_requests','service_provider_organisations'].includes(e.entity)?e.after_values?.status:e.entity==='service_request_events'?e.after_values?.event_type:null};
   if(!await canReceive(db,u.email,scope,canStaff))continue;
   let message=p;
   if(e.action==='DIGEST'){
     if(audience==='client')scope.propertyIds=(await db.query('SELECT property_id FROM properties WHERE parent_property_id IS NULL AND user_id=$1',[u.account_owner_id||u.id])).rows.map(p=>p.property_id);
     const counts=audience==='client'?(await db.query('SELECT COUNT(*)::int AS n FROM properties WHERE parent_property_id IS NULL AND user_id=$1',[u.account_owner_id||u.id])).rows[0]:audience==='provider'?(await db.query('SELECT COUNT(*)::int AS n FROM jobs WHERE service_provider_org_id=$1 AND status NOT IN (\'verified\',\'cancelled\',\'declined\')',[u.service_provider_org_id])).rows[0]:(await db.query('SELECT COUNT(*)::int AS n FROM properties WHERE parent_property_id IS NULL')).rows[0];
     message={...p,note:counts.n+' '+(audience==='provider'?'current open work orders':'currently linked estates')+'. Open the portal for current incidents, reports and service activity. This is a current snapshot, not a historical performance or flood-safety certification.'};
   }
   await emit(u.email,scope,message,q,e);
  }
 }
 async function emit(to,scope,p,q,e){
  const ref=e.entity_key;
  const section=scope.audience==='client'?(e.entity==='payments'||e.entity==='invoices'?'billing':e.entity.startsWith('ticket')?'ticket/'+encodeURIComponent(e.entity==='ticket_messages'?e.after_values.ticket_id:ref):'services'):scope.audience==='provider'?(e.entity==='service_requests'?'requests':e.entity==='service_provider_organisations'?'profile':'jobs'):'settings';
  const query=e.entity==='service_requests'?'?service_view=requests':e.entity==='service_plans'?'?service_view=plans':'';
  const url=scope.audience==='ops'?'https://neon.flowguard.ng/index.html'+query+'#'+({tickets:'support',ticket_messages:'support',payments:'billing',invoices:'billing',inspection_reports:'field-reports',service_provider_organisations:'providers',jobs:'jobs',job_comments:'jobs',service_requests:'jobs',service_plans:'jobs',alerts:'alerts',sensors:'sensors',device_events:'sensors',device_integrity_events:'sensors',ingest_errors:'sensors',sla_tracking:'sla'}[e.entity]||'settings'):'https://app.flowguard.ng/'+(scope.audience==='provider'?'field/':'')+'#'+section;
  const details=`${p.note} Reference: ${ref}. Recorded ${new Date(e.created_at).toLocaleString('en-GB',{timeZone:'Africa/Lagos'})} WAT.`;
  await q.enqueue({from,to:[to],subject:p.title,html:shell(p.title,`<p style="line-height:1.6;color:#4a626d">${esc(details)}</p><p><a href="${url}" style="color:#0891b2">Review in FlowGuard →</a></p>`,'You received a notification about activity or access associated with FlowGuard.'),text:details+' '+url},{category:p.category,eventKey:'domain:'+e.id,scope,reminderInvoiceId:scope.audience==='client'&&e.action==='REMINDER'&&e.entity==='invoices'?e.entity_key:null,expiresAt:new Date(now()+23*3600000)});
 }
 async function sweep(){
  for(let n=0;n<50;n++){
   const db=await pool.connect();let e;
   try{await db.query('BEGIN');e=(await db.query('SELECT * FROM email_domain_events WHERE processed_at IS NULL AND attempts<5 AND retry_at<=NOW() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1')).rows[0];
    if(!e){await db.query('COMMIT');break;}
    if(now()-new Date(e.created_at).getTime()<23*3600000)await process(e,db);
    await db.query('UPDATE email_domain_events SET processed_at=NOW(),last_error=NULL WHERE id=$1',[e.id]);await db.query('COMMIT');
   }catch(err){await db.query('ROLLBACK');if(e)await pool.query("UPDATE email_domain_events SET last_error='processing_failed',attempts=attempts+1,retry_at=NOW()+INTERVAL '5 minutes' WHERE id=$1",[e.id]);else throw err;}finally{db.release();}
  }
 }
 return {sweep,process};
}
function start(){
 if(process.env.LIFECYCLE_EMAILS_ENABLED!=='true')return;
 if(process.env.MAIL_OUTBOX_ENABLED!=='true'||!process.env.RESEND_API_KEY||!process.env.MAIL_FROM||/@resend\.dev\b/i.test(process.env.MAIL_FROM)){console.error('[emailLifecycle] Configured outbox and production sender required.');return;}
 const service=createLifecycle({pool:require('../config/database'),canStaff:require('./permissions').hasPermission,from:`${process.env.MAIL_FROM_NAME||'FlowGuard'} <${process.env.MAIL_FROM}>`});
 let busy=false;const tick=async()=>{if(busy)return;busy=true;try{await service.sweep();const failed=(await require('../config/database').query('SELECT 1 FROM email_domain_events WHERE processed_at IS NULL AND last_error IS NOT NULL LIMIT 1')).rows.length;await require('./emailHealth').safely(require('../config/database'),'lifecycle',!failed);}catch(_){await require('./emailHealth').safely(require('../config/database'),'lifecycle',false);console.error('[emailLifecycle] Processing failed; inspect domain event records.');}finally{busy=false;}};const timer=setInterval(tick,30000);timer.unref();tick();
}
module.exports={plan,createLifecycle,start};
