'use strict';
// Read-only production preflight. Never issues a token, updates an account,
// sends a message, or prints emails, password hashes, IDs or credentials.
require('dotenv').config({quiet:true});
const pool=require('../config/database'),{normalizeRole,INTERNAL_ROLES}=require('../utils/roles');
(async()=>{
  await pool.query('SELECT id,email,role,user_type,is_active,token_version,service_provider_org_id,sp_role FROM users LIMIT 0');
  console.log('PASS: session and provider identity columns exist');
  await pool.query('SELECT role,permission_key,allowed,updated_at FROM role_permissions LIMIT 0');
  console.log('PASS: permission override schema exists');
  const {rows}=await pool.query('SELECT role,user_type,COUNT(*)::int AS accounts FROM users WHERE is_active IS DISTINCT FROM FALSE GROUP BY role,user_type ORDER BY role,user_type');
  console.table(rows);
  const uncertain=rows.filter(row=>!['internal','client','service_provider'].includes(row.user_type)||row.user_type==='internal'&&!INTERNAL_ROLES.includes(normalizeRole(row.role)));
  if(uncertain.length)throw Error('Unrecognized active account type/role needs review before rollout; no account was changed.');
  console.log('PASS: active account types/internal role names recognized');
  console.log('Schema preflight only; signed-in production role acceptance remains required.');
})().catch(error=>{console.error('FAIL:',error.message);process.exitCode=1;}).finally(()=>pool.end());
