const { randomUUID } = require('crypto');
// Lock and transaction make retries/concurrent callers safe. At most one due
// occurrence per plan per invocation; missed occurrences remain visible.
async function prepareDueDraft(pool, planId, actorId, today, expectedDue, actorType='internal') {
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    const plan=(await db.query('SELECT * FROM service_plans WHERE id=$1 FOR UPDATE',[planId])).rows[0];
    if(!plan)throw Object.assign(new Error('Plan not found'),{status:404});
    const due=String(plan.next_due instanceof Date?plan.next_due.toISOString().slice(0,10):plan.next_due).slice(0,10);
    if(!plan.active||due>today||(expectedDue&&due!==expectedDue)){await db.query('COMMIT');return {created:false};}
    const evidence=(await db.query('SELECT required FROM job_evidence_templates WHERE job_type=$1',[plan.job_type])).rows[0]?.required||[];
    const job=(await db.query(`INSERT INTO jobs(reference,property_id,title,description,job_type,status,required_evidence,created_by,scheduled_for) VALUES($1,$2,$3,$4,$5,'draft',$6,$7,$8) RETURNING id,status,service_provider_org_id`,['PL-'+randomUUID().replace(/-/g,'').slice(0,20),plan.property_id,plan.title,plan.description,plan.job_type,JSON.stringify(evidence),actorId,due+'T00:00:00+01:00'])).rows[0];
    await db.query('INSERT INTO service_plan_occurrences(plan_id,due_on,job_id) VALUES($1,$2,$3)',[plan.id,due,job.id]);
    await db.query("INSERT INTO job_events(job_id,event_type,to_status,actor_id,actor_type,note,meta) VALUES($1,'created','draft',$2,$3,'Due service plan: unassigned draft for review',$4)",[job.id,actorId,actorType,JSON.stringify({service_plan_id:plan.id,due_on:due})]);
    await db.query('UPDATE service_plans SET next_due=next_due+interval_days WHERE id=$1',[plan.id]);
    await db.query('COMMIT');
    return {created:true,job_id:job.id,due_on:due};
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
const watDate=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Lagos',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
async function prepareDuePlans(pool,today=watDate()){
  const plans=(await pool.query('SELECT id,next_due FROM service_plans WHERE active=TRUE AND next_due<=$1 ORDER BY next_due LIMIT 50',[today])).rows;
  const results=[];
  for(const p of plans){
    const due=p.next_due instanceof Date?p.next_due.toISOString().slice(0,10):String(p.next_due).slice(0,10);
    results.push(await prepareDueDraft(pool,p.id,null,today,due,'system'));
  }
  return results;
}
function startServicePlanDrafts(pool){
  let running=false;
  const tick=async()=>{if(running)return;running=true;try{await prepareDuePlans(pool);}catch(e){console.error('[service-plan drafts] preparation failed');}finally{running=false;}};
  const timer=setInterval(tick,60000);timer.unref();tick();
  return ()=>clearInterval(timer);
}
module.exports={prepareDueDraft,prepareDuePlans,startServicePlanDrafts};
