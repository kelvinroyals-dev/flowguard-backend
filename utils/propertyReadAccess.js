'use strict';
const pool=require('../config/database');
const {hasPermission}=require('./permissions');
const {clientCan}=require('./clientPermissions');
const {normalizeRole}=require('./roles');
async function readProperty(req,res){
 const {rows:users}=await pool.query('SELECT id,role,user_type,account_owner_id,client_role,service_provider_org_id,is_active FROM users WHERE id=$1',[req.user.id]);
 const user=users[0];if(!user||user.is_active===false){res.status(401).json({success:false,error:'Session unavailable'});return null;}
 if(user.user_type==='service_provider'||user.service_provider_org_id||normalizeRole(user.role)==='service_provider'){res.status(403).json({success:false,error:'Not authorised'});return null;}
 const client=user.user_type==='client'||normalizeRole(user.role)==='client';
 if(client&&!clientCan(user,'view_monitoring')||!client&&!await hasPermission(normalizeRole(user.role),'properties.view')){res.status(403).json({success:false,error:'Not authorised'});return null;}
 const {rows}=await pool.query('SELECT property_id,property_name,user_id,latitude,longitude,location_verified,state,city FROM properties WHERE property_id=$1 AND parent_property_id IS NULL',[req.params.propertyId]);
 const record=rows[0];if(!record||client&&String(record.user_id)!==String(user.account_owner_id||user.id)){res.status(404).json({success:false,error:'Estate not found'});return null;}
 return record;
}
module.exports={readProperty};
