// routes/meta.js — cross-portal metadata. Exposes the canonical status
// vocabulary so ops, field and client all localise from ONE source of truth.
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { VOCAB } = require('../utils/statusVocab');

// GET /api/v1/meta/status-vocab — canonical statuses + per-audience labels.
// Any authenticated portal can read this to keep wording consistent.
router.get('/status-vocab', authenticateToken, (req, res) => {
  res.json({ success: true, data: VOCAB });
});

// Internal estate picker. Public signup only receives the static state list;
// client/provider accounts must never enumerate other customers' estates.
router.get('/estate-options', authenticateToken, async (req,res)=>{
 try{
  const {INTERNAL_ROLES}=require('../utils/roles'),{hasPermission}=require('../utils/permissions');
  if(!INTERNAL_ROLES.includes(req.user.role)||req.user.user_type==='client'||req.user.user_type==='service_provider')return res.status(403).json({success:false,error:'Not authorised'});
  let permitted=false;for(const key of ['situation.view','forecast.view','properties.view'])if(await hasPermission(req.user.role,key)){permitted=true;break;}
  if(!permitted)return res.status(403).json({success:false,error:'Not authorised'});
  const scope=require('../utils/geography').scope(req.query),q=req.query.q||'';
  if(typeof q!=='string'||q.length>100)return res.status(400).json({success:false,error:'Invalid estate search'});
  const pool=require('../config/database'),state=scope.state||null,city=scope.city||null;
  const stateCondition="($1::text IS NULL OR LOWER(TRIM(state))=LOWER($1) OR ($1='Federal Capital Territory' AND LOWER(TRIM(state)) IN ('abuja','fct','abuja fct','fct abuja')))";
  const cities=await pool.query(`SELECT DISTINCT TRIM(city) AS city FROM properties WHERE parent_property_id IS NULL AND ${stateCondition} AND NULLIF(TRIM(city),'') IS NOT NULL AND LOWER(TRIM(city))<>'unspecified' ORDER BY city LIMIT 501`,[state]);
  const estates=await pool.query(`SELECT property_id,property_name,city,state FROM properties WHERE parent_property_id IS NULL AND ${stateCondition}
    AND ($2::text IS NULL OR LOWER(TRIM(city))=LOWER($2))
    AND ($3::text='' OR POSITION(LOWER($3) IN LOWER(property_name))>0 OR property_id=$4)
    ORDER BY CASE WHEN property_id=$4 THEN 0 ELSE 1 END,property_name,property_id LIMIT 101`,[state,city,q.trim(),scope.property_id||null]);
  res.set('Cache-Control','private, no-store').json({success:true,data:{states:require('../utils/nigeriaStates').names,cities:cities.rows.slice(0,500).map(r=>r.city),cities_more:cities.rows.length>500,estates:estates.rows.slice(0,100),has_more:estates.rows.length>100}});
 }catch(err){res.status(/geography/.test(err.message)?400:500).json({success:false,error:'Estate options unavailable'});}
});

module.exports = router;
