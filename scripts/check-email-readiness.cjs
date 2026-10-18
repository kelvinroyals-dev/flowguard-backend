// Read-only production check. Run explicitly with node -r dotenv/config.
// Prints booleans/counts/schema identifiers, never keys, emails or message bodies.
const pool=require('../config/database');
async function main(){
 let failed=false;const check=(name,ok)=>{console.log((ok?'PASS: ':'FAIL: ')+name);if(!ok)failed=true;};
 for(const table of ['email_outbox','email_domain_events','email_source_inventory','email_suppressions','email_webhook_events','email_worker_health','email_schedule_keys','operational_email_state'])check(table,!!(await pool.query('SELECT to_regclass($1) AS name',[table])).rows[0].name);
 check('configured email provider',!!process.env.RESEND_API_KEY);
 check('production sender configured',!!process.env.MAIL_FROM&&!/@resend\.dev\b/i.test(process.env.MAIL_FROM));
 check('delivery callback verification configured',/^whsec_/.test(process.env.RESEND_WEBHOOK_SECRET||''));
 const inventory=(await pool.query('SELECT entity,installed FROM email_source_inventory ORDER BY entity')).rows;
 check('all 18 lifecycle event sources installed',inventory.length===18&&inventory.every(s=>s.installed));
 for(const source of inventory)if(source.installed){const r=await pool.query("SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass($1) AND tgname='email_domain_capture' AND NOT tgisinternal AND tgenabled<>'D'",[source.entity]);check('trigger '+source.entity,r.rows.length===1);}
 await pool.query('SELECT attempts,retry_at FROM email_domain_events LIMIT 0');
 await pool.query('SELECT reminder_sent_count,last_reminder_sent FROM invoices LIMIT 0');
 await pool.query('SELECT driver_id,battery_voltage,last_ping FROM sensors LIMIT 0');
 const counters=(await pool.query("SELECT COUNT(*) FILTER(WHERE processed_at IS NULL)::int pending,COUNT(*) FILTER(WHERE attempts>=5 AND processed_at IS NULL)::int failed FROM email_domain_events")).rows[0];
 console.log('Lifecycle journal:',JSON.stringify(counters));
 console.log('Sending flags:',JSON.stringify(Object.fromEntries(['MAIL_OUTBOX_ENABLED','OPERATIONAL_EMAILS_ENABLED','LIFECYCLE_EMAILS_ENABLED','EMAIL_SCHEDULES_ENABLED'].map(k=>[k,process.env[k]==='true']))));
 console.log('Readiness is not delivery certification. No email was sent by this check.');
 if(failed)process.exitCode=1;
}
main().catch(()=>{console.error('FAIL: email readiness schema/configuration check; inspect migrations locally. No credentials printed.');process.exitCode=1;}).finally(()=>pool.end());
