// Observes recorded incidents and coverage transitions. Does not confirm flooding.
// Opt-in only. State transition and outbox insert share one database transaction.
const {createOutbox}=require('./emailOutbox');
const {clientCan}=require('./clientPermissions');
const {shell}=require('./mailer');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const resolved=s=>['resolved','closed'].includes(s);
const significant=s=>['high','critical'].includes(s);
function alertTransition(previous,current,isNew){
  if(resolved(current.status))return previous&&!resolved(previous.status)&&(previous.notified||significant(previous.severity))?'resolved':null;
  if(!significant(current.severity))return null;
  if(!previous)return isNew?'opened':null;
  if(resolved(previous.status))return 'reopened';
  if(!significant(previous.severity))return 'opened';
  return previous.severity!=='critical'&&current.severity==='critical'?'escalated':null;
}
function coverage(rows,now=Date.now()){
  const eligible=rows.filter(r=>r.status==='active'&&r.last_ping);
  const age=t=>{const n=new Date(t).getTime();return Number.isFinite(n)&&n<=now?(now-n)/60000:Infinity;};
  const healthy=eligible.filter(r=>age(r.last_ping)<=360&&age(r.reading_time)<=30&&['number','string'].includes(typeof r.level)&&String(r.level).trim()!==''&&Number.isFinite(Number(r.level))&&Number(r.level)>=0&&Number(r.level)<=100).length;
  return {healthy,total:eligible.length};
}
function coverageTransition(previous,current){
  if(!previous||!previous.total||!current.total)return null;
  if(current.healthy<previous.healthy)return current.healthy===0?'lost':'reduced';
  if(current.healthy>previous.healthy)return current.healthy===current.total?'restored':'improved';
  return null;
}
function createOperationalEmails({pool,canStaff,from='FlowGuard <onboarding@resend.dev>',now=()=>Date.now()}){
  async function recipients(db,propertyId,eventKind){
    const found=[];
    const staff=(await db.query(`SELECT id,email,role FROM users WHERE user_type='internal' AND service_provider_org_id IS NULL AND is_active=TRUE AND role=ANY($1::text[])`,[['admin','super_admin','operations_manager','dispatcher']])).rows;
    for(const u of staff)if(u.email&&await canStaff(u.role,eventKind==='coverage'?'devices.view':'alerts.view'))found.push({...u,audience:'ops'});
    if(propertyId){
      const users=(await db.query(`SELECT u.* FROM properties p JOIN users u ON COALESCE(u.account_owner_id,u.id)=p.user_id
        WHERE p.property_id=$1 AND p.parent_property_id IS NULL AND u.user_type='client' AND u.service_provider_org_id IS NULL AND u.is_active=TRUE`,[propertyId])).rows;
      for(const u of users)if(u.email&&clientCan(u,eventKind==='coverage'?'view_monitoring':'view_alerts'))found.push({...u,audience:'client'});
    }
    return found;
  }
  async function enqueue(db,event){
    const q=createOutbox({pool:db,transport:async()=>{throw Error('Enqueue only');},canStaff});
    let count=0;
    for(const u of await recipients(db,event.propertyId,event.kind)){
      const title=event.kind==='coverage'?({lost:'Monitoring coverage lost',reduced:'Monitoring coverage reduced',restored:'Monitoring updates restored',improved:'Monitoring coverage improved'}[event.phase]):event.phase==='resolved'?'Incident marked resolved':event.phase==='escalated'?'Incident escalated to critical':event.phase==='reopened'?'Incident reopened':`${event.severity==='critical'?'Critical':'High-priority'} incident recorded`;
      const message=event.kind==='coverage'?`${event.current.healthy} of ${event.current.total} previously reporting active devices have a recent, valid water-level update. ${['lost','reduced'].includes(event.phase)?'Current drainage conditions may be unknown; arrange a device check.':'Recent updates are available again; this does not establish that the drainage is safe.'}`:event.phase==='resolved'?'An operator marked this incident resolved. This is a recorded status, not independent confirmation that the area is safe.':`A ${event.severity} incident has been recorded for review. Flooding is not confirmed by this email. Keep away from moving water and open drains, and review the incident in your portal.`;
      const url=u.audience==='ops'?'https://neon.flowguard.ng/index.html#'+(event.kind==='coverage'?'sensors':'alerts'):'https://app.flowguard.ng/#'+(event.kind==='coverage'?'monitoring':'alerts');
      const body=`<p style="line-height:1.6;color:#4a626d"><strong>${esc(event.propertyName||'Estate not linked')}</strong></p><p style="line-height:1.6;color:#4a626d">${esc(message)}</p><p style="color:#8399a4">Event reference: ${esc(event.id)} · ${esc(new Date(now()).toLocaleString('en-GB',{timeZone:'Africa/Lagos'}))} WAT</p><p><a href="${url}" style="color:#0891b2">Review in FlowGuard →</a></p>`;
      const scope={kind:'operational',eventKind:event.kind,audience:u.audience,userId:u.id,propertyId:event.propertyId,version:event.version,healthy:event.current.healthy,total:event.current.total,alertId:event.kind==='alert'?event.id:null,phase:event.phase,severity:event.severity,resolvedAt:event.resolvedAt};
      const row=await q.enqueue({from,to:[u.email],subject:`${title} — ${event.propertyName||event.id}`,html:shell(title,body,u.audience==='ops'?'You received this operational notification because of your FlowGuard role.':'You received this monitoring notification for an estate linked to your FlowGuard account.'),text:`${title}. ${event.propertyName||event.id}. ${message} ${url}`},{category:'alert',eventKey:`operational:${event.kind}:${event.id}:${event.version}`,scope,expiresAt:new Date(now()+3600000)});
      if(row.status==='pending')count++;
    }
    return count;
  }
  async function observe(kind,id,current,meta,cutover){
    const db=await pool.connect();
    try{
      await db.query('BEGIN');
      // Serializes first observations as well as updates across API processes.
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[kind+':'+id]);
      let previous=(await db.query('SELECT * FROM operational_email_state WHERE kind=$1 AND entity_key=$2 FOR UPDATE',[kind,id])).rows[0];
      // JSONB key ordering is not stable in JS serialization; compare fields.
      const unchanged=previous&&(kind==='coverage'?previous.snapshot.healthy===current.healthy&&previous.snapshot.total===current.total:previous.snapshot.status===current.status&&previous.snapshot.severity===current.severity&&previous.snapshot.resolvedAt===current.resolvedAt&&previous.snapshot.propertyId===current.propertyId);
      if(unchanged){await db.query('UPDATE operational_email_state SET pending=NULL,pending_since=NULL WHERE kind=$1 AND entity_key=$2',[kind,id]);await db.query('COMMIT');return;}
      if(kind==='coverage'&&previous){
        const pendingMatches=previous.pending&&previous.pending.healthy===current.healthy&&previous.pending.total===current.total;
        if(!pendingMatches||now()-new Date(previous.pending_since).getTime()<5*60000){
          if(!pendingMatches)await db.query('UPDATE operational_email_state SET pending=$3,pending_since=$4 WHERE kind=$1 AND entity_key=$2',[kind,id,JSON.stringify(current),new Date(now())]);
          await db.query('COMMIT');return;
        }
      }
      const version=(previous?.version||0)+1;
      const phase=kind==='coverage'?coverageTransition(previous?.snapshot,current):alertTransition(previous?{...previous.snapshot,notified:previous.notified_open}:null,current,new Date(meta.createdAt).getTime()>=new Date(cutover).getTime());
      // An estate reassignment starts a new baseline, never sends another
      // organisation's prior incident context to the new owner.
      const safePhase=kind==='alert'&&previous&&previous.snapshot.propertyId!==current.propertyId?null:phase;
      await db.query(`INSERT INTO operational_email_state(kind,entity_key,snapshot,version,notified_open) VALUES($1,$2,$3,$4,false)
        ON CONFLICT(kind,entity_key) DO UPDATE SET snapshot=EXCLUDED.snapshot,version=EXCLUDED.version,pending=NULL,pending_since=NULL,updated_at=NOW()`,[kind,id,JSON.stringify(current),version]);
      if(kind==='alert'&&previous&&previous.snapshot.propertyId!==current.propertyId)await db.query('UPDATE operational_email_state SET notified_open=false WHERE kind=$1 AND entity_key=$2',[kind,id]);
      if(safePhase){
        const count=await enqueue(db,{kind,id,current,version,phase:safePhase,...meta,severity:current.severity,resolvedAt:current.resolvedAt});
        await db.query('UPDATE operational_email_state SET notified_open=$3 WHERE kind=$1 AND entity_key=$2',[kind,id,safePhase==='resolved'?false:kind==='alert'?count>0:false]);
      }
      await db.query('COMMIT');
    }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
  }
  async function sweep(){
    await pool.query('INSERT INTO operational_email_control(id) VALUES(1) ON CONFLICT(id) DO NOTHING');
    const cutover=(await pool.query('SELECT started_at FROM operational_email_control WHERE id=1')).rows[0].started_at;
    const alerts=(await pool.query(`SELECT a.alert_id,a.status,a.severity,a.created_at,a.resolved_at,cp.property_id,cp.property_name
      FROM alerts a LEFT JOIN sensors s ON s.sensor_id=a.sensor_id LEFT JOIN properties p ON p.property_id=COALESCE(a.property_id,s.property_id)
      LEFT JOIN properties cp ON cp.property_id=COALESCE(p.parent_property_id,p.property_id)
      WHERE a.status NOT IN ('resolved','closed') OR a.created_at >= $1 OR EXISTS(SELECT 1 FROM operational_email_state e WHERE e.kind='alert' AND e.entity_key=a.alert_id)`,[cutover])).rows;
    for(const a of alerts)await observe('alert',a.alert_id,{status:a.status,severity:a.severity,resolvedAt:a.resolved_at?new Date(a.resolved_at).toISOString():null,propertyId:a.property_id||null},{propertyId:a.property_id||null,propertyName:a.property_name,createdAt:a.created_at},cutover);
    const devices=(await pool.query(`SELECT s.sensor_id,s.status,s.last_ping,cp.property_id,cp.property_name,r.time AS reading_time,r.water_level_percent AS level
      FROM sensors s JOIN properties p ON p.property_id=s.property_id JOIN properties cp ON cp.property_id=COALESCE(p.parent_property_id,p.property_id)
      LEFT JOIN LATERAL(SELECT time,water_level_percent FROM sensor_readings WHERE sensor_id=s.sensor_id ORDER BY time DESC LIMIT 1)r ON TRUE`)).rows;
    const estates=new Map();
    for(const d of devices){if(!estates.has(d.property_id))estates.set(d.property_id,[]);estates.get(d.property_id).push(d);}
    for(const [id,rows] of estates)await observe('coverage',id,coverage(rows,now()),{propertyId:id,propertyName:rows[0].property_name},cutover);
  }
  return {sweep,observe};
}
function start(){
  if(process.env.OPERATIONAL_EMAILS_ENABLED!=='true')return;
  if(process.env.MAIL_OUTBOX_ENABLED!=='true'||!process.env.RESEND_API_KEY||!process.env.MAIL_FROM||/@resend\.dev\b/i.test(process.env.MAIL_FROM)){console.error('[operationalEmails] Disabled: configured outbox and production sender required.');return;}
  const service=createOperationalEmails({pool:require('../config/database'),canStaff:require('./permissions').hasPermission,from:`${process.env.MAIL_FROM_NAME||'FlowGuard'} <${process.env.MAIL_FROM||'onboarding@resend.dev'}>`});
  let busy=false;const tick=async()=>{if(busy)return;busy=true;try{await service.sweep();}catch(_){console.error('[operationalEmails] Sweep failed; check schema and database.');}finally{busy=false;}};
  const timer=setInterval(tick,60000);timer.unref();tick();
}
module.exports={createOperationalEmails,alertTransition,coverage,coverageTransition,start};
