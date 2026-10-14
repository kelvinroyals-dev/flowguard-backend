const express=require('express');
const {randomUUID}=require('crypto');
const pool=require('../config/database');
const {authenticateToken}=require('../middleware/auth');
const {requirePermission}=require('../utils/permissions');
const {writeLimiter}=require('../middleware/rate-limit');
const {prepareDueDraft}=require('../utils/servicePlans');
const router=express.Router();
const types=['inspection','drain_cleaning','sensor_maintenance','repair','survey','other'];
router.use(authenticateToken,(req,res,next)=>req.user.user_type==='internal'&&req.user.role!=='client'?next():res.status(403).json({success:false,error:'Staff only'}),requirePermission('jobs.view'));
router.get('/',async(req,res)=>{
  try{res.json({success:true,data:(await pool.query('SELECT s.*,p.property_name FROM service_plans s JOIN properties p ON p.property_id=s.property_id ORDER BY s.next_due LIMIT 200')).rows});}
  catch(_){res.status(500).json({success:false,error:'Plans unavailable'});}
});
router.post('/',writeLimiter,requirePermission('jobs.manage'),async(req,res)=>{
  const b=req.body||{};
  const date=typeof b.next_due==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(b.next_due)&&!Number.isNaN(Date.parse(b.next_due))&&new Date(b.next_due).toISOString().slice(0,10)===b.next_due;
  if(typeof b.title!=='string'||!b.title.trim()||b.title.length>255||!types.includes(b.job_type)||!Number.isInteger(b.interval_days)||b.interval_days<1||b.interval_days>366||!date||typeof b.property_id!=='string'||typeof(b.description||'')!=='string'||(b.description||'').length>10000)
    return res.status(400).json({success:false,error:'Valid title, estate, service, interval and date required'});
  try{
    if(!(await pool.query('SELECT 1 FROM properties WHERE property_id=$1',[b.property_id])).rows.length)return res.status(404).json({success:false,error:'Estate not found'});
    const row=(await pool.query('INSERT INTO service_plans(id,property_id,title,description,job_type,interval_days,next_due,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[randomUUID(),b.property_id,b.title.trim(),b.description||'',b.job_type,b.interval_days,b.next_due,req.user.id])).rows[0];
    res.status(201).json({success:true,data:row});
  }catch(_){res.status(500).json({success:false,error:'Plan could not be saved'});}
});
router.post('/:id/active',writeLimiter,requirePermission('jobs.manage'),async(req,res)=>{
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id)||typeof req.body?.active!=='boolean')return res.status(400).json({success:false,error:'Valid plan id and active state required'});
  try{
    const row=(await pool.query('UPDATE service_plans SET active=$2 WHERE id=$1 RETURNING *',[req.params.id,req.body.active])).rows[0];
    if(!row)return res.status(404).json({success:false,error:'Plan not found'});
    res.json({success:true,data:row});
  }catch(_){res.status(500).json({success:false,error:'Plan state could not be changed'});}
});
router.post('/:id/prepare',writeLimiter,requirePermission('jobs.manage'),async(req,res)=>{
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id))return res.status(400).json({success:false,error:'Invalid plan id'});
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Lagos',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const due=req.body?.due_on;
  if(typeof due!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(due))return res.status(400).json({success:false,error:'Expected due_on date required'});
  try{res.json({success:true,data:await prepareDueDraft(pool,req.params.id,req.user.id,today,due)});}
  catch(e){res.status(e.status||500).json({success:false,error:e.status?e.message:'Draft could not be prepared'});}
});
module.exports=router;
