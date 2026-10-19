// Explicit local suites only. No deployment, configured DB writes or provider calls.
const {spawnSync}=require('node:child_process'),path=require('node:path');
const cwd=path.resolve(__dirname,'..');
for(const args of [
 ['scripts/bootcheck.js'],
 ['--test','scripts/test-auth-session.cjs'],
 ['--test','scripts/test-permission-loading.cjs'],
 ['--test','scripts/test-auth-role-matrix.cjs'],
 ['--test','scripts/test-production-smoke.cjs'],
 ['--test','scripts/test-estate-weather.cjs'],
 ['--test','scripts/test-weatherapi.cjs'],
 ['--test','scripts/test-weather-refresh.cjs'],
 ['--test','scripts/test-email-foundation.cjs'],
 ['--test','scripts/test-operational-emails.cjs'],
 ['--test','scripts/test-email-lifecycle.cjs'],
 ['--test','scripts/test-email-rollout.cjs'],
 ['--test','scripts/test-invoice-reminders.cjs'],
 ['--test','scripts/test-registration-geography.cjs'],
 ['--test','scripts/test-realtime-unit.cjs'],
 ['--test','scripts/test-realtime-security.cjs'],
 ['scripts/test-estate-api.cjs'],
 ['scripts/test-service-contract.cjs'],
 ['scripts/test-service-contract.cjs','--numeric-assignments'],
]){
 const result=spawnSync(process.execPath,args,{cwd,env:process.env,stdio:'inherit',timeout:60000});
 if(result.error||result.status!==0){console.error('Local gate failed:',args.join(' '));process.exit(1);}
}
console.log('Local readiness gates passed. This does not certify production provider delivery, calibrated flood probabilities or deployment.');
