import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAccountPool,createGateway} from '../server.mjs';
import {createAdapterRuntime} from '../adapter.mjs';
const entry=(id,identity=id)=>({id,adapter:{accountIdentity:async()=>identity,status:async()=>({signedIn:true}),listModels:async()=>[{id:'free',billing:{free:true}}],chatStream:async()=>({ok:true,response:new Response('data: '+JSON.stringify({id:'x',choices:[{index:0,delta:{content:id},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})})}});
test('round robin deduplicates identities and pins leases across manual switches',async()=>{
 const p=createAccountPool([entry('live','one'),entry('a','one'),entry('b','two')],'a');
 const leases=await Promise.all([p.lease(),p.lease(),p.lease(),p.lease()]);
 assert.deepEqual(leases.map(l=>l.accountId),['a','b','a','b']);
 await p.setActive('b'); assert.equal(leases[0].accountId,'a');
 assert.equal((await p.lease()).accountId,'b');
 assert.equal((await p.rotationStatus()).entries.find(e=>e.id==='live').aliasOf,'a');
});
test('cooldown sequence/cap, one probe, stale success cannot erase cooldown',async()=>{
 let time=1700000000000; const p=createAccountPool([entry('a')],'a',null,null,{now:()=>time});
 const old=await p.lease();
 for(const seconds of [60,120,240,480,900,900]) {
  const l=await p.lease(), result={status:429}; await l.failure(result); l.release();
  assert.equal(result.retryAfterSeconds,seconds);
  await old.success(); await assert.rejects(p.lease(),e=>e.status===429);
  time+=seconds*1000;
  const probe=await p.lease(); await assert.rejects(p.lease(),e=>e.status===429); probe.release();
 }
 const good=await p.lease(); await good.success();good.release();assert.equal((await p.rotationStatus()).entries[0].state,'ready');
 const fresh=await p.lease(),result={status:429};await fresh.failure(result);assert.equal(result.retryAfterSeconds,60);
});
test('Retry-After seconds/date, daily reset, auth disable, relogin and persistence',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'buddy-rotation-'));try {
 let time=1700000000000;const file=join(dir,'state.json');
 const p=createAccountPool([entry('a')],'a',file,async id=>entry(id),{now:()=>time});
 for(const [retryAfter,seconds] of [['1800',1800],[new Date(time+2100000).toUTCString(),300]]) {
  const l=await p.lease(),r={status:429,retryAfter};await l.failure(r);l.release();assert.equal(r.retryAfterSeconds,seconds);time+=seconds*1000;
 }
 let l=await p.lease();await l.failure({status:402,dailyQuota:true,resetAt:time+700000});l.release();
 assert.equal(Date.parse((await p.rotationStatus()).entries[0].retryAt),time+700000);
 let saved=JSON.parse(await readFile(file,'utf8'));
 const restored=createAccountPool([entry('a')],saved.active,null,null,{...saved,now:()=>time});await assert.rejects(restored.lease(),e=>e.status===429);
 time+=700000;l=await p.lease();await l.failure({code:'workbuddy_auth_unavailable'});l.release();await assert.rejects(p.lease(),e=>e.status===503);
 await p.add('a');assert.equal((await p.lease()).accountId,'a');
 await p.add('b');assert.equal(p.accountId,'a');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('concurrent HTTP requests and access log keep the leased account',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'buddy-access-'));const p=createAccountPool([entry('a'),entry('b')],'a');
 const key='k'.repeat(40),server=createGateway({adapter:p,apiKey:key,accessLogDir:dir});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
 const url='http://127.0.0.1:'+server.address().port;
 const results=await Promise.all([1,2].map(async i=>{
 const r=await fetch(url+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json','x-request-id':'rotation-'+i},body:JSON.stringify({model:'free',messages:[{role:'user',content:'test'}]})});assert.equal(r.status,200);return (await r.json()).choices[0].message.content;
 }));
 assert.deepEqual(results,['a','b']);await new Promise(r=>setTimeout(r,60));
 const rows=(await readFile(join(dir,'access-'+new Date().toISOString().slice(0,10).replaceAll('-','')+'.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 for(let i=0;i<2;i++)assert.equal(rows.find(r=>r.request_id==='rotation-'+(i+1)).account,results[i]);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
test('adapter refreshes auth once, shares concurrent refresh, and sanitizes failures',async()=>{
 let refreshes=0,calls=0;let credential={uid:'u',domain:'test',accessToken:'old-secret',refreshToken:'refresh-secret',expiresAtMs:Date.now()+3600000};
 const store={resolve:async()=>credential,current:async()=>credential,saveOwn:async c=>{credential=c}};
 const shared={L:()=> 'global',j:m=>m};
 const client={fetchModels:async()=>[{id:'free',billing:{free:true}}],refreshToken:async()=>{refreshes++;await new Promise(r=>setTimeout(r,10));return {accessToken:'new-secret',expiresInSec:3600}},chatStream:async c=>{calls++;return c.accessToken==='old-secret'?{ok:false,status:401,kind:'session_dead',message:'old-secret'}:{ok:true,response:new Response()}}};
 const a=createAdapterRuntime({shared,client,store});
 await Promise.all([a.chatStream({model:'free',messages:[]}),a.chatStream({model:'free',messages:[]})]);assert.equal(refreshes,1);assert.equal(calls,4);
 client.chatStream=async()=>({ok:false,status:429,kind:'soft_rate',retryAfter:'120',message:'new-secret daily quota exceeded'});
 const result=await a.chatStream({model:'free',messages:[]});assert.equal(result.retryAfter,'120');assert.equal(result.dailyQuota,true);assert(!JSON.stringify(result).includes('secret'));
 client.chatStream=async()=>({ok:false,status:403,kind:'client'});await a.chatStream({model:'free',messages:[]});assert.equal(refreshes,2);
 client.refreshToken=async()=>{refreshes++;throw new Error('new-secret')};await assert.rejects(a.chatStream({model:'free',messages:[]}),e=>e.code==='workbuddy_auth_unavailable'&&!e.message.includes('secret'));
});
