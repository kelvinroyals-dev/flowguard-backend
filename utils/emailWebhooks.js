const {createHmac,timingSafeEqual}=require('node:crypto');
const TYPES=['email.sent','email.delivered','email.delivery_delayed','email.bounced','email.complained','email.failed','email.suppressed'];
function verify(raw,headers,secret,now=Date.now()){
 if(!Buffer.isBuffer(raw)||typeof secret!=='string'||!/^whsec_[A-Za-z0-9+/]+=*$/.test(secret))throw Error('Invalid webhook');
 const id=headers['svix-id'],timestamp=headers['svix-timestamp'],signature=headers['svix-signature'];
 if(typeof id!=='string'||!/^[-\w]{1,200}$/.test(id)||typeof timestamp!=='string'||!/^\d{10}$/.test(timestamp)||typeof signature!=='string'||signature.length>2000||Math.abs(now/1000-Number(timestamp))>300)throw Error('Invalid webhook');
 const key=Buffer.from(secret.slice(6),'base64');if(key.length<16)throw Error('Invalid webhook');
 const expected=createHmac('sha256',key).update(id+'.'+timestamp+'.').update(raw).digest();
 const valid=signature.split(' ').some(part=>{const [version,value]=part.split(',');if(version!=='v1'||!value||!/^[A-Za-z0-9+/]+=*$/.test(value))return false;const supplied=Buffer.from(value,'base64');return supplied.length===expected.length&&timingSafeEqual(supplied,expected);});
 if(!valid)throw Error('Invalid webhook');return JSON.parse(raw.toString('utf8'));
}
async function reconcile(pool){
 // Authenticated webhooks may arrive before the send receipt commits.
 await pool.query(`UPDATE email_outbox o SET delivery_status=x.event_type,delivery_updated_at=x.event_at
   FROM(SELECT DISTINCT ON(provider_id)provider_id,event_type,event_at FROM email_webhook_events
     ORDER BY provider_id,CASE event_type WHEN 'email.complained' THEN 7 WHEN 'email.bounced' THEN 6 WHEN 'email.failed' THEN 5 WHEN 'email.suppressed' THEN 4 WHEN 'email.delivered' THEN 3 WHEN 'email.delivery_delayed' THEN 2 ELSE 1 END DESC,event_at DESC)x
   WHERE o.provider_id=x.provider_id AND (o.delivery_status IS DISTINCT FROM x.event_type OR o.delivery_updated_at IS DISTINCT FROM x.event_at)`);
 await pool.query(`INSERT INTO email_suppressions(recipient,reason)
   SELECT DISTINCT LOWER(recipient),delivery_status FROM email_outbox WHERE delivery_status IN ('email.bounced','email.complained')
   ON CONFLICT(recipient) DO NOTHING`);
}
function createHandler({pool,secret,now=()=>Date.now()}){
 return async(req,res)=>{
  if(!secret)return res.status(503).json({success:false,error:'Webhook verification not configured'});
  let e;try{e=verify(req.body,req.headers,secret,now());}catch(_){return res.status(400).json({success:false,error:'Invalid webhook'});}
  if(!TYPES.includes(e.type))return res.json({success:true,ignored:true});
  const id=e.data?.email_id,time=new Date(e.created_at);
  if(typeof id!=='string'||id.length>200||!Number.isFinite(time.getTime())||time.getTime()>now()+300000)return res.status(400).json({success:false,error:'Invalid event data'});
  try{
   await pool.query('INSERT INTO email_webhook_events(id,provider_id,event_type,event_at) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING',[req.headers['svix-id'],id,e.type,time]);
   await reconcile(pool);return res.json({success:true});
  }catch(_){return res.status(503).json({success:false,error:'Receipt persistence unavailable'});}
 };
}
module.exports={verify,reconcile,createHandler};
