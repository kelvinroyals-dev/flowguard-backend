const {clientCan}=require('./clientPermissions');
const SOURCES={service_requests:'id',service_request_events:'id',jobs:'id',job_comments:'id',tickets:'ticket_id',ticket_messages:'id',inspection_reports:'report_id',service_provider_organisations:'id',users:'id',payments:'payment_id',invoices:'invoice_id',service_plans:'id',device_events:'id',device_integrity_events:'id',ingest_errors:'id',sla_tracking:'id',alerts:'alert_id',sensors:'sensor_id'};
const MODULES={service_requests:'jobs',service_request_events:'jobs',jobs:'jobs',job_comments:'jobs',tickets:'support',ticket_messages:'support',inspection_reports:'field-reports',service_provider_organisations:'providers',users:'team-members',payments:'billing',invoices:'billing',service_plans:'maintenance',device_events:'devices',device_integrity_events:'devices',ingest_errors:'devices',sla_tracking:'sla',alerts:'alerts',sensors:'devices'};
async function reminderStillApplies(db,e,c,now=Date.now()){
 const r=c.row,t=e.after_values.notification_type,at=v=>v?new Date(v).getTime():NaN,day=new Date(now+3600000).toISOString().slice(0,10);
 if(t.startsWith('invoice_'))return Number(r.balance_due)>0&&(t==='invoice_reminder'||Number.isFinite(at(r.due_date))&&(t==='invoice_overdue'?new Date(r.due_date).toISOString().slice(0,10)<day:at(r.due_date)<=now+3*86400000));
 if(['visit_due','acceptance_overdue','sla_warning','sla_breach'].includes(t)){
  if(['verified','completed','cancelled','declined','draft'].includes(r.status))return false;
  if(t==='visit_due')return at(r.scheduled_for)>=now&&at(r.scheduled_for)<=now+86400000;
  if(t==='acceptance_overdue')return r.status==='dispatched'&&now-at(r.dispatched_at)>=3600000;
  return Number.isFinite(at(r.sla_due_at))&&(t==='sla_breach'?at(r.sla_due_at)<now:at(r.sla_due_at)>=now&&at(r.sla_due_at)<=now+3600000);
 }
 if(t==='maintenance_due')return r.active&&Number.isFinite(at(r.next_due))&&new Date(r.next_due).toISOString().slice(0,10)<=day;
 if(t==='incident_waiting')return r.status==='active'&&r.severity==='critical'&&!r.assigned_team_id&&now-at(r.created_at)>=900000;
 if(t==='report_waiting')return r.status==='review'&&now-at(r.updated_at)>=48*3600000;
 if(t==='support_waiting')return !['resolved','closed','cancelled'].includes(r.status)&&!r.work_type&&!r.assigned_team&&(await db.query(`SELECT 1 FROM tickets t WHERE ticket_id=$1
   AND GREATEST(t.created_at,COALESCE((SELECT MAX(created_at) FROM ticket_messages m WHERE m.ticket_id=t.ticket_id AND m.author_type='client'),t.created_at))<NOW()-INTERVAL '24 hours'
   AND NOT EXISTS(SELECT 1 FROM ticket_messages m WHERE m.ticket_id=t.ticket_id AND m.author_type='support' AND m.created_at>=GREATEST(t.created_at,COALESCE((SELECT MAX(created_at) FROM ticket_messages x WHERE x.ticket_id=t.ticket_id AND x.author_type='client'),t.created_at)))`,[r.ticket_id])).rows.length>0;
 if(t==='ingest_failures')return (await db.query("SELECT COUNT(*)::int AS n FROM ingest_errors WHERE sensor_id=$1 AND occurred_at>NOW()-INTERVAL '1 hour'",[r.sensor_id])).rows[0].n>=3;
 if(t==='battery_low'){
  const settings=(await db.query('SELECT settings FROM app_settings WHERE id=1')).rows[0]?.settings||{},limit=settings.email_battery_voltage_by_driver?.[r.driver_id];
  return r.status==='active'&&now-at(r.last_ping)>=0&&now-at(r.last_ping)<=1800000&&typeof limit==='number'&&limit>0&&r.battery_voltage!=null&&Number(r.battery_voltage)<limit;
 }
 if(t==='email_failure')return (await db.query(`SELECT 1 WHERE EXISTS(SELECT 1 FROM email_outbox WHERE status IN ('failed','expired') AND created_at>NOW()-INTERVAL '1 day')
   OR EXISTS(SELECT 1 FROM email_domain_events WHERE processed_at IS NULL AND attempts>=5)
   OR EXISTS(SELECT 1 FROM email_worker_health WHERE worker<>'weather' AND error_code IS NOT NULL AND last_failure_at>NOW()-INTERVAL '30 minutes')`)).rows.length>0;
 if(t==='weather_unavailable')return (await db.query("SELECT 1 FROM email_worker_health WHERE worker='weather' AND error_code IS NOT NULL AND last_failure_at>NOW()-INTERVAL '30 minutes'")).rows.length>0;
 return false; // Unknown reminder types must never become sendable by default.
}
async function context(db,entity,key){
 if(!SOURCES[entity])return null;
 const row=(await db.query(`SELECT * FROM ${entity} WHERE ${SOURCES[entity]}=$1`,[key])).rows[0];if(!row)return null;
 let parent=row,kind=entity;
 if(entity==='service_request_events'){parent=(await db.query('SELECT * FROM service_requests WHERE id=$1',[row.request_id])).rows[0];kind='service_requests';}
 if(entity==='job_comments'){parent=(await db.query('SELECT * FROM jobs WHERE id=$1',[row.job_id])).rows[0];kind='jobs';}
 if(entity==='ticket_messages'){parent=(await db.query('SELECT * FROM tickets WHERE ticket_id=$1',[row.ticket_id])).rows[0];kind='tickets';}
 if(entity==='payments'){parent=(await db.query('SELECT * FROM invoices WHERE invoice_id=$1',[row.invoice_id])).rows[0];kind='invoices';}
 if(['device_events','device_integrity_events','ingest_errors','alerts'].includes(entity)&&!row.property_id&&row.sensor_id){parent=(await db.query('SELECT * FROM sensors WHERE sensor_id=$1',[row.sensor_id])).rows[0];}
 if(!parent)return null;
 let estate=null;
 if(parent.property_id)estate=(await db.query(`SELECT cp.* FROM properties p JOIN properties cp ON cp.property_id=COALESCE(p.parent_property_id,p.property_id) WHERE p.property_id=$1 AND cp.parent_property_id IS NULL`,[parent.property_id])).rows[0];
 return {row,parent,kind,estate,orgId:parent.service_provider_org_id||(entity==='service_provider_organisations'?row.id:null)};
}
async function canReceive(db,recipient,scope,canStaff){
 const e=(await db.query('SELECT * FROM email_domain_events WHERE id=$1',[scope.eventId])).rows[0];
 if(!e)return false;
 const before=e.before_values||{},after=e.after_values||{},v=e.action==='DELETE'?before:after;
 if(scope.audience==='security')return e.entity==='users'&&[before.email,after.email].filter(Boolean).some(s=>s.toLowerCase()===recipient.toLowerCase());
 const u=(await db.query('SELECT * FROM users WHERE id=$1 AND LOWER(email)=LOWER($2) AND is_active=TRUE',[scope.userId,recipient])).rows[0];if(!u)return false;
 if(e.action==='DIGEST'){
  if(String(u.id)!==String(e.entity_key)||String(u.account_owner_id||'')!==String(v.account_owner_id||'')||String(u.service_provider_org_id||'')!==String(v.service_provider_org_id||''))return false;
  if(u.user_type==='client'){
   if(!clientCan(u,'view_monitoring'))return false;
   if(scope.propertyIds){const current=(await db.query('SELECT property_id FROM properties WHERE user_id=$1 AND parent_property_id IS NULL',[u.account_owner_id||u.id])).rows.map(p=>p.property_id);if(!scope.propertyIds.every(id=>current.includes(id)))return false;}
   return true;
  }
  if(u.user_type==='internal')return !u.service_provider_org_id&&await canStaff(u.role,'properties.view')&&await canStaff(u.role,'alerts.view');
  if(u.user_type==='service_provider')return (await db.query("SELECT 1 FROM service_provider_organisations WHERE id=$1 AND status='active'",[u.service_provider_org_id])).rows.length>0;
  return false;
 }
 const c=await context(db,e.entity,e.entity_key);if(!c)return false;
 if(e.action==='REMINDER'&&!await reminderStillApplies(db,e,c))return false;
 if(scope.expectedStatus&&c.parent.status!==scope.expectedStatus)return false;
 if(scope.audience==='ops')return u.user_type==='internal'&&!u.service_provider_org_id&&(!['email_failure','weather_unavailable'].includes(v.notification_type)||['admin','super_admin'].includes(u.role))&&await canStaff(u.role,(MODULES[e.entity]||'administration')+'.view');
 if(scope.audience==='provider'){
  if(u.user_type!=='service_provider'||!c.orgId||String(u.service_provider_org_id)!==String(c.orgId))return false;
  const org=(await db.query('SELECT status FROM service_provider_organisations WHERE id=$1',[c.orgId])).rows[0];
  return !!org&&(e.entity==='service_provider_organisations'||e.entity==='users'||org.status==='active');
 }
 if(scope.audience==='client'){
  if(u.user_type!=='client'||u.service_provider_org_id)return false;
  if(c.kind==='tickets')return String(c.parent.user_id)===String(u.id); // same boundary as ticket API
  if(c.kind==='invoices')return String(c.parent.user_id)===String(u.account_owner_id||u.id)&&clientCan(u,'view_billing');
  if(e.entity==='inspection_reports'&&!['approved','sent_to_client'].includes(c.row.status))return false;
  if(c.kind==='jobs'&&!(await db.query('SELECT 1 FROM service_requests WHERE job_id=$1',[c.parent.id])).rows.length)return false;
  return !!c.estate&&String(c.estate.user_id)===String(u.account_owner_id||u.id)&&clientCan(u,e.entity==='inspection_reports'?'view_reports':'view_monitoring');
 }
 return false;
}
module.exports={SOURCES,MODULES,context,canReceive,reminderStillApplies};
