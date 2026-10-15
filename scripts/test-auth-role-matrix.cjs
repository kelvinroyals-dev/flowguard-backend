'use strict';
// Actual JWT middleware, permissions, estate guard and provider self-service
// over loopback HTTP + disposable PGlite. No .env, mail, production DB or users.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const {PGlite}=require('@electric-sql/pglite'),express=require('express'),request=require('supertest'),jwt=require('jsonwebtoken');
test('real JWT/SQL/HTTP role matrix isolates estates and applies live revocations and provider changes',async()=>{
  const db=new PGlite(),secret='synthetic-http-role-matrix-secret';let server,failDB=false,failPermissions=false;
  try{
    await db.exec(`
      CREATE TABLE users(id INT PRIMARY KEY,email TEXT,role TEXT,user_type TEXT,is_active BOOLEAN DEFAULT TRUE,token_version INT DEFAULT 0,service_provider_org_id INT,sp_role TEXT,account_owner_id INT,client_role TEXT);
      INSERT INTO users(id,email,role,user_type,account_owner_id,client_role,service_provider_org_id,sp_role) VALUES
       (1,'owner@example.invalid','client','client',NULL,NULL,NULL,NULL),
       (2,'member@example.invalid','client','client',1,'member',NULL,NULL),
       (3,'finance@example.invalid','client','client',1,'finance',NULL,NULL),
       (4,'viewer@example.invalid','client','client',1,'viewer',NULL,NULL),
       (5,'foreign@example.invalid','client','client',NULL,NULL,NULL,NULL),
       (6,'provider@example.invalid','client','service_provider',NULL,NULL,10,'owner_admin'),
       (7,'analyst@example.invalid','analyst','internal',NULL,NULL,NULL,NULL),
       (8,'dispatch@example.invalid','dispatcher','internal',NULL,NULL,NULL,NULL),
       (9,'admin@example.invalid','admin','internal',NULL,NULL,NULL,NULL);
      CREATE TABLE role_permissions(role TEXT,permission_key TEXT,allowed BOOLEAN,updated_at TIMESTAMPTZ DEFAULT NOW(),PRIMARY KEY(role,permission_key));
      CREATE TABLE properties(property_id TEXT PRIMARY KEY,property_name TEXT,user_id INT,latitude NUMERIC,longitude NUMERIC,location_verified BOOLEAN,state TEXT,city TEXT,parent_property_id TEXT);
      INSERT INTO properties VALUES('A','Synthetic A',1,6.4,3.5,TRUE,'Lagos','Ologolo',NULL),('B','Synthetic B',5,9,7,TRUE,'FCT','Garki',NULL);
      CREATE TABLE service_provider_organisations(id INT PRIMARY KEY,name TEXT,status TEXT);
      INSERT INTO service_provider_organisations VALUES(10,'Synthetic Provider A','active'),(20,'Synthetic Provider B','active');
    `);
    const pool={query:(sql,args)=>{
      if(failDB||failPermissions&&sql.includes('FROM role_permissions'))return Promise.reject(Error('Injected database failure'));
      return db.query(sql,args);
    }};
    let auth,permissions;
    function load(relative){
      const file=path.join(__dirname,'..',relative),normal=createRequire(file);
      const context=vm.createContext({module:{exports:{}},process:{env:{JWT_SECRET:secret}},console:{error:()=>{}},Date,Map,Set,Buffer,require:name=>{
        if(name==='../config/database')return pool;
        if(name==='../middleware/auth')return auth;
        if(name==='../utils/permissions'||name==='./permissions')return permissions;
        return normal(name);
      }});
      vm.runInContext(fs.readFileSync(file,'utf8'),context,{filename:relative});return context.module.exports;
    }
    auth=load('middleware/auth.js');permissions=load('utils/permissions.js');
    const estate=load('utils/propertyReadAccess.js'),providers=load('routes/serviceProviders.js');
    const app=express();app.use(express.json());app.use(auth.authenticateToken);
    app.get('/estate/:propertyId',async(req,res)=>{try{const row=await estate.readProperty(req,res);if(row)res.json({success:true,data:row});}catch(_){res.status(503).json({success:false});}});
    app.get('/ops/manage',permissions.requirePermission('jobs.manage'),(req,res)=>res.json({success:true}));
    app.use('/providers',providers);
    server=await new Promise((resolve,reject)=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));s.on('error',reject);});
    const token=(id,claims={})=>jwt.sign({id,tv:0,role:'admin',user_type:'internal',spo:10,sp_role:'owner_admin',...claims},secret,{expiresIn:'5m'});
    const get=(url,id)=>request(server).get(url).set('Authorization','Bearer '+token(id));
    for(const id of [1,2,4]){assert.equal((await get('/estate/A',id)).status,200);assert.equal((await get('/estate/B',id)).status,404);assert.equal((await get('/ops/manage',id)).status,403);}
    assert.equal((await get('/estate/A',3)).status,403);
    assert.equal((await get('/estate/A',5)).status,404);
    assert.equal((await get('/estate/A',6)).status,403);
    assert.equal((await get('/estate/A',7)).status,200);assert.equal((await get('/ops/manage',7)).status,403);
    assert.equal((await get('/ops/manage',8)).status,200);assert.equal((await get('/ops/manage',9)).status,200);
    await permissions.saveOverrides([{role:'dispatcher',permission_key:'jobs.manage',allowed:false}]);
    assert.equal((await get('/ops/manage',8)).status,403);
    await db.query("UPDATE users SET role='analyst' WHERE id=9");assert.equal((await get('/ops/manage',9)).status,403);
    const oldProviderToken=token(6);
    await db.query("UPDATE users SET service_provider_org_id=20,sp_role='field_technician' WHERE id=6");
    const provider=await request(server).get('/providers/me').set('Authorization','Bearer '+oldProviderToken);
    assert.equal(provider.status,200);assert.equal(provider.body.data.id,20);
    assert.equal((await request(server).put('/providers/me').set('Authorization','Bearer '+oldProviderToken).send({name:'Must not save'})).status,403);
    assert.equal((await request(server).get('/estate/A').set('Authorization','Bearer '+token(1,{purpose:'email_verify'}))).status,401);
    await db.query('UPDATE users SET token_version=1 WHERE id=2');assert.equal((await get('/estate/A',2)).status,401);
    await db.query('UPDATE users SET is_active=FALSE WHERE id=4');assert.equal((await get('/estate/A',4)).status,401);
    failPermissions=true;permissions.invalidate();assert.equal((await get('/ops/manage',8)).status,503);
    failPermissions=false;failDB=true;assert.equal((await get('/estate/A',1)).status,503);
    console.log('PASS: owner/member/viewer/finance/provider/staff boundaries, foreign-estate denial, live role and provider changes, purpose-token denial, revocation and fail-closed outages.');
  }finally{if(server)await new Promise(resolve=>server.close(resolve));await db.close();}
});
