// Provider acceptance is NOT inbox delivery. Never log payloads, tokens or keys.
const {randomUUID,createHash}=require('node:crypto');
function createOutbox({pool,transport,now=()=>Date.now(),canStaff=(role,key)=>require('./permissions').hasPermission(role,key)}) {
  async function allowed(recipient,category,scope) {
    if(scope?.kind==='domain'&&!await require('./emailDomainPolicy').canReceive(pool,recipient,scope,canStaff))return false;
    if((await pool.query('SELECT 1 FROM email_suppressions WHERE recipient=LOWER($1)',[recipient])).rows.length)return false;
    if(scope?.kind==='invoice'){
      const row=(await pool.query(`SELECT u.id,u.email,u.is_active FROM invoices i JOIN users u ON u.id=i.user_id WHERE i.invoice_id=$1`,[scope.invoiceId])).rows[0];
      if(!row||row.is_active===false||String(row.id)!==String(scope.ownerId)||row.email.toLowerCase()!==recipient.toLowerCase())return false;
    }
    if(['transactional','security'].includes(category))return true;
    const {rows}=await pool.query(`SELECT u.id,u.user_type,u.role,u.client_role,u.account_owner_id,u.service_provider_org_id,u.is_active,p.notification_preferences
      FROM users u LEFT JOIN user_preferences p ON p.user_id=u.id WHERE LOWER(u.email)=LOWER($1)`,[recipient]);
    // Optional mail is only for known active recipients; query errors fail closed.
    if(!rows.length)return false;
    if(rows.some(r=>r.is_active===false))return false;
    const prefs=rows.map(r=>r.notification_preferences||{});
    if(prefs.some(p=>p.email_alerts===false || (category==='digest'&&p.weekly_digest===false)))return false;
    if(category==='alert'){
      if(scope?.kind!=='operational'||!rows.every(r=>String(r.id)===String(scope.userId)&&!r.service_provider_org_id))return false;
      const permission=scope.eventKind==='coverage'?'devices.view':'alerts.view';
      if(scope.audience==='ops'){
        for(const user of rows)if(user.user_type!=='internal'||!['admin','super_admin','operations_manager','dispatcher'].includes(user.role)||!await canStaff(user.role,permission))return false;
      }else if(scope.audience==='client'){
        const owner=(await pool.query('SELECT user_id FROM properties WHERE property_id=$1 AND parent_property_id IS NULL',[scope.propertyId])).rows[0];
        if(!owner)return false;
        const clientCan=require('./clientPermissions').clientCan;
        if(!rows.every(u=>String(u.account_owner_id||u.id)===String(owner.user_id)&&clientCan(u,scope.eventKind==='coverage'?'view_monitoring':'view_alerts')))return false;
      }else return false;
      if(scope.eventKind==='coverage'){
        const state=(await pool.query("SELECT version FROM operational_email_state WHERE kind='coverage' AND entity_key=$1",[scope.propertyId])).rows[0];
        if(!state||Number(state.version)!==Number(scope.version))return false;
        const live=(await pool.query(`SELECT COUNT(*) FILTER(WHERE s.status='active' AND s.last_ping IS NOT NULL)::int AS total,
          COUNT(*) FILTER(WHERE s.status='active' AND s.last_ping BETWEEN NOW()-INTERVAL '6 hours' AND NOW()
          AND r.time BETWEEN NOW()-INTERVAL '30 minutes' AND NOW() AND r.water_level_percent BETWEEN 0 AND 100)::int AS healthy
          FROM sensors s JOIN properties p ON p.property_id=s.property_id
          LEFT JOIN LATERAL(SELECT time,water_level_percent FROM sensor_readings WHERE sensor_id=s.sensor_id ORDER BY time DESC LIMIT 1)r ON TRUE
          WHERE COALESCE(p.parent_property_id,p.property_id)=$1`,[scope.propertyId])).rows[0];
        if(!live||live.healthy!==scope.healthy||live.total!==scope.total)return false;
      }else{
        const alert=(await pool.query(`SELECT a.status,a.severity,a.resolved_at,COALESCE(p.parent_property_id,p.property_id) AS property_id
          FROM alerts a LEFT JOIN sensors s ON s.sensor_id=a.sensor_id LEFT JOIN properties p ON p.property_id=COALESCE(a.property_id,s.property_id) WHERE a.alert_id=$1`,[scope.alertId])).rows[0];
        if(!alert||String(alert.property_id||'')!==String(scope.propertyId||''))return false;
        const resolved=['resolved','closed'].includes(alert.status);
        if(scope.phase==='resolved'){if(!resolved||new Date(alert.resolved_at).getTime()!==new Date(scope.resolvedAt).getTime())return false;}
        else if(resolved||alert.severity!==scope.severity)return false;
      }
    }
    if(category==='briefing'){
      if(scope?.kind==='ops'){
        if(!rows.every(r=>r.user_type==='internal'&&['admin','super_admin','operations_manager','dispatcher','analyst'].includes(r.role)))return false;
      }else if(scope?.kind==='client'){
        if(!rows.every(r=>r.user_type==='client'&&String(r.id)===String(scope.ownerId)&&r.account_owner_id==null)||!Array.isArray(scope.propertyIds)||!scope.propertyIds.length)return false;
        const current=(await pool.query('SELECT property_id FROM properties WHERE user_id=$1',[scope.ownerId])).rows.map(r=>String(r.property_id));
        if(!scope.propertyIds.every(id=>current.includes(String(id))))return false;
      }else return false;
    }
    const staff=(await pool.query(`SELECT 1 FROM users WHERE LOWER(email)=LOWER($1) AND user_type='internal'`,[recipient])).rows.length;
    if(staff){
      const settings=(await pool.query('SELECT settings FROM app_settings WHERE id=1')).rows[0]?.settings||{};
      if(settings.email_alerts===false || (category==='digest'&&settings.weekly_digest===false))return false;
    }
    return true;
  }
  async function enqueue(payload,{category='transactional',eventKey,expiresAt,invoiceId,reminderInvoiceId,scope}={}) {
    if(!['transactional','security','alert','briefing','digest','activity'].includes(category))throw Error('Invalid email category');
    const recipient=payload.to?.[0];
    if(payload.to?.length!==1||typeof recipient!=='string'||!/^\S+@\S+\.\S+$/.test(recipient)||/[\r\n]/.test(recipient))throw Error('Invalid email recipient');
    const expires=new Date(Math.min(expiresAt?new Date(expiresAt).getTime():now()+23*3600000,now()+23*3600000));
    if(!Number.isFinite(expires.getTime())||expires.getTime()<=now())throw Error('Expired email');
    const permitted=await allowed(recipient,category,scope);
    const key=createHash('sha256').update(String(eventKey||randomUUID())+'\0'+recipient.toLowerCase()).digest('hex');
    const id=randomUUID();
    await pool.query(`INSERT INTO email_outbox(id,event_key,recipient,category,payload,invoice_id,status,expires_at,scope_context,reminder_invoice_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(event_key) DO NOTHING`,
      [id,key,recipient,category,permitted?JSON.stringify(payload):null,invoiceId||null,permitted?'pending':'suppressed',expires,scope?JSON.stringify(scope):null,reminderInvoiceId||null]);
    return (await pool.query('SELECT id,status FROM email_outbox WHERE event_key=$1',[key])).rows[0];
  }
  async function attempt(id) {
    const token=randomUUID();
    const row=(await pool.query(`UPDATE email_outbox SET status='sending',lease_token=$2,lease_until=NOW()+INTERVAL '2 minutes',attempts=attempts+1
      WHERE id=$1 AND expires_at>NOW() AND attempts<5 AND next_attempt_at<=NOW()
      AND (status='pending' OR (status='sending' AND lease_until<NOW())) RETURNING *`,[id,token])).rows[0];
    if(!row)return;
    let outcome;
    try {
      if(!(await allowed(row.recipient,row.category,row.scope_context))){
        await pool.query(`UPDATE email_outbox SET status='suppressed',payload=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2`,[id,token]);return;
      }
      outcome=await transport(row.payload,'fg-'+id);
    }catch(_){outcome={accepted:false,retryable:true,error:'transport_or_preference_check_failed'};}
    if(outcome.accepted){
      const db=await pool.connect();
      try{
        await db.query('BEGIN');
        const updated=await db.query(`UPDATE email_outbox SET status='accepted',accepted_at=NOW(),provider_id=$3,payload=NULL,last_error=NULL,lease_until=NULL
          WHERE id=$1 AND lease_token=$2 AND status='sending' RETURNING invoice_id,reminder_invoice_id`,[id,token,outcome.providerId||null]);
        if(updated.rows[0]?.invoice_id)await db.query(`UPDATE invoices SET sent_at=NOW(),sent_count=COALESCE(sent_count,0)+1,
          status=CASE WHEN status IN ('draft','open') THEN 'sent' ELSE status END,updated_at=NOW() WHERE invoice_id=$1`,[updated.rows[0].invoice_id]);
        if(updated.rows[0]?.reminder_invoice_id)await db.query('UPDATE invoices SET reminder_sent_count=COALESCE(reminder_sent_count,0)+1,last_reminder_sent=NOW() WHERE invoice_id=$1',[updated.rows[0].reminder_invoice_id]);
        await db.query('COMMIT');
      }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
    }else{
      const terminal=!outcome.retryable||row.attempts>=5;
      await pool.query(`UPDATE email_outbox SET status=$3,last_error=$4,next_attempt_at=NOW()+($5 * INTERVAL '1 second'),lease_until=NULL,
        payload=CASE WHEN $6 THEN NULL ELSE payload END WHERE id=$1 AND lease_token=$2`,
        [id,token,terminal?'failed':'pending',outcome.error||'provider_rejected',Math.min(3600,60*2**(row.attempts-1)),terminal]);
    }
  }
  async function receipt(id){const row=(await pool.query('SELECT id,status FROM email_outbox WHERE id=$1',[id])).rows[0];return {id,accepted:row?.status==='accepted',queued:['pending','sending'].includes(row?.status),status:row?.status,durable:true};}
  async function send(payload,options){const row=await enqueue(payload,options);await attempt(row.id);return receipt(row.id);}
  async function sweep(){
    await require('./emailWebhooks').reconcile(pool);
    await pool.query(`UPDATE email_outbox SET status=CASE WHEN expires_at<=NOW() THEN 'expired' ELSE 'failed' END,payload=NULL,lease_until=NULL
      WHERE (status='pending' OR (status='sending' AND lease_until<NOW())) AND (expires_at<=NOW() OR attempts>=5)`);
    // Payloads can contain reset links: retain only metadata for terminal rows.
    await pool.query(`UPDATE email_outbox SET payload=NULL WHERE status IN ('accepted','failed','expired','suppressed') AND payload IS NOT NULL`);
    const {rows}=await pool.query(`SELECT id FROM email_outbox WHERE expires_at>NOW() AND attempts<5 AND next_attempt_at<=NOW()
      AND (status='pending' OR (status='sending' AND lease_until<NOW())) ORDER BY created_at LIMIT 10`);
    for(const row of rows)await attempt(row.id);
  }
  return {send,sweep,receipt,allowed,enqueue};
}
module.exports={createOutbox};
