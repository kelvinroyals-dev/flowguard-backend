// Authenticated realtime invalidations. Fetch contents through scoped REST.
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const { hasPermission } = require('../utils/permissions');
const { normalizeRole } = require('../utils/roles');
const { clientCan } = require('../utils/clientPermissions');
const TOPICS={alerts:'alerts.view',reports:'field-reports.view',sensors:'devices.view',teams:'teams.view'};
const STAFF=new Set(['admin','super_admin','operations_manager','dispatcher','field_lead','analyst','finance']);
const ESTATE=/^estate:([A-Za-z0-9_.-]{1,100})$/;
let io=null;
async function session(socket){
  const p=jwt.verify(socket.realtimeToken,process.env.JWT_SECRET,{algorithms:['HS256']});
  if(!p.id||!Number.isFinite(p.exp)||p.exp*1000<=Date.now())throw new Error('Invalid session');
  const {rows}=await pool.query('SELECT id, role, user_type, is_active, token_version, service_provider_org_id, account_owner_id, client_role FROM users WHERE id=$1',[p.id]);
  const u=rows[0];
  if(!u||u.is_active===false||Number(u.token_version||0)!==Number(p.tv||0))throw new Error('Session revoked');
  socket.user={...u,role:normalizeRole(u.role)};return p;
}
function staff(u){return STAFF.has(u.role)&&u.user_type!=='client'&&u.user_type!=='service_provider'&&!u.service_provider_org_id;}
async function allowed(socket,room){
  await session(socket);const u=socket.user;
  if(Object.hasOwn(TOPICS,room))return staff(u)&&await hasPermission(u.role,TOPICS[room]);
  const match=ESTATE.exec(room);if(!match)return false;
  if(staff(u))return await hasPermission(u.role,'properties.view');
  if(u.role!=='client'&&u.user_type!=='client')return false;
  if(!clientCan(u,'view_monitoring'))return false;
  const {rows}=await pool.query('SELECT 1 FROM properties WHERE property_id=$1 AND user_id=$2 LIMIT 1',[match[1],u.account_owner_id||u.id]);
  return rows.length>0;
}
function init(httpServer){
  io=new Server(httpServer,{
    cors:{origin:['https://app.flowguard.ng','https://neon.flowguard.ng','https://flowguard.ng'],credentials:true},
    transports:['websocket','polling'],maxHttpBufferSize:16384,
  });
  io.use(async(socket,next)=>{
    // Tokens in URL query strings are deliberately not accepted.
    const header=socket.handshake.headers?.authorization||'';
    socket.realtimeToken=socket.handshake.auth?.token||(header.startsWith('Bearer ')?header.slice(7):null);
    try{if(typeof socket.realtimeToken!=='string'||socket.realtimeToken.length>8192)throw new Error('No token');await session(socket);next();}
    catch(_){next(new Error('Authentication required'));}
  });
  io.on('connection',socket=>{
    let windowStart=Date.now(),requests=0;
    const timer=setInterval(()=>session(socket).catch(()=>socket.disconnect(true)),60000);timer.unref?.();
    socket.on('disconnect',()=>clearInterval(timer));
    socket.on('subscribe',async(room,ack)=>{
      const reply=result=>{if(typeof ack==='function')ack(result);};
      if(Date.now()-windowStart>=60000){windowStart=Date.now();requests=0;}
      if(++requests>30)return reply({ok:false,error:'Too many subscriptions'});
      if(typeof room!=='string'||(!Object.hasOwn(TOPICS,room)&&!ESTATE.test(room)))return reply({ok:false,error:'Subscription denied'});
      try{
        if(!await allowed(socket,room))return reply({ok:false,error:'Subscription denied'});
        if(!socket.connected)return;
        await socket.join(room);reply({ok:true});
      }catch(_){reply({ok:false,error:'Subscription unavailable'});socket.disconnect(true);}
    });
    socket.on('unsubscribe',(room,ack)=>{
      if(typeof room==='string'&&(Object.hasOwn(TOPICS,room)||ESTATE.test(room)))socket.leave(room);
      if(typeof ack==='function')ack({ok:true});
    });
  });
  console.log('Authenticated Socket.io invalidation layer active');return io;
}
// Only identifiers leave the server. No raw report contents, notes or contacts.
// Missing estate routing metadata fails closed; REST/polling remains available.
async function emit(event,payload={},room){
  if(!io||!Object.hasOwn(TOPICS,room))return;
  const notice={refresh:true};
  for(const key of ['property_id','alert_id','report_id','sensor_id','team_id']){
    if(typeof payload[key]==='string'||typeof payload[key]==='number')notice[key]=String(payload[key]);
  }
  const rooms=[room];
  if(notice.property_id&&ESTATE.test('estate:'+notice.property_id))rooms.push('estate:'+notice.property_id);
  const delivered=new Set();
  // Single-process adapter. Multi-process deployment needs an equivalent
  // authorization-aware service, not a blind remote-room broadcast.
  for(const target of rooms)for(const socket of io.sockets.sockets.values()){
    if(delivered.has(socket.id)||!socket.rooms.has(target))continue;
    try{
      if(!await allowed(socket,target)){await socket.leave(target);continue;}
      if(!socket.connected||!socket.rooms.has(target))continue;
      if(target.startsWith('estate:'))socket.emit('estate:changed',{property_id:notice.property_id,refresh:true});
      else socket.emit(event,notice);
      delivered.add(socket.id);
    }catch(_){socket.disconnect(true);}
  }
}
// Existing emitters are fire-and-forget; never reject into a completed write.
const send=(...args)=>emit(...args).catch(()=>console.error('[realtime] delivery unavailable'));
const events={
  alertNew:a=>send('alert:new',a,'alerts'),alertResolved:a=>send('alert:resolved',a,'alerts'),
  reportNew:r=>send('report:new',r,'reports'),reportUpdated:r=>send('report:updated',r,'reports'),reportSent:r=>send('report:sent',r,'reports'),
  sensorUpdate:s=>send('sensor:update',s,'sensors'),teamStatus:t=>send('team:status',t,'teams'),
};
module.exports={init,emit:send,events,getIO:()=>io};
