// Safe operational metadata only; never retain provider errors or credentials.
async function record(pool,worker,ok){
 await pool.query(`INSERT INTO email_worker_health(worker,last_success_at,last_failure_at,error_code)
  VALUES($1,CASE WHEN $2 THEN NOW() END,CASE WHEN NOT $2 THEN NOW() END,CASE WHEN NOT $2 THEN 'worker_failed' END)
  ON CONFLICT(worker) DO UPDATE SET last_success_at=CASE WHEN $2 THEN NOW() ELSE email_worker_health.last_success_at END,
  last_failure_at=CASE WHEN NOT $2 THEN NOW() ELSE email_worker_health.last_failure_at END,error_code=CASE WHEN NOT $2 THEN 'worker_failed' END`,[worker,ok]);
}
async function safely(pool,worker,ok){try{await record(pool,worker,ok);}catch(_){console.error('[email health] Status persistence unavailable.');}}
module.exports={record,safely};
