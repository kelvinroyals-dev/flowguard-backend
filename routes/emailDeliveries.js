// Metadata only: never expose message bodies, reset links or provider credentials.
const express=require('express');
const pool=require('../config/database');
const {authenticateToken,requireRole}=require('../middleware/auth');
const {logAction}=require('../utils/audit');
const enabled=()=>process.env.LIFECYCLE_EMAILS_ENABLED==='true'&&process.env.MAIL_OUTBOX_ENABLED==='true'&&!!process.env.RESEND_API_KEY&&!!process.env.MAIL_FROM&&!/@resend\.dev\b/i.test(process.env.MAIL_FROM);
const router=express.Router();
router.use(authenticateToken,(req,res,next)=>req.user.user_type==='internal'?next():res.status(403).json({success:false,error:'Not authorised'}),requireRole('admin','super_admin'));
router.get('/',async(_req,res)=>{
  try{
    const counts=(await pool.query('SELECT status,COUNT(*)::int AS count FROM email_outbox GROUP BY status')).rows;
    const recent=(await pool.query(`SELECT id,category,status,attempts,last_error,created_at,accepted_at,expires_at,delivery_status,delivery_updated_at,
      category<>'security' AND status IN ('failed','expired') AND scope_context->>'kind'='domain' AND scope_context->>'userId' IS NOT NULL AS retryable
      FROM email_outbox ORDER BY created_at DESC LIMIT 100`)).rows;
    const workers=(await pool.query('SELECT * FROM email_worker_health ORDER BY worker')).rows;
    const sources=(await pool.query('SELECT * FROM email_source_inventory ORDER BY entity')).rows;
    const journal=(await pool.query('SELECT COUNT(*) FILTER(WHERE processed_at IS NULL)::int AS pending,COUNT(*) FILTER(WHERE processed_at IS NULL AND attempts>=5)::int AS failed FROM email_domain_events')).rows[0];
    const failedEvents=(await pool.query("SELECT id,entity,action,attempts,created_at,last_error,created_at>NOW()-INTERVAL '23 hours' AS retryable FROM email_domain_events WHERE processed_at IS NULL AND attempts>=5 ORDER BY id LIMIT 100")).rows;
    res.json({success:true,data:{enabled:process.env.MAIL_OUTBOX_ENABLED==='true',counts,recent,workers,sources,journal,failedEvents,meaning:'accepted means provider acceptance, not inbox delivery'}});
  }catch(_){res.status(503).json({success:false,error:'Email delivery records unavailable; check outbox migration'});}
});
router.post('/events/:id/retry',async(req,res)=>{
 if(!enabled())return res.status(503).json({success:false,error:'Email lifecycle sending is not enabled'});
 if(!/^\d{1,18}$/.test(req.params.id))return res.status(400).json({success:false,error:'Invalid event id'});
 try{
  const r=await pool.query("UPDATE email_domain_events SET attempts=0,retry_at=NOW(),last_error=NULL WHERE id=$1 AND processed_at IS NULL AND attempts>=5 AND created_at>NOW()-INTERVAL '23 hours' RETURNING id",[req.params.id]);
  if(!r.rows.length)return res.status(409).json({success:false,error:'Event is expired, processed or not awaiting recovery'});
  logAction(req.user.id,'queued failed email event for recovery','email_event',req.params.id);
  return res.status(202).json({success:true,data:{queued:true,sent:false}});
 }catch(_){return res.status(503).json({success:false,error:'Event could not be queued for recovery'});}
});
// Regenerate a notice for its original recipient only. Never revive old token
// payloads or broaden access; the normal live domain policy still decides.
router.post('/:id/retry',async(req,res)=>{
 if(!enabled())return res.status(503).json({success:false,error:'Email lifecycle sending is not enabled'});
 if(!/^[0-9a-f-]{36}$/i.test(req.params.id))return res.status(400).json({success:false,error:'Invalid delivery id'});
 let db;
 try{
  db=await pool.connect();
  await db.query('BEGIN');
  const o=(await db.query('SELECT * FROM email_outbox WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
  if(!o||!['failed','expired'].includes(o.status)||o.category==='security'||o.scope_context?.kind!=='domain'||!o.scope_context.userId){await db.query('ROLLBACK');return res.status(409).json({success:false,error:'This notice cannot be regenerated; use its original workflow'});}
  const e=(await db.query('SELECT * FROM email_domain_events WHERE id=$1',[o.scope_context.eventId])).rows[0];
  if(!e||e.action==='DELETE'||!await require('../utils/emailDomainPolicy').canReceive(db,o.recipient,o.scope_context,require('../utils/permissions').hasPermission)){await db.query('ROLLBACK');return res.status(409).json({success:false,error:'Notice no longer applicable or recipient access changed'});}
  const inserted=await db.query("INSERT INTO email_schedule_keys(key) VALUES($1) ON CONFLICT(key) DO NOTHING RETURNING key",['retry:'+o.id]);
  if(inserted.rows.length)await db.query('INSERT INTO email_domain_events(entity,entity_key,action,before_values,after_values)VALUES($1,$2,$3,$4,$5)',[e.entity,e.entity_key,e.action,e.before_values,{...e.after_values,email_retry_user_id:o.scope_context.userId}]);
  await db.query('COMMIT');if(inserted.rows.length)logAction(req.user.id,'queued regenerated email notice','email',o.id);return res.status(202).json({success:true,data:{queued:true,sent:false}});
 }catch(_){if(db)await db.query('ROLLBACK').catch(()=>{});return res.status(503).json({success:false,error:'Notice could not be regenerated'});}finally{db?.release();}
});
module.exports=router;
