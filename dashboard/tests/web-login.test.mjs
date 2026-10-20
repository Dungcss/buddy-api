import assert from 'node:assert/strict';
import {createWebLogin} from '../web-login.mjs';
const nap=ms=>new Promise(r=>setTimeout(r,ms));
let polls=0,saves=0,registers=0;const secret='TEST_SECRET_MUST_NEVER_ESCAPE';
const mock=async(url,opts)=>{const p=new URL(url).pathname;let data,code=0;
if(p.endsWith('/auth/state'))data={state:'one-use-state',authUrl:'https://www.workbuddy.ai/login?ignored=anything'};
else if(p.endsWith('/auth/token')){polls++;if(polls===1)code=11217;else data={accessToken:secret,refreshToken:secret,domain:'www.workbuddy.ai'};}
else if(p.endsWith('/accounts'))data={accounts:[{uid:'test-user',lastLogin:true}]};
else assert.fail('unexpected path');return new Response(JSON.stringify({code,data}),{status:200});};
const flow=createWebLogin({fetchImpl:mock,intervalMs:5,saveAccount:async(id,session)=>{assert.equal(session.auth.accessToken,secret);saves++;return{ok:true}},registerAccount:async()=>{registers++;return true}});
const job=await flow.start('owner');assert.equal(job.status,'pending');assert.equal(flow.status('other',job.id),null);assert.equal(flow.cancel('other',job.id),null);assert(!JSON.stringify(job).includes(secret));assert(!job.loginUrl.includes('ignored'));
for(let i=0;i<80&&flow.status('owner',job.id).status!=='complete';i++)await nap(5);
assert.equal(flow.status('owner',job.id).status,'complete');assert.equal(saves,1);assert.equal(registers,1);assert(!JSON.stringify(flow.status('owner',job.id)).includes(secret));await nap(20);assert.equal(saves,1);flow.close();
const pending=async(url)=>new Response(JSON.stringify(new URL(url).pathname.endsWith('/state')?{code:0,data:{state:'state',authUrl:'https://www.workbuddy.ai/login'}}:{code:11217}),{status:200});
const cancel=createWebLogin({fetchImpl:pending,intervalMs:5,saveAccount:()=>assert.fail('cancel saved'),registerAccount:()=>assert.fail('cancel registered')});const a=await cancel.start('owner');const b=await cancel.start('owner');assert.equal(cancel.status('owner',a.id).status,'cancelled');assert.equal(cancel.cancel('owner',b.id).status,'cancelled');await nap(20);cancel.close();
const expire=createWebLogin({fetchImpl:pending,ttlMs:25,intervalMs:5,saveAccount:()=>assert.fail('expired saved'),registerAccount:()=>assert.fail('expired registered')});const e=await expire.start('owner');await nap(45);assert.equal(expire.status('owner',e.id).status,'expired');expire.close();
console.log(JSON.stringify({passed:true,checks:['pending-to-complete','save-and-register-once','owner-isolation','new-state-cancels-old','cancel','timeout','safe-response-allowlist']}));

