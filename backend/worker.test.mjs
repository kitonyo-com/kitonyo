import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker,{priceCart,paymentMatches,TERMS} from './worker.mjs';
function database(){const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));return {prepare(query){return {bind(...params){return {async first(){return sql.prepare(query).get(...params)||null;},async all(){return {results:sql.prepare(query).all(...params)};},async run(){return {meta:{changes:Number(sql.prepare(query).run(...params).changes)}};}};},async all(){return {results:sql.prepare(query).all()};}};}};}
const origin='https://kitonyo.com',token='a'.repeat(64),id='11111111-1111-4111-8111-111111111111';
let env,providerCalls,session;
beforeEach(()=>{
 env={DB:database(),ASSETS:{fetch:()=>new Response('static')},PAYMENTS_ENABLED:'true',PAYNECTA_PUBLIC_KEY:'test-fixture-public',PAYNECTA_SECRET_KEY:'test-fixture-secret',PAYNECTA_TAPFLOW:'kitonyo'};
 providerCalls=[];session={id:'chk_fixture',url:'https://pay.paynecta.co.ke/s/chk_fixture#session-fixture',amount:500000,currency:'KES',reference:id};
 globalThis.fetch=async(url,options)=>{providerCalls.push({url,options});if(url.endsWith('/auth/token'))return Response.json({status:true,data:{access_token:'token-fixture',expires_in:3600}});return Response.json({status:true,data:session});};
});
function payload(extra={}){return {items:[{id:'basic',quantity:1}],currency:'KES',language:'en',termsVersion:TERMS,acceptTerms:true,customer:{name:'Test Customer',email:'customer@example.com',brief:'Example business website'},...extra};}
function create(body=payload(),key=id,auth=token){return worker.fetch(new Request(origin+'/api/checkout',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Authorization:'Bearer '+auth,'Idempotency-Key':key},body:JSON.stringify(body)}),env);}
test('prices come only from the server catalog, including quantities',()=>{
 assert.equal(priceCart([{id:'basic',quantity:2,amount:1}]).amount,1000000);
 for(const items of [[],[{id:'__proto__',quantity:1}],[{id:'basic',quantity:0}],[{id:'basic',quantity:1.5}],[{id:'basic',quantity:11}],[{id:'basic',quantity:1},{id:'basic',quantity:1}],[{id:'basic',quantity:1},{id:'signature',quantity:1}]])assert.throws(()=>priceCart(items));
});
test('rejects unsupported currencies and missing consent before contacting provider',async()=>{
 assert.equal((await create(payload({currency:'USD'}))).status,400);
 assert.equal((await create(payload({acceptTerms:false}))).status,400);
 assert.equal(providerCalls.length,0);
});
test('backend passes exact catalog amount and fixed frame origin; no customer PII goes to PayNecta',async()=>{
 const response=await create();assert.equal(response.status,201);
 const sent=JSON.parse(providerCalls.find(x=>x.url.endsWith('/checkout_sessions')).options.body);
 assert.deepEqual(sent,{tapflow:'kitonyo',amount:500000,reference:id,redirect_url:origin+'/payment-success.html',cancel_url:origin+'/index.html',frame_origins:[origin]});
 const stored=await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();assert.equal(stored.terms_version,TERMS);assert.notEqual(stored.token_hash,token);
});
test('same order retry does not create a second session; changed basket is rejected',async()=>{
 await create();const retry=await create();assert.equal(retry.status,200);
 assert.equal(providerCalls.filter(x=>x.url.endsWith('/checkout_sessions')).length,1);
 assert.equal((await create(payload({items:[{id:'logo',quantity:1}]}))).status,409);
 assert.equal((await create(payload(),id,'b'.repeat(64))).status,401);
});
test('ambiguous provider timeout cannot create a duplicate session on retry',async()=>{
 globalThis.fetch=async()=>{throw Error('timeout');};
 assert.equal((await create()).status,503);assert.equal((await create()).status,409);
 const stored=await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();assert.equal(stored.state,'creating');
});
test('only a matching succeeded provider payment settles the order',async()=>{
 const order={session_id:'chk_fixture',id,amount:500000};
 const paid={...session,payment:{status:'succeeded',reference:'PN-FIXTURE',amount:500000,merchant_reference:id}};
 assert.ok(paymentMatches(order,paid));
 for(const changed of [{currency:'USD'},{amount:1},{id:'chk_other'},{reference:'other'},{payment:{...paid.payment,status:'pending'}},{payment:{...paid.payment,amount:1}},{payment:{...paid.payment,merchant_reference:'other'}},{payment:undefined}])assert.equal(paymentMatches(order,{...paid,...changed}),false);
});
test('order status requires its secret capability and persists server-verified settlement',async()=>{
 await create();session.payment={status:'succeeded',reference:'PN-FIXTURE',amount:500000,merchant_reference:id};
 const req=auth=>new Request(origin+'/api/orders/'+id,{headers:{Origin:origin,Authorization:'Bearer '+auth}});
 assert.equal((await worker.fetch(req('b'.repeat(64)),env)).status,404);
 const res=await worker.fetch(req(token),env);assert.equal((await res.json()).state,'paid');
 const stored=await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();assert.equal(stored.state,'paid');assert.equal(stored.checkout_url,null);
});
test('forged return URL and pending/provider_error never settle a payment',async()=>{
 await create();session.payment={status:'provider_error',amount:500000,merchant_reference:id};
 await worker.fetch(new Request(origin+'/payment-success.html?paid=true'),env);
 const res=await worker.fetch(new Request(origin+'/api/orders/'+id,{headers:{Authorization:'Bearer '+token}}),env);
 assert.equal((await res.json()).state,'pending');
});
test('configuration fails closed and hostile origins have no API access',async()=>{
 env.PAYMENTS_ENABLED='false';assert.equal((await create()).status,503);
 const catalog=await worker.fetch(new Request(origin+'/api/catalog'),env);assert.equal((await catalog.json()).enabled,false);
 const denied=await worker.fetch(new Request(origin+'/api/catalog',{headers:{Origin:'https://attacker.example'}}),env);assert.equal(denied.status,403);assert.equal(denied.headers.get('Access-Control-Allow-Origin'),null);
});
test('rate limit prevents unbounded creation by the same client',async()=>{
 for(let i=0;i<6;i++){const key=crypto.randomUUID();session={...session,reference:key,id:'chk_fixture'+i,url:'https://pay.paynecta.co.ke/s/chk_fixture'+i+'#session-fixture'};assert.equal((await create(payload(),key)).status,201);}
 assert.equal((await create(payload(),crypto.randomUUID())).status,429);
});
test('scheduled reconciliation verifies a payment even after the browser is closed',async()=>{
 await create();session.payment={status:'succeeded',reference:'PN-FIXTURE',amount:500000,merchant_reference:id};await worker.scheduled({},env,{});
 assert.equal((await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(id).first()).state,'paid');
});
