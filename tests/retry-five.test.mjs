import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAccountPool,createGateway,retryUpstream,rateLimitWaitMs} from '../server.mjs';
const entry=id=>({id,adapter:{accountIdentity:async()=>id}});
const success=()=>({ok:true,response:new Response('data: '+JSON.stringify({id:'ok',choices:[{index:0,delta:{content:'OK'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})});

test('five retries means six calls maximum; fallback waits grow and final cooldown persists',async()=>{
 let time=1700000000000,calls=0;const waits=[];
 const pool=createAccountPool([entry('a')],'a',null,null,{now:()=>time});const lease=await pool.lease();
 const result=await retryUpstream(async()=>{calls++;return {ok:false,status:429};},{retries:5,deadlineAt:time+3600000,lease,now:()=>time,sleep:async ms=>{waits.push(ms);time+=ms;}});
 assert.equal(calls,6);assert.deepEqual(waits,[60000,120000,240000,480000,900000]);assert.equal(result.retryAfterSeconds,900);
 lease.release();await assert.rejects(pool.lease(),e=>e.code==='accounts_cooling_down');
});

test('Retry-After seconds/date overrides fallback and a sixth successful call recovers the account',async()=>{
 let time=1700000000000,calls=0;const waits=[];
 const pool=createAccountPool([entry('a')],'a',null,null,{now:()=>time});const lease=await pool.lease();
 const result=await retryUpstream(async()=>++calls===6?{ok:true}:{status:429,retryAfter:calls%2?'2':new Date(time+3000).toUTCString()}, {retries:5,deadlineAt:time+60000,lease,now:()=>time,sleep:async ms=>{waits.push(ms);time+=ms;}});
 assert.equal(result.ok,true);assert.equal(calls,6);assert.deepEqual(waits,[2000,3000,2000,3000,2000]);
 await lease.success();lease.release();assert.equal((await pool.rotationStatus()).entries[0].state,'ready');
 assert.equal(rateLimitWaitMs({retryAfter:'1800'},0,time),1800000);
});

test('wait beyond first-byte budget returns 429 early without bypassing cooldown',async()=>{
 let time=1700000000000,calls=0;const start=time;
 const pool=createAccountPool([entry('a')],'a',null,null,{now:()=>time});const lease=await pool.lease();
 const result=await retryUpstream(async()=>{calls++;return {status:429};},{retries:5,deadlineAt:start+120000,lease,now:()=>time,sleep:async ms=>{time+=ms;}});
 assert.equal(calls,2);assert.equal(time-start,60000);assert.equal(result.retryAfterSeconds,120);lease.release();
});

test('only one existing request reserves a retry; cancellation releases the reservation',async()=>{
 let time=1700000000000;const pool=createAccountPool([entry('a')],'a',null,null,{now:()=>time});
 const first=await pool.lease(),other=await pool.lease();
 await first.failure({status:429,retryAfter:'2'});await other.failure({status:429,retryAfter:'2'});
 let waiting,entered;const started=new Promise(r=>{entered=r});
 const controller=new AbortController();
 const pending=first.prepareRetry({signal:controller.signal,deadlineAt:time+10000,sleep:async()=>{entered();await new Promise((resolve,reject)=>{waiting=resolve;controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true});});}});
 await started;assert.equal(await other.prepareRetry({deadlineAt:time+10000}),false);
 time+=2000;await assert.rejects(pool.lease(),e=>e.status===429);
 controller.abort(new Error('cancelled'));await assert.rejects(pending,/cancelled/);first.release();other.release();
 const next=await pool.lease();next.release();
});

test('concurrent 429 extension is rechecked before the reserved attempt',async()=>{
 let time=1700000000000;const pool=createAccountPool([entry('a')],'a',null,null,{now:()=>time});
 const first=await pool.lease(),old=await pool.lease();await first.failure({status:429,retryAfter:'2'});
 const waits=[];let extended=false;
 assert.equal(await first.prepareRetry({deadlineAt:time+20000,sleep:async ms=>{time+=ms;waits.push(ms);if(!extended){extended=true;await old.failure({status:429,retryAfter:'3'});}}}),true);
 assert.deepEqual(waits,[2000,3000]);await first.success();first.release();old.release();
 assert.equal((await pool.rotationStatus()).entries[0].state,'ready');
});

test('daily quota and auth errors never retry; non-pool adapter also respects the maximum',async()=>{
 for(const outcome of [{status:429,dailyQuota:true},{status:429,kind:'hard_credit'},{status:401,kind:'session_dead'}]){
  let calls=0;await retryUpstream(async()=>{calls++;return outcome},{retries:5,deadlineAt:Date.now()+900000,sleep:()=>assert.fail('unexpected retry')});assert.equal(calls,1);
 }
 let time=1700000000000,calls=0;
 const result=await retryUpstream(async()=>{calls++;return {status:429,retryAfter:'1'};},{retries:5,deadlineAt:time+20000,now:()=>time,sleep:async ms=>{time+=ms;}});
 assert.equal(calls,6);assert.equal(result.retryAfterSeconds,1);
});

test('HTTP integration retries on the pinned account and logs attempts accurately',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'buddy-retry5-'));let aCalls=0,bCalls=0;
 const a=entry('a'),b=entry('b');
 a.adapter.listModels=async()=>[{id:'free',billing:{free:true}}];b.adapter.listModels=a.adapter.listModels;
 a.adapter.chatStream=async()=>++aCalls===1?{status:429,retryAfter:'0.02'}:success();
 b.adapter.chatStream=async()=>{bCalls++;return success()};
 const pool=createAccountPool([a,b],'a');const key='r'.repeat(40);const server=createGateway({adapter:pool,apiKey:key,limits:{upstreamRetries:5},accessLogDir:dir});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {
  const r=await fetch('http://127.0.0.1:'+server.address().port+'/v1/chat/completions',{method:'POST',headers:{'x-api-key':key,'content-type':'application/json','x-request-id':'retry-five-integration'},body:JSON.stringify({model:'free',messages:[{role:'user',content:'OK'}]})});
  assert.equal(r.status,200);assert.equal((await r.json()).choices[0].message.content,'OK');assert.equal(aCalls,2);assert.equal(bCalls,0);
  await new Promise(r=>setTimeout(r,60));
  const row=JSON.parse((await readFile(join(dir,'access-'+new Date().toISOString().slice(0,10).replaceAll('-','')+'.jsonl'),'utf8')).trim());
  assert.equal(row.account,'a');assert.equal(row.upstream_attempts,2);assert.equal(row.upstream_retries,1);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('streaming first-byte wait also respects the bounded timeout',async()=>{
 const a=entry('a');a.adapter.listModels=async()=>[{id:'free',billing:{free:true}}];
 a.adapter.chatStream=async(body,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
 const server=createGateway({adapter:createAccountPool([a],'a'),apiKey:'t'.repeat(40),limits:{nonStreamDeadlineMs:100,deadlineMs:2000}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const r=await fetch('http://127.0.0.1:'+server.address().port+'/v1/chat/completions',{method:'POST',headers:{'x-api-key':'t'.repeat(40),'content-type':'application/json'},body:JSON.stringify({model:'free',messages:[{role:'user',content:'OK'}],stream:true})});
  assert.equal(r.status,504);assert.equal((await r.json()).error.code,'timeout');
 }finally{await new Promise(r=>server.close(r));}
});
