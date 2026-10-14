// Loopback only. Database responses are stubbed; no configured DB is loaded.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),http=require('node:http');
const jwt=require('jsonwebtoken'),{Server}=require('socket.io'),{io:clientIO}=require('socket.io-client');
test('realtime authentication, authorization, tenant isolation and safe delivery',async()=>{
 const previous=process.env.JWT_SECRET;process.env.JWT_SECRET='local-test-secret-not-a-deployment-credential';
 const users=new Map([[1,{role:'admin'}],[2,{role:'client',user_type:'client'}],[3,{role:'client',user_type:'client'}],[4,{role:'service_provider',user_type:'service_provider',service_provider_org_id:10}],[5,{role:'finance'}]]);
 let failDB=false,denyReports=false;const clients=[];
 const pool={query:async(sql,args)=>{
  if(failDB)throw Error('Database unavailable');
  if(sql.includes('FROM users'))return {rows:users.has(args[0])?[{id:args[0],is_active:true,token_version:0,...users.get(args[0])}]:[]};
  if(sql.includes('FROM properties'))return {rows:args[0]==='estate-a'&&args[1]===2?[{}]:[]};
  throw Error('Unexpected query');
 }};
 const context=vm.createContext({require:name=>({'socket.io':{Server},jsonwebtoken:jwt,'../config/database':pool,'../utils/permissions':{hasPermission:async(role,key)=>role==='admin'&&!(denyReports&&key==='field-reports.view')},'../utils/roles':{normalizeRole:r=>r},'../utils/clientPermissions':require('../utils/clientPermissions')}[name]||(()=>{throw Error('Unexpected import');})()),module:{exports:{}},process,console,setInterval,clearInterval,Date,Set,Object});
 vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../realtime/io.js'),'utf8'),context);
 const realtime=context.module.exports,server=http.createServer();const sio=realtime.init(server);
 const token=(id,options={})=>jwt.sign({id,tv:0,...options},process.env.JWT_SECRET,{algorithm:'HS256',expiresIn:'5m'});
 let base;
 const connect=async(auth={},extra={})=>{
  const socket=clientIO(base,{auth,forceNew:true,reconnection:false,transports:['websocket'],...extra});clients.push(socket);
  return new Promise((resolve,reject)=>{socket.once('connect',()=>resolve(socket));socket.once('connect_error',reject);});
 };
 const subscribe=(socket,room)=>new Promise((resolve,reject)=>socket.timeout(1500).emit('subscribe',room,(err,result)=>err?reject(err):resolve(result)));
 const received=(socket,event)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Event not received: '+event)),1500);socket.once(event,p=>{clearTimeout(timer);resolve(p);});});
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
  await assert.rejects(connect(),/Authentication required/);
  await assert.rejects(connect({token:'invalid'}),/Authentication required/);
  await assert.rejects(connect({token:jwt.sign({id:2,tv:0,exp:1},process.env.JWT_SECRET,{algorithm:'HS256'})}),/Authentication required/);
  await assert.rejects(connect({}, {query:{token:token(2)}}),/Authentication required/);
  const admin=await connect({token:token(1)}),a=await connect({token:token(2)}),b=await connect({token:token(3)}),sp=await connect({token:token(4)}),finance=await connect({token:token(5)});
  assert.equal((await subscribe(admin,'reports')).ok,true);
  for(const socket of [a,b,sp,finance])assert.equal((await subscribe(socket,'reports')).ok,false);
  assert.equal((await subscribe(a,'estate:estate-a')).ok,true);
  assert.equal((await subscribe(b,'estate:estate-a')).ok,false);
  assert.equal((await subscribe(a,'estate:estate-b')).ok,false);
  assert.equal((await subscribe(sp,'estate:estate-a')).ok,false);
  assert.equal((await subscribe(admin,'arbitrary-private-room')).ok,false);
  assert.equal((await subscribe(admin,'__proto__')).ok,false);
  const staffEvent=received(admin,'report:sent'),estateEvent=received(a,'estate:changed');let leaked=0;
  b.on('estate:changed',()=>leaked++);a.on('report:sent',()=>leaked++);
  await realtime.events.reportSent({report_id:'report-a',property_id:'estate-a',private_notes:'never transmit',client_email:'private@example.invalid'});
  assert.deepEqual(await staffEvent,{refresh:true,property_id:'estate-a',report_id:'report-a'});
  assert.deepEqual(await estateEvent,{property_id:'estate-a',refresh:true});assert.equal(leaked,0);
  // Generic broadcasts without an allowlisted topic are disabled.
  await realtime.emit('private:event',{secret:'never transmit'});
  denyReports=true;await realtime.events.reportSent({report_id:'report-b'});
  assert.equal(sio.sockets.sockets.get(admin.id).rooms.has('reports'),false);
  users.get(2).token_version=1;
  const disconnected=received(a,'disconnect');await realtime.events.reportSent({property_id:'estate-a'});await disconnected;
  await assert.rejects(connect({token:token(2)}),/Authentication required/);
  users.get(3).is_active=false;await assert.rejects(connect({token:token(3)}),/Authentication required/);
  failDB=true;await assert.rejects(connect({token:token(1)}),/Authentication required/);
 }finally{
  clients.forEach(socket=>socket.disconnect());await new Promise(resolve=>sio.close(resolve));
  if(previous===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=previous;
 }
});
