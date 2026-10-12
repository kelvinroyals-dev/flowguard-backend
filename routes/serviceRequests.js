// Intake is distinct from support. Direct-provider records never enter the
// FlowGuard verification/dispatch lifecycle. No implicit provider grants.
const express = require('express');
const { randomUUID } = require('crypto');
const pool = require('../config/database');
const assignments = require('../utils/providerAssignments').createProviderAssignments(pool);
const { authenticateToken } = require('../middleware/auth');
const { propertyIdsForUser } = require('../utils/scope');
const { requirePermission } = require('../utils/permissions');
const { requireClientPermission } = require('../utils/clientPermissions');
const { writeLimiter } = require('../middleware/rate-limit');
const router = express.Router();
const TYPES = ['inspection','drain_cleaning','sensor_maintenance','repair','survey','other'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const staff = req => req.user.user_type === 'internal' && req.user.role !== 'client';
const client = req => req.user.role === 'client' && req.user.user_type !== 'service_provider';
const provider = req => req.user.user_type === 'service_provider' && Number.isSafeInteger(Number(req.user.spo)) && Number(req.user.spo) > 0;
router.use(authenticateToken);
// JWTs omit organisation/role fields. Read trusted account data before scoping.
router.use(async(req,res,next)=>{
  if(!client(req))return next();
  try{
    const user=(await pool.query('SELECT id,user_type,account_owner_id,client_role,is_active FROM users WHERE id=$1',[req.user.id])).rows[0];
    if(!user||user.user_type!=='client'||user.is_active===false)return res.status(403).json({success:false,error:'Active client account required'});
    req.user={...req.user,...user};next();
  }catch(_){fail(res);}
});
const clientOwner=req=>req.user.account_owner_id||req.user.id;
router.use((req,res,next)=>staff(req)?requirePermission('jobs.view')(req,res,next):next());

// Production assignments reference properties.id (integer); older installations
// may reference properties.property_id (public text reference). Resolve the FK,
// not a value cast, so a numeric-looking public reference cannot cross estates.
async function assignmentPropertyJoin() {
  return assignments.join();
}

async function scope(req, row) {
  if (staff(req)) return true;
  if (client(req)) return (await propertyIdsForUser(clientOwner(req))).map(String).includes(String(row.property_id));
  return provider(req) && row.route === 'direct_provider' && Number(row.service_provider_org_id) === Number(req.user.spo);
}
async function load(req, res, db = pool, lock = false) {
  if (!UUID.test(req.params.id)) { res.status(400).json({success:false,error:'Invalid request id'}); return null; }
  const row = (await db.query(`SELECT r.*,p.property_name,o.name AS provider_name,o.contact_person AS provider_contact_name,o.email AS provider_email,o.phone AS provider_phone FROM service_requests r JOIN properties p ON p.property_id=r.property_id LEFT JOIN service_provider_organisations o ON o.id=r.service_provider_org_id WHERE r.id=$1${lock ? ' FOR UPDATE OF r' : ''}`, [req.params.id])).rows[0];
  if (!row || !(await scope(req,row))) { res.status(404).json({success:false,error:'Request not found'}); return null; }
  return row;
}
const fail = res => res.status(500).json({success:false,error:'Service requests are unavailable'});
router.get('/providers',async(req,res)=>{
  if(!client(req))return res.status(403).json({success:false,error:'Client account required'});
  try{
    const ids=await propertyIdsForUser(clientOwner(req));
    const join=await assignmentPropertyJoin();
    const rows=(await pool.query(`SELECT p.property_id,o.id,o.name,o.contact_person AS contact_name,o.email,o.phone FROM service_provider_property_assignments a ${join} JOIN service_provider_organisations o ON o.id=a.service_provider_org_id WHERE p.property_id=ANY($1::varchar[]) AND a.active=TRUE AND o.status='active' ORDER BY o.name`,[ids])).rows;
    res.json({success:true,data:rows});
  }catch(_){fail(res);}
});
router.get('/', async (req,res) => {
  try {
    let condition, params=[];
    if (staff(req)) condition='TRUE';
    else if (client(req)) { condition='r.property_id = ANY($1::varchar[])'; params=[await propertyIdsForUser(clientOwner(req))]; }
    else if (provider(req)) { condition="r.route='direct_provider' AND r.service_provider_org_id=$1"; params=[Number(req.user.spo)]; }
    else return res.status(403).json({success:false,error:'Not authorised'});
    const rows=(await pool.query(`SELECT r.*,p.property_name,o.name AS provider_name,o.contact_person AS provider_contact_name,o.email AS provider_email,o.phone AS provider_phone,j.status AS work_order_status,j.reference AS work_order_reference,j.scheduled_for AS work_order_scheduled_for FROM service_requests r JOIN properties p ON p.property_id=r.property_id LEFT JOIN service_provider_organisations o ON o.id=r.service_provider_org_id LEFT JOIN jobs j ON j.id=r.job_id AND j.property_id=r.property_id WHERE ${condition} ORDER BY r.created_at DESC LIMIT 200`,params)).rows;
    res.json({success:true,data:rows});
  } catch (_) { fail(res); }
});
router.get('/:id', async(req,res)=>{
  try {
    const row=await load(req,res); if(!row)return;
    const work=row.job_id ? (await pool.query('SELECT reference,status,scheduled_for FROM jobs WHERE id=$1 AND property_id=$2',[row.job_id,row.property_id])).rows[0] : null;
    const events=(await pool.query('SELECT * FROM service_request_events WHERE request_id=$1 ORDER BY created_at,id',[row.id])).rows;
    res.json({success:true,data:{...row,work_order_reference:work?.reference||null,work_order_status:work?.status||null,work_order_scheduled_for:work?.scheduled_for||null,events,flowguard_role:row.route==='direct_provider'?'visibility_only':'coordination'}});
  } catch (_) { fail(res); }
});
router.post('/', writeLimiter, requireClientPermission('manage_properties'), async(req,res)=>{
  if(!client(req))return res.status(403).json({success:false,error:'Client account required'});
  const b=req.body||{};
  if(!['flowguard','direct_provider'].includes(b.route)||!TYPES.includes(b.job_type)||typeof b.title!=='string'||!b.title.trim()||b.title.length>255||typeof b.description!=='string'||!b.description.trim()||b.description.length>10000)
    return res.status(400).json({success:false,error:'Valid route, service type, title and description required'});
  try {
    if(!(await propertyIdsForUser(clientOwner(req))).map(String).includes(String(b.property_id)))return res.status(403).json({success:false,error:'Not authorised for this estate'});
    let org=null;
    if(b.route==='direct_provider') {
      org=Number(b.service_provider_org_id);
      if(!Number.isSafeInteger(org)||org<=0)return res.status(400).json({success:false,error:'Existing provider required'});
      const join=await assignmentPropertyJoin();
      const existing=(await pool.query(`SELECT 1 FROM service_provider_property_assignments a ${join} JOIN service_provider_organisations o ON o.id=a.service_provider_org_id WHERE p.property_id=$1 AND a.service_provider_org_id=$2 AND a.active=TRUE AND o.status='active'`,[b.property_id,org])).rows;
      if(!existing.length)return res.status(403).json({success:false,error:'Provider is not active on this estate'});
    }
    const row=(await pool.query(`INSERT INTO service_requests(id,property_id,requested_by,route,service_provider_org_id,job_type,title,description) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[randomUUID(),b.property_id,req.user.id,b.route,org,b.job_type,b.title.trim(),b.description.trim()])).rows[0];
    res.status(201).json({success:true,data:row});
  } catch (_) { fail(res); }
});
// Recorded provider progress, not FlowGuard approval or verification.
router.post('/:id/events',writeLimiter,async(req,res)=>{
  try {
    const row=await load(req,res); if(!row)return;
    if(!provider(req)||row.route!=='direct_provider')return res.status(403).json({success:false,error:'Only the receiving provider can report progress'});
    const b=req.body||{};
    if(!['acknowledged','in_progress','completed','declined'].includes(b.event_type)||typeof b.note!=='string'||!b.note.trim()||b.note.length>10000)return res.status(400).json({success:false,error:'Valid progress type and note required'});
    const event=(await pool.query(`WITH progress AS (
      UPDATE service_requests SET status=$3 WHERE id=$1 AND route='direct_provider' RETURNING id
    ) INSERT INTO service_request_events(request_id,actor_id,event_type,note)
      SELECT id,$2,$3,$4 FROM progress RETURNING *`,[row.id,req.user.id,b.event_type,b.note.trim()])).rows[0];
    res.status(201).json({success:true,data:event});
  }catch(_){fail(res);}
});
router.post('/:id/draft',writeLimiter,(req,res,next)=>staff(req)?next():res.status(403).json({success:false,error:'Staff only'}),requirePermission('jobs.manage'),async(req,res)=>{
  let db;
  try {
    db=await pool.connect();
    await db.query('BEGIN');
    const row=await load(req,res,db,true);
    if(!row){await db.query('ROLLBACK');return;}
    if(row.route!=='flowguard'){await db.query('ROLLBACK');return res.status(409).json({success:false,error:'Direct-provider requests are visibility-only'});}
    if(row.job_id){await db.query('COMMIT');return res.json({success:true,data:{job_id:row.job_id,existing:true}});}
    const evidence=(await db.query('SELECT required FROM job_evidence_templates WHERE job_type=$1',[row.job_type])).rows[0]?.required||[];
    const job=(await db.query(`INSERT INTO jobs(reference,property_id,job_type,title,description,status,required_evidence,created_by) VALUES($1,$2,$3,$4,$5,'draft',$6,$7) RETURNING id`,['SR-'+row.id.replace(/-/g,'').slice(0,20),row.property_id,row.job_type,row.title,row.description,JSON.stringify(evidence),req.user.id])).rows[0];
    await db.query("UPDATE service_requests SET job_id=$2,status='draft_prepared' WHERE id=$1",[row.id,job.id]);
    await db.query("INSERT INTO job_events(job_id,event_type,to_status,actor_id,actor_type,note,meta) VALUES($1,'created','draft',$2,'internal','Prepared from service request',$3)",[job.id,req.user.id,JSON.stringify({service_request_id:row.id})]);
    await db.query('COMMIT');
    res.status(201).json({success:true,data:{job_id:job.id}});
  }catch(_){if(db)await db.query('ROLLBACK');fail(res);}finally{if(db)db.release();}
});
module.exports=router;
