// No network, no configured DB, no timers. Real JWT signatures + stub transport.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const jwt=require('jsonwebtoken');
test('realtime fails closed, scopes subscriptions and strips event contents',async()=>{
 const users=new Map([[1,{role:'admin'}],[2,{role:'client',user_type:'client'}],[3,{role:'client',user_type:'client'}],[4,{role:'service_provider',service_provider_org_id:7}],[5,{role:'finance'}]]);
 let failDB=false,denyReports=false,owner=2;const ticks=[];const db={query:async(sql,args)=>{
  if(failDB)throw Error('Unavailable');
  if(sql.includes('FROM users'))return {rows:users.has(args[0])?[{id:args[0],token_version:0,is_active:true,...users.get(args[0])}]:[]};
  if(sql.includes('FROM properties'))return {rows:args[0]==='a'&&args[1]===owner?[{}]:[]};
  throw Error('Unexpected SQL');
 }};
 class Server{constructor(){this.sockets={sockets:new Map()};}use(fn){this.middleware=fn;}on(name,fn){this[name]=fn;}}
 class Socket{
  constructor(id,auth){this.id=id;this.handshake={auth,headers:{}};this.connected=true;this.rooms=new Set([id]);this.handlers={};this.out=[];}
  on(name,fn){this.handlers[name]=fn;}join(room){this.rooms.add(room);}leave(room){this.rooms.delete(room);}
  emit(name,data){this.out.push({name,data:JSON.parse(JSON.stringify(data))});}
  disconnect(){this.connected=false;this.handlers.disconnect?.();}
 }
 const secret='unit-test-only-secret';
 const context=vm.createContext({require:name=>({'socket.io':{Server},jsonwebtoken:jwt,'../config/database':db,'../utils/permissions':{hasPermission:async(role,key)=>role==='admin'&&!(denyReports&&key==='field-reports.view')},'../utils/roles':{normalizeRole:r=>r},'../utils/clientPermissions':require('../utils/clientPermissions')}[name]),module:{exports:{}},process:{env:{JWT_SECRET:secret}},console,Date,Set,Object,setInterval:fn=>{ticks.push(fn);return {unref(){}};},clearInterval(){}});
 vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../realtime/io.js'),'utf8'),context);
 const rt=context.module.exports,io=rt.init({}),token=(id,extra={})=>jwt.sign({id,tv:0,exp:Math.floor(Date.now()/1000)+300,...extra},secret);
 const connect=async(id,auth={token:token(id)})=>{const socket=new Socket(String(id),auth);const err=await new Promise(resolve=>io.middleware(socket,resolve));if(err)throw err;io.sockets.sockets.set(socket.id,socket);io.connection(socket);return socket;};
 const subscribe=async(s,room)=>{let result;await s.handlers.subscribe(room,r=>result=r);return result;};
 await assert.rejects(connect(10,{}),/Authentication required/);
 await assert.rejects(connect(10,{token:'invalid'}),/Authentication required/);
 await assert.rejects(connect(2,{token:token(2,{exp:1})}),/Authentication required/);
 for(const purpose of ['email_verify','evidence','report-snapshot'])await assert.rejects(connect(1,{token:token(1,{purpose})}),/Authentication required/);
 await assert.rejects(connect(999),/Authentication required/);
 const admin=await connect(1),a=await connect(2),b=await connect(3),sp=await connect(4),finance=await connect(5);
 users.set(6,{role:'client',user_type:'client',account_owner_id:2,client_role:'member'});
 users.set(7,{role:'client',user_type:'client',account_owner_id:2,client_role:'finance'});
 const member=await connect(6),clientFinance=await connect(7);
 assert.equal((await subscribe(member,'estate:a')).ok,true);assert.equal((await subscribe(clientFinance,'estate:a')).ok,false);
 assert.equal((await subscribe(admin,'reports')).ok,true);
 for(const socket of [a,b,sp,finance])assert.equal((await subscribe(socket,'reports')).ok,false);
 assert.equal((await subscribe(a,'estate:a')).ok,true);
 assert.equal((await subscribe(b,'estate:a')).ok,false);assert.equal((await subscribe(a,'estate:b')).ok,false);
 assert.equal((await subscribe(sp,'estate:a')).ok,false);
 for(const room of ['__proto__','arbitrary',{},null])assert.equal((await subscribe(admin,room)).ok,false);
 await rt.events.reportSent({property_id:'a',report_id:'r1',notes:'secret',email:'private'});
 assert.deepEqual(admin.out,[{name:'report:sent',data:{refresh:true,property_id:'a',report_id:'r1'}}]);
 assert.deepEqual(a.out,[{name:'estate:changed',data:{property_id:'a',refresh:true}}]);assert.equal(b.out.length,0);assert.equal(sp.out.length,0);
 await rt.emit('private:event',{secret:'x'});assert.equal(admin.out.length,1);
 // Ownership removal and permission revocation take effect at next delivery.
 owner=3;
 denyReports=true;await rt.events.reportSent({property_id:'a'});
 assert.equal(a.rooms.has('estate:a'),false);assert.equal(admin.rooms.has('reports'),false);
 admin.realtimeToken=token(1,{exp:1});await rt.emit('report:sent',{},'reports');
 await assert.rejects(connect(1,{token:admin.realtimeToken}),/Authentication required/);
 users.get(3).token_version=1;await assert.rejects(connect(3),/Authentication required/);
 users.get(5).is_active=false;await assert.rejects(connect(5),/Authentication required/);
 failDB=true;await assert.rejects(connect(1),/Authentication required/);
 await Promise.all(ticks.map(fn=>fn()));assert.equal(finance.connected,false);
 assert.match(fs.readFileSync(require('node:path').join(__dirname,'../realtime/io.js'),'utf8'),/handshake\.auth\?\.token/);
 assert.doesNotMatch(fs.readFileSync(require('node:path').join(__dirname,'../realtime/io.js'),'utf8'),/handshake\.query/);
});
