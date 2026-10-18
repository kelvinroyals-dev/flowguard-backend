// Date/status reminders are notices, never dispatch/payment/SLA adjudication.
const wat=d=>new Date(d+3600000).toISOString().slice(0,10);
function createSchedules({pool,now=()=>Date.now()}){
 async function record(db,entity,key,type,bucket,values={}){
  const name=[entity,entity==='ingest_errors'?values.sensor_id:key,type,bucket].join(':');
  const inserted=await db.query('INSERT INTO email_schedule_keys(key) VALUES($1) ON CONFLICT(key) DO NOTHING RETURNING key',[name]);
  if(inserted.rows.length)await db.query("INSERT INTO email_domain_events(entity,entity_key,action,after_values)VALUES($1,$2,'REMINDER',$3)",[entity,String(key),JSON.stringify({...values,notification_type:type})]);
 }
 async function sweep(){
  const stamp=now(),day=wat(stamp),hour=new Date(stamp+3600000).toISOString().slice(0,13),db=await pool.connect();
  try{
   await db.query('BEGIN');await db.query("SET LOCAL TIME ZONE 'Africa/Lagos'");await db.query('SELECT pg_advisory_xact_lock(7142317)');
   for(const i of(await db.query("SELECT invoice_id,due_date FROM invoices WHERE balance_due>0 AND due_date IS NOT NULL AND due_date<=CURRENT_DATE+3")).rows)await record(db,'invoices',i.invoice_id,new Date(i.due_date).toISOString().slice(0,10)<day?'invoice_overdue':'invoice_due',day);
   for(const j of(await db.query("SELECT id,status,scheduled_for,sla_due_at,dispatched_at FROM jobs WHERE status NOT IN ('verified','completed','cancelled','declined','draft')")).rows){
    if(j.scheduled_for&&new Date(j.scheduled_for).getTime()>=stamp&&new Date(j.scheduled_for).getTime()<=stamp+24*3600000)await record(db,'jobs',j.id,'visit_due',day);
    if(j.status==='dispatched'&&j.dispatched_at&&stamp-new Date(j.dispatched_at).getTime()>=3600000)await record(db,'jobs',j.id,'acceptance_overdue',day);
    if(j.sla_due_at&&new Date(j.sla_due_at).getTime()<stamp+3600000)await record(db,'jobs',j.id,new Date(j.sla_due_at).getTime()<stamp?'sla_breach':'sla_warning',day);
   }
   for(const t of(await db.query(`SELECT t.ticket_id FROM tickets t WHERE t.status NOT IN ('resolved','closed','cancelled') AND t.work_type IS NULL AND t.assigned_team IS NULL
     AND GREATEST(t.created_at,COALESCE((SELECT MAX(created_at) FROM ticket_messages m WHERE m.ticket_id=t.ticket_id AND m.author_type='client'),t.created_at))<NOW()-INTERVAL '24 hours'
     AND NOT EXISTS(SELECT 1 FROM ticket_messages m WHERE m.ticket_id=t.ticket_id AND m.author_type='support'
       AND m.created_at>=GREATEST(t.created_at,COALESCE((SELECT MAX(created_at) FROM ticket_messages x WHERE x.ticket_id=t.ticket_id AND x.author_type='client'),t.created_at)))`)).rows)await record(db,'tickets',t.ticket_id,'support_waiting',day);
   for(const r of(await db.query("SELECT report_id FROM inspection_reports WHERE status='review' AND updated_at<NOW()-INTERVAL '48 hours'")).rows)await record(db,'inspection_reports',r.report_id,'report_waiting',day);
   for(const p of(await db.query('SELECT id FROM service_plans WHERE active=TRUE AND next_due<=CURRENT_DATE')).rows)await record(db,'service_plans',p.id,'maintenance_due',day);
   for(const a of(await db.query("SELECT alert_id FROM alerts WHERE severity='critical' AND status='active' AND assigned_team_id IS NULL AND created_at<NOW()-INTERVAL '15 minutes'")).rows)await record(db,'alerts',a.alert_id,'incident_waiting',hour);
   for(const e of(await db.query("SELECT sensor_id,MIN(id)::text AS id FROM ingest_errors WHERE occurred_at>NOW()-INTERVAL '1 hour' GROUP BY sensor_id HAVING COUNT(*)>=3")).rows)await record(db,'ingest_errors',e.id,'ingest_failures',hour+':'+e.sensor_id,{sensor_id:e.sensor_id});
   // Only explicitly configured, hardware-appropriate voltage thresholds.
   const thresholds=(await db.query('SELECT settings FROM app_settings WHERE id=1')).rows[0]?.settings?.email_battery_voltage_by_driver||{};
   for(const s of(await db.query("SELECT sensor_id,battery_voltage,driver_id FROM sensors WHERE status='active' AND last_ping BETWEEN NOW()-INTERVAL '30 minutes' AND NOW()")).rows){const threshold=thresholds[s.driver_id];if(typeof threshold==='number'&&Number.isFinite(threshold)&&threshold>0&&s.battery_voltage!=null&&Number(s.battery_voltage)<threshold)await record(db,'sensors',s.sensor_id,'battery_low',day);}
   const shifted=new Date(stamp+3600000),weekday=shifted.getUTCDay(),monday=new Date(shifted);monday.setUTCDate(monday.getUTCDate()-((weekday+6)%7));
   const week=monday.toISOString().slice(0,10);
   if(weekday!==1||shifted.getUTCHours()>=6){
    for(const u of(await db.query('SELECT id,account_owner_id,service_provider_org_id FROM users WHERE is_active=TRUE')).rows){
     const name='weekly:'+week+':'+u.id;
     if((await db.query('INSERT INTO email_schedule_keys(key) VALUES($1) ON CONFLICT(key) DO NOTHING RETURNING key',[name])).rows.length)await db.query("INSERT INTO email_domain_events(entity,entity_key,action,after_values)VALUES('users',$1,'DIGEST',$2)",[String(u.id),JSON.stringify({account_owner_id:u.account_owner_id,service_provider_org_id:u.service_provider_org_id})]);
    }
   }
   // Quota/delivery failures surface to administrators without emailing each failure.
   const failures=(await db.query(`SELECT 1 WHERE EXISTS(SELECT 1 FROM email_outbox WHERE status IN ('failed','expired') AND created_at>NOW()-INTERVAL '1 day')
     OR EXISTS(SELECT 1 FROM email_domain_events WHERE processed_at IS NULL AND attempts>=5)
     OR EXISTS(SELECT 1 FROM email_worker_health WHERE worker<>'weather' AND error_code IS NOT NULL AND last_failure_at>NOW()-INTERVAL '30 minutes')`)).rows.length;
   if(failures)for(const admin of(await db.query("SELECT id FROM users WHERE user_type='internal' AND role IN ('admin','super_admin') AND is_active=TRUE")).rows)await record(db,'users',admin.id,'email_failure',day);
   const weather=(await db.query("SELECT 1 FROM email_worker_health WHERE worker='weather' AND error_code IS NOT NULL AND last_failure_at>NOW()-INTERVAL '30 minutes'")).rows.length;
   if(weather)for(const u of(await db.query("SELECT id FROM users WHERE user_type='internal' AND role IN ('admin','super_admin') AND is_active=TRUE")).rows)await record(db,'users',u.id,'weather_unavailable',day);
   await db.query('COMMIT');
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }
 return {sweep,record};
}
function start(){
 if(process.env.EMAIL_SCHEDULES_ENABLED!=='true'||process.env.LIFECYCLE_EMAILS_ENABLED!=='true'||process.env.MAIL_OUTBOX_ENABLED!=='true'||!process.env.RESEND_API_KEY||!process.env.MAIL_FROM||/@resend\.dev\b/i.test(process.env.MAIL_FROM))return;
 const service=createSchedules({pool:require('../config/database')});let busy=false;
 const tick=async()=>{if(busy)return;busy=true;try{await service.sweep();await require('./emailHealth').safely(require('../config/database'),'schedules',true);}catch(_){await require('./emailHealth').safely(require('../config/database'),'schedules',false);console.error('[emailSchedules] Sweep failed; check schema/readiness.');}finally{busy=false;}};
 const timer=setInterval(tick,300000);timer.unref();tick();
}
module.exports={createSchedules,wat,start};
