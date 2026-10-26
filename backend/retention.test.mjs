import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import worker,{TERMS,priceCart} from './worker.mjs';
import {RETENTION,sessionMatches,expiredUnpaid,paymentMatches,recordExpiredClosure,approveClosure,runRetention} from './retention.mjs';

const NOW=Date.UTC(2026,9,26,12),DAY=86400000;
const ORIGIN='https://kitonyo.com',TOKEN='a'.repeat(64);
const legacySchema=`CREATE TABLE orders (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, request_hash TEXT NOT NULL,
 amount INTEGER NOT NULL,currency TEXT NOT NULL CHECK(currency='KES'),
 items TEXT NOT NULL,customer TEXT NOT NULL,language TEXT NOT NULL,
 terms_version TEXT NOT NULL,early_start INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL DEFAULT 'creating',session_id TEXT UNIQUE,checkout_url TEXT,
 payment_reference TEXT,created_at INTEGER NOT NULL,checked_at INTEGER,paid_at INTEGER
); CREATE TABLE rate_limits(bucket TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);`;
const digest=value=>createHash('sha256').update(value).digest('hex');
const customer=()=>({name:'Fixture Customer',email:'private-customer@example.com',brief:'A confidential client project brief'});
const fixtureItems=()=>[{id:'domain',quantity:1,amount:65000,domain:'private-client.example'}];

// This adapter executes real SQLite statements and atomic batches, rather than
// simulating the cleanup SQL. No test can contact a payment service.
function database({legacy=false}={}){
 const sql=new DatabaseSync(':memory:');
 sql.exec('PRAGMA foreign_keys=ON');
 sql.exec(legacy?legacySchema:readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
 const statement=(query,params=[])=>({
  bind(...values){return statement(query,values);},
  async first(){return sql.prepare(query).get(...params)||null;},
  async all(){return {results:sql.prepare(query).all(...params)};},
  async run(){return {meta:{changes:Number(sql.prepare(query).run(...params).changes)}};}
 });
 return {
  sql,prepare:statement,
  async exec(query){sql.exec(query);},
  async batch(statements){
   sql.exec('BEGIN IMMEDIATE');
   try{const results=[];for(const prepared of statements)results.push(await prepared.run());sql.exec('COMMIT');return results;}
   catch(error){sql.exec('ROLLBACK');throw error;}
  }
 };
}
function environment(db=database()){
 return {DB:db,ORDER_RETENTION_ENABLED:'true',ASSETS:{fetch:()=>new Response('static')},
  PAYMENTS_ENABLED:'true',PAYNECTA_PUBLIC_KEY:'fixture-public',PAYNECTA_SECRET_KEY:'fixture-secret',PAYNECTA_TAPFLOW:'kitonyo'};
}
function order(db,changes={}){
 const number=db.sql.prepare('SELECT COUNT(*) AS n FROM orders').get().n+1;
 const id='11111111-1111-4111-8111-'+String(number).padStart(12,'0');
 const row={id,token_hash:digest(TOKEN),request_hash:'private-fingerprint',amount:65000,currency:'KES',
  items:JSON.stringify(fixtureItems()),customer:JSON.stringify(customer()),language:'en',terms_version:TERMS,
  early_start:0,state:'pending',session_id:'chk_fixture'+number,checkout_url:'https://pay.paynecta.co.ke/s/chk_fixture'+number+'#private-secret',
  payment_reference:null,created_at:NOW-40*DAY,checked_at:null,paid_at:null,...changes};
 const columns=Object.keys(row);
 db.sql.prepare('INSERT INTO orders('+columns.join(',')+') VALUES('+columns.map(()=>'?').join(',')+')').run(...columns.map(key=>row[key]));
 return row;
}
const saved=(db,id)=>db.sql.prepare('SELECT * FROM orders WHERE id=?').get(id)||null;
const retention=(db,id)=>db.sql.prepare('SELECT * FROM order_retention WHERE order_id=?').get(id)||null;
const expired=record=>({id:record.session_id,reference:record.id,amount:record.amount,currency:'KES',status:'expired'});
const succeeded=record=>({...expired(record),status:'paying',payment:{status:'succeeded',reference:'PN-FIXTURE',amount:record.amount,merchant_reference:record.id}});
async function closed(db,{age=RETENTION.PII_MS,approved=true,...changes}={}){
 const closedAt=NOW-age;
 const row=order(db,{created_at:closedAt-DAY,...changes});
 await recordExpiredClosure(db,row,expired(row),closedAt);
 assert.equal(saved(db,row.id).state,'expired','fixture must represent a persisted provider-confirmed expiry');
 assert.equal(retention(db,row.id).closed_at,closedAt);
 if(approved){
  const accepted=await approveClosure(db,{id:row.id,evidenceRef:'fixture-case/2026-closed',expectedClosureAt:closedAt,now:closedAt,confirmNoObligation:true});
  assert.equal(accepted,true,'fixture approval must certify this exact closure');
 }
 return saved(db,row.id);
}
function providerFixture(t,db){
 const calls=[];
 t.mock.method(globalThis,'fetch',async(url,options={})=>{
  calls.push({url:String(url),method:options.method||'GET'});
  if(String(url).endsWith('/auth/token'))return Response.json({status:true,data:{access_token:'fixture-access',expires_in:3600}});
  if(String(url).includes('/tapflows?'))return Response.json({status:true,data:[{slug:'kitonyo',active:true,open_amount:true,can_collect:true}]});
  if(String(url).endsWith('/balance'))return Response.json({status:true,data:{can_collect:true}});
  if(String(url).includes('/checkout_sessions/')&&(options.method||'GET')==='GET'){
   const sessionId=decodeURIComponent(String(url).split('/').at(-1));
   const row=db.sql.prepare('SELECT * FROM orders WHERE session_id=?').get(sessionId);
   return Response.json({status:true,data:expired(row)});
  }
  if(String(url).endsWith('/checkout_sessions')&&options.method==='POST'){
   const body=JSON.parse(options.body);
   return Response.json({status:true,data:{id:'chk_created',url:'https://pay.paynecta.co.ke/s/chk_created#fixture-secret',amount:body.amount,currency:'KES',reference:body.reference,status:'open'}});
  }
  throw new Error('Unexpected network fixture URL');
 });
 return calls;
}

beforeEach(t=>{
 t.mock.method(Date,'now',()=>NOW);
 t.mock.method(globalThis,'fetch',async()=>{throw new Error('Real network calls are forbidden in retention tests');});
});

test('provider identity and unpaid expiry require exact agreement, never a browser or timeout verdict',()=>{
 const row={id:'order-fixture',session_id:'chk_fixture',amount:65000};
 assert.equal(sessionMatches(row,expired(row)),true);
 assert.equal(expiredUnpaid(row,expired(row)),true);
 for(const change of [{id:'chk_other'},{reference:'other'},{amount:1},{currency:'USD'},{status:'open'},{status:'paying'},{status:'complete'},{status:'failed'},{status:'timed_out'},{status:'unknown'},
  {payment:{}},{payment:false},{payment:0},{payment:''},{payment:{status:'pending'}},{payment:{status:'provider_error'}},{payment:{status:'timed_out'}},{payment:{status:'cancelled'}},{payment:{status:'insufficient_funds'}},{payment:{status:'refused'}}]){
  assert.equal(expiredUnpaid(row,{...expired(row),...change}),false,JSON.stringify(change));
 }
 assert.equal(paymentMatches(row,succeeded(row)),true);
 for(const change of [{reference:'different'},{currency:'USD'},{amount:1},{payment:{...succeeded(row).payment,status:'provider_error'}},{payment:{...succeeded(row).payment,merchant_reference:'different'}}]){
  assert.equal(paymentMatches(row,{...succeeded(row),...change}),false);
 }
});

test('provider expiry is persisted once and repeated verification cannot postpone the retention clock',async()=>{
 const db=database(),row=order(db);
 await recordExpiredClosure(db,row,expired(row),NOW-RETENTION.PII_MS);
 const initial=retention(db,row.id);
 assert.equal(saved(db,row.id).state,'expired');
 assert.equal(saved(db,row.id).checkout_url,null);
 await recordExpiredClosure(db,saved(db,row.id),expired(row),NOW);
 assert.equal(retention(db,row.id).closed_at,initial.closed_at);
 assert.equal(retention(db,row.id).closure_kind,'provider_expired');
});

test('contradictory evidence invalidates the closure and later expiry cannot silently release it again',async()=>{
 const db=database(),env=environment(db),row=await closed(db);
 await runRetention(env,{fetchSession:async value=>({...expired(value),payment:{status:'provider_error'}}),now:NOW});
 assert.equal(saved(db,row.id).state,'pending');
 assert.equal(retention(db,row.id).disposal_approved_at,null);
 const invalidatedAt=retention(db,row.id).invalidated_at;
 assert.notEqual(invalidatedAt,null);
 await recordExpiredClosure(db,saved(db,row.id),expired(row),NOW+DAY);
 assert.equal(saved(db,row.id).state,'pending','merchant review is required after contradictory payment evidence');
 assert.equal(retention(db,row.id).invalidated_at,invalidatedAt);
 assert.equal(retention(db,row.id).disposal_approved_at,null);
});

test('concurrent closure invalidation before expiry persistence cannot release the checkout in the public response',async t=>{
 const db=database(),env=environment(db),row=await closed(db);
 const prepare=db.prepare;
 let invalidated=false;
 db.prepare=query=>{
  const wrap=prepared=>({...prepared,
   bind(...values){return wrap(prepared.bind(...values));},
   async run(){
    if(!invalidated&&/UPDATE\s+orders\s+SET\s+state='expired'/i.test(query)){
     invalidated=true;
     // Another verifier has received contradictory provider evidence after any
     // preliminary metadata read but immediately before expiry is persisted.
     db.sql.prepare('UPDATE order_retention SET invalidated_at=?,disposal_approved_at=NULL WHERE order_id=?').run(NOW,row.id);
     db.sql.prepare("UPDATE orders SET state='pending' WHERE id=?").run(row.id);
    }
    return prepared.run();
   }
  });
  return wrap(prepare(query));
 };
 providerFixture(t,db);
 const response=await worker.fetch(new Request(ORIGIN+'/api/orders/'+row.id,{headers:{Origin:ORIGIN,Authorization:'Bearer '+TOKEN}}),env);
 assert.equal(response.status,200);
 assert.ok(invalidated,'the race fixture must run at the actual expiry UPDATE');
 assert.equal((await response.json()).state,'pending','the browser must not be permitted to pay again');
 assert.equal(saved(db,row.id).state,'pending');
 assert.equal(retention(db,row.id).invalidated_at,NOW);
 assert.equal(retention(db,row.id).disposal_approved_at,null);
});

test('approval requires an explicit no-obligation attestation, valid evidence and this exact closure',async()=>{
 const db=database(),row=await closed(db,{approved:false});
 const args={id:row.id,evidenceRef:'case/fixture-closed',expectedClosureAt:retention(db,row.id).closed_at,now:NOW};
 await assert.rejects(()=>approveClosure(db,args),TypeError);
 await assert.rejects(()=>approveClosure(db,{...args,confirmNoObligation:true,evidenceRef:'Customer private@example.com'}),TypeError);
 assert.equal(await approveClosure(db,{...args,confirmNoObligation:true,expectedClosureAt:args.expectedClosureAt-1}),false);
 assert.equal(retention(db,row.id).disposal_approved_at,null);
 assert.equal(await approveClosure(db,{...args,confirmNoObligation:true}),true);
});

test('personal data survives until the exact 30-day boundary, then all free text and the domain are removed',async()=>{
 const db=database(),env=environment(db),row=await closed(db,{age:RETENTION.PII_MS-1});
 const before=saved(db,row.id);
 await runRetention(env,{fetchSession:async value=>expired(value),now:NOW});
 assert.equal(saved(db,row.id).customer,before.customer);
 assert.equal(retention(db,row.id).redacted_at,null);
 const result=await runRetention(env,{fetchSession:async value=>expired(value),now:NOW+1});
 const after=saved(db,row.id);
 assert.equal(result.redacted,1);
 assert.deepEqual(JSON.parse(after.customer),{});
 assert.deepEqual(JSON.parse(after.items),[]);
 assert.equal(after.request_hash,'');
 assert.equal(after.checkout_url,null);
 assert.equal(retention(db,row.id).redacted_at,NOW+1);
 for(const field of ['id','session_id','amount','currency','state','terms_version','created_at'])assert.equal(after[field],before[field],field+' preserves minimal payment evidence');
 assert.doesNotMatch(JSON.stringify(after),/private-customer|private-client|confidential|private-secret|private-fingerprint/);
});

test('approved evidence is deleted only at the exact three-year boundary after fresh verification',async()=>{
 const db=database(),env=environment(db),row=await closed(db,{age:RETENTION.EVIDENCE_MS-1});
 await runRetention(env,{fetchSession:async value=>expired(value),now:NOW-RETENTION.CHECK_INTERVAL_MS-1});
 assert.notEqual(retention(db,row.id).redacted_at,null);
 let calls=0;
 await runRetention(env,{fetchSession:async value=>{calls++;return expired(value);},now:NOW});
 assert.ok(saved(db,row.id),'minimal evidence must survive one millisecond before cutoff');
 const result=await runRetention(env,{fetchSession:async value=>{calls++;return expired(value);},now:NOW+1});
 assert.equal(result.deleted,1);
 assert.equal(saved(db,row.id),null);
 assert.equal(retention(db,row.id),null,'foreign key removes expired retention metadata too');
 assert.ok(calls>=1,'deletion must reread the provider');
});

test('unapproved legacy orders, unresolved creation and pending sessions are never cleanup candidates',async()=>{
 const db=database(),env=environment(db),unapproved=await closed(db,{approved:false,age:RETENTION.EVIDENCE_MS+DAY});
 const rows=[unapproved,order(db,{state:'creating',session_id:null,created_at:NOW-5*RETENTION.EVIDENCE_MS}),order(db,{state:'pending',created_at:NOW-5*RETENTION.EVIDENCE_MS}),order(db,{state:'expired',created_at:NOW-5*RETENTION.EVIDENCE_MS})];
 const original=rows.map(row=>saved(db,row.id));
 let called=0;
 await runRetention(env,{fetchSession:async value=>{called++;return expired(value);},now:NOW});
 assert.equal(called,0,'absence of approval or historical closure proof cannot be repaired by age');
 rows.forEach((row,index)=>assert.deepEqual(saved(db,row.id),original[index]));
});

test('paid state, paid timestamps, saved payment references and a legal hold each block redaction',async()=>{
 for(const protection of [{state:'paid'},{paid_at:NOW-DAY},{paid_at:0},{payment_reference:'PN-EXISTING'},{payment_reference:''},{legal_hold:1}]){
  const db=database(),env=environment(db),row=await closed(db);
  if(protection.legal_hold)db.sql.prepare('UPDATE order_retention SET legal_hold=1,hold_reason=? WHERE order_id=?').run('fixture-open-dispute',row.id);
  else for(const [key,value] of Object.entries(protection))db.sql.prepare('UPDATE orders SET '+key+'=? WHERE id=?').run(value,row.id);
  const original=saved(db,row.id);
  await runRetention(env,{fetchSession:async()=>{throw new Error('Protected rows must not need a provider request');},now:NOW});
  assert.deepEqual(saved(db,row.id),original,JSON.stringify(protection));
  assert.equal(retention(db,row.id).redacted_at,null);
 }
});

test('unknown outcomes, every payment object and mismatched fresh responses retain personal data',async()=>{
 const cases=[{status:'open'},{status:'paying'},{status:'unknown'},{payment:{}},{payment:{status:'pending'}},{payment:{status:'provider_error'}},{payment:{status:'timed_out'}},{payment:{status:'cancelled'}},{id:'chk_other'},{reference:'another-order'},{amount:1},{currency:'USD'}];
 for(const response of cases){
  const db=database(),env=environment(db),row=await closed(db),original=saved(db,row.id);
  await runRetention(env,{fetchSession:async value=>({...expired(value),...response}),now:NOW});
  assert.equal(saved(db,row.id).customer,original.customer,JSON.stringify(response));
  assert.equal(saved(db,row.id).items,original.items);
  assert.equal(retention(db,row.id).redacted_at,null);
  assert.equal(retention(db,row.id).disposal_approved_at,null,'changed evidence invalidates operator approval');
 }
});

test('provider errors never redact data and safe retry remains possible after the cooldown',async()=>{
 const db=database(),env=environment(db),row=await closed(db),original=saved(db,row.id);
 const first=await runRetention(env,{fetchSession:async()=>{throw new Error('fixture provider timeout');},now:NOW});
 assert.ok(first.errors>=1);
 assert.equal(saved(db,row.id).customer,original.customer);
 assert.equal(retention(db,row.id).redacted_at,null);
 const next=await runRetention(env,{fetchSession:async value=>expired(value),now:NOW+RETENTION.CHECK_INTERVAL_MS+1});
 assert.equal(next.redacted,1);
});

test('fresh succeeded payment wins over scheduled disposal and preserves the project evidence',async()=>{
 const db=database(),env=environment(db),row=await closed(db),original=saved(db,row.id);
 const result=await runRetention(env,{fetchSession:async value=>succeeded(value),now:NOW});
 assert.equal(result.redacted,0);
 assert.equal(result.deleted,0);
 const after=saved(db,row.id);
 assert.equal(after.state,'paid');
 assert.equal(after.payment_reference,'PN-FIXTURE');
 assert.notEqual(after.paid_at,null);
 assert.equal(after.customer,original.customer);
 assert.equal(after.items,original.items);
 assert.equal(retention(db,row.id).redacted_at,null);
});

test('concurrent settlement or legal hold after provider read prevents destructive redaction',async()=>{
 for(const concurrent of ['paid','hold']){
  const db=database(),env=environment(db),row=await closed(db),original=saved(db,row.id);
  const result=await runRetention(env,{fetchSession:async value=>{
   if(concurrent==='paid')db.sql.prepare("UPDATE orders SET state='paid',paid_at=?,payment_reference='PN-CONCURRENT' WHERE id=?").run(NOW,row.id);
   else db.sql.prepare("UPDATE order_retention SET legal_hold=1,hold_reason='fixture-race' WHERE order_id=?").run(row.id);
   return expired(value);
  },now:NOW});
  assert.equal(result.redacted,0);
  assert.equal(result.deleted,0);
  assert.equal(saved(db,row.id).customer,original.customer,concurrent);
  assert.equal(saved(db,row.id).items,original.items,concurrent);
  assert.equal(retention(db,row.id).redacted_at,null);
 }
});

test('recent ordinary verification claims are excluded, while a stable old claim allows cleanup',async()=>{
 for(const recent of [true,false]){
  const db=database(),env=environment(db),row=await closed(db);
  db.sql.prepare('UPDATE orders SET checked_at=? WHERE id=?').run(recent?NOW:NOW-120001,row.id);
  let calls=0;
  const result=await runRetention(env,{fetchSession:async value=>{calls++;return expired(value);},now:NOW});
  assert.equal(calls,recent?0:1);
  assert.equal(result.redacted,recent?0:1);
  if(recent)assert.deepEqual(JSON.parse(saved(db,row.id).customer),customer());
  else assert.deepEqual(JSON.parse(saved(db,row.id).customer),{});
 }
});

test('a new ordinary verification claim during the provider read blocks both redaction and final deletion',async()=>{
 for(const stage of ['redact','delete']){
  const db=database(),env=environment(db),row=await closed(db,{age:stage==='redact'?RETENTION.PII_MS:RETENTION.EVIDENCE_MS+DAY});
  if(stage==='delete')await runRetention(env,{fetchSession:async value=>expired(value),now:retention(db,row.id).closed_at+RETENTION.PII_MS});
  const before=saved(db,row.id);
  const result=await runRetention(env,{fetchSession:async value=>{
   db.sql.prepare('UPDATE orders SET checked_at=? WHERE id=?').run(NOW,row.id);
   return expired(value);
  },now:NOW});
  assert.equal(result.redacted,0,stage);
  assert.equal(result.deleted,0,stage);
  assert.ok(saved(db,row.id),stage);
  assert.equal(saved(db,row.id).customer,before.customer,stage);
  assert.equal(saved(db,row.id).items,before.items,stage);
 }
});

test('missing approval or a newly placed hold also prevents final skeleton deletion',async()=>{
 for(const concurrent of ['approval','hold','paid']){
  const db=database(),env=environment(db),row=await closed(db,{age:RETENTION.EVIDENCE_MS+DAY});
  await runRetention(env,{fetchSession:async value=>expired(value),now:retention(db,row.id).closed_at+RETENTION.PII_MS});
  assert.notEqual(retention(db,row.id).redacted_at,null);
  const result=await runRetention(env,{fetchSession:async value=>{
   if(concurrent==='approval')db.sql.prepare('UPDATE order_retention SET disposal_approved_at=NULL WHERE order_id=?').run(row.id);
   if(concurrent==='hold')db.sql.prepare('UPDATE order_retention SET legal_hold=1 WHERE order_id=?').run(row.id);
   if(concurrent==='paid')db.sql.prepare("UPDATE orders SET state='paid',paid_at=?,payment_reference='PN-LATE' WHERE id=?").run(NOW,row.id);
   return expired(value);
  },now:NOW});
  assert.equal(result.deleted,0,concurrent);
  assert.ok(saved(db,row.id),concurrent+' must preserve the row');
 }
});

test('a cron invocation reads no more than ten provider sessions and rotates failed candidates',async()=>{
 const db=database(),env=environment(db);
 for(let n=0;n<RETENTION.BATCH_SIZE+3;n++)await closed(db);
 const seen=[];
 await runRetention(env,{fetchSession:async value=>{seen.push(value.id);throw new Error('fixture transient error');},now:NOW});
 assert.equal(seen.length,10);
 const next=[];
 await runRetention(env,{fetchSession:async value=>{next.push(value.id);return expired(value);},now:NOW+1});
 assert.equal(next.length,3);
 assert.equal(next.some(id=>seen.includes(id)),false,'failed candidates must not starve unattempted rows');
});

test('disabled retention and missing provider credentials never dispose data',async()=>{
 for(const settings of [{ORDER_RETENTION_ENABLED:undefined},{ORDER_RETENTION_ENABLED:'false'},{PAYNECTA_PUBLIC_KEY:''},{PAYNECTA_SECRET_KEY:''}]){
  const db=database(),row=await closed(db),env={...environment(db),...settings},before=saved(db,row.id);
  await runRetention(env,{fetchSession:async()=>{throw new Error('Disabled retention must not call the provider');},now:NOW});
  assert.deepEqual(saved(db,row.id),before);
  assert.equal(retention(db,row.id).redacted_at,null);
 }
});

test('turning new payments off does not disable approved cleanup of safely closed orders',async()=>{
 const db=database(),env={...environment(db),PAYMENTS_ENABLED:'false'},row=await closed(db);
 const result=await runRetention(env,{fetchSession:async value=>expired(value),now:NOW});
 assert.equal(result.redacted,1);
 assert.deepEqual(JSON.parse(saved(db,row.id).customer),{});
});

test('dry run reports eligible disposal and late payment evidence without writing any data',async()=>{
 const db=database(),env={...environment(db),ORDER_RETENTION_ENABLED:'false'};
 const redact=await closed(db),erase=await closed(db,{age:RETENTION.EVIDENCE_MS+DAY}),paid=await closed(db);
 const snapshot=()=>JSON.stringify({orders:db.sql.prepare('SELECT * FROM orders ORDER BY id').all(),retention:db.sql.prepare('SELECT * FROM order_retention ORDER BY order_id').all()});
 const before=snapshot();
 const result=await runRetention(env,{dryRun:true,now:NOW,fetchSession:async value=>value.id===paid.id?succeeded(value):expired(value)});
 assert.equal(result.wouldRedact,1);
 assert.equal(result.wouldDelete,1);
 assert.equal(result.observedPaid,1);
 assert.equal(result.redacted,0);
 assert.equal(result.deleted,0);
 assert.equal(snapshot(),before,'a preview must not claim rows, update verification time, settle or redact');
 assert.ok(saved(db,redact.id));
 assert.ok(saved(db,erase.id));
});

test('manual reconciliation without an identifiable provider session cannot authorize automatic cleanup',async()=>{
 const db=database(),env=environment(db),row=order(db,{state:'closed_unpaid',session_id:null,created_at:NOW-5*RETENTION.EVIDENCE_MS});
 db.sql.prepare(`INSERT INTO order_retention(order_id,session_id,closure_kind,closed_at,last_verified_at,evidence_ref,disposal_approved_at)
  VALUES(?,NULL,'reconciled_unpaid',?,?,?,?)`).run(row.id,NOW-2*RETENTION.EVIDENCE_MS,NOW-DAY,'fixture-manual-case',NOW-DAY);
 const before=saved(db,row.id);
 await runRetention(env,{fetchSession:async()=>{throw new Error('No provider session must remain a manual case');},now:NOW});
 assert.deepEqual(saved(db,row.id),before);
 assert.equal(retention(db,row.id).redacted_at,null);
});

test('changed closure, order amount or provider session while verification is in flight blocks redaction',async()=>{
 for(const concurrent of ['closure','amount','session']){
  const db=database(),env=environment(db),row=await closed(db),before=saved(db,row.id);
  const result=await runRetention(env,{now:NOW,fetchSession:async value=>{
   if(concurrent==='closure')db.sql.prepare('UPDATE order_retention SET closed_at=closed_at+1 WHERE order_id=?').run(row.id);
   if(concurrent==='amount')db.sql.prepare('UPDATE orders SET amount=amount+100 WHERE id=?').run(row.id);
   if(concurrent==='session')db.sql.prepare("UPDATE orders SET session_id='chk_replacement' WHERE id=?").run(row.id);
   return expired(value);
  }});
  assert.equal(result.redacted,0,concurrent);
  assert.equal(saved(db,row.id).customer,before.customer,concurrent);
  assert.equal(saved(db,row.id).items,before.items,concurrent);
  assert.equal(retention(db,row.id).redacted_at,null);
 }
});

test('late verified payment preserves the minimal ledger instead of deleting a three-year-old skeleton',async()=>{
 const db=database(),env=environment(db),row=await closed(db,{age:RETENTION.EVIDENCE_MS+DAY});
 await runRetention(env,{fetchSession:async value=>expired(value),now:retention(db,row.id).closed_at+RETENTION.PII_MS});
 assert.deepEqual(JSON.parse(saved(db,row.id).customer),{});
 const result=await runRetention(env,{fetchSession:async value=>succeeded(value),now:NOW});
 assert.equal(result.deleted,0);
 assert.equal(saved(db,row.id).state,'paid');
 assert.equal(saved(db,row.id).payment_reference,'PN-FIXTURE');
 assert.equal(saved(db,row.id).amount,row.amount);
});

test('paid markers prevent provider expiry from reclassifying or approving an order',async()=>{
 for(const protection of [{state:'paid'},{paid_at:NOW-DAY},{payment_reference:'PN-EXISTING'}]){
  const db=database(),row=order(db,protection),before=saved(db,row.id);
  await recordExpiredClosure(db,row,expired(row),NOW);
  assert.deepEqual(saved(db,row.id),before);
  assert.equal(retention(db,row.id),null);
 }
});

test('legacy schema migration is repeatable, non-destructive and does not approve historical rows',()=>{
 const db=database({legacy:true}),row=order(db),before=saved(db,row.id);
 const migration=readFileSync(new URL('./migrations/0001-order-retention.sql',import.meta.url),'utf8');
 db.sql.exec(migration);
 db.sql.exec(migration);
 assert.deepEqual(saved(db,row.id),before);
 assert.equal(retention(db,row.id),null);
});

test('missing retention migration safely retains orders and ordinary checkout still works',async t=>{
 const db=database({legacy:true}),env=environment(db),historical=order(db,{created_at:NOW-5*RETENTION.EVIDENCE_MS}),before=saved(db,historical.id);
 const result=await runRetention(env,{fetchSession:async()=>{throw new Error('Missing schema must fail closed');},now:NOW});
 assert.ok(result.errors>=1);
 assert.deepEqual(saved(db,historical.id),before);
 const calls=providerFixture(t,db),id='22222222-2222-4222-8222-222222222222';
 const body={items:[{id:'basic',quantity:1}],currency:'KES',language:'en',termsVersion:TERMS,acceptTerms:true,customer:customer()};
 const response=await worker.fetch(new Request(ORIGIN+'/api/checkout',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json',Authorization:'Bearer '+TOKEN,'Idempotency-Key':id},body:JSON.stringify(body)}),env);
 assert.equal(response.status,201);
 assert.equal(calls.filter(call=>call.method==='POST'&&call.url.endsWith('/checkout_sessions')).length,1);
});

test('an expired legacy session remains verifiable when the additive retention migration is absent',async t=>{
 const db=database({legacy:true}),env=environment(db),row=order(db);
 providerFixture(t,db);
 const response=await worker.fetch(new Request(ORIGIN+'/api/orders/'+row.id,{headers:{Origin:ORIGIN,Authorization:'Bearer '+TOKEN}}),env);
 assert.equal(response.status,200);
 assert.equal((await response.json()).state,'expired');
 assert.equal(saved(db,row.id).state,'expired');
 assert.equal(saved(db,row.id).customer,row.customer,'missing retention schema cannot erase order data');
});

test('a closed checkout returns 410 on idempotent POST and cannot create or reopen another session',async t=>{
 const db=database(),env=environment(db);
 const body={items:[{id:'basic',quantity:1}],currency:'KES',language:'en',termsVersion:TERMS,acceptTerms:true,customer:customer()};
 const cart=priceCart(body.items);
 const requestHash=digest(JSON.stringify({...cart,customer:body.customer,language:body.language,earlyStart:false,terms:TERMS}));
 const row=await closed(db,{amount:cart.amount,items:JSON.stringify(cart.items),request_hash:requestHash});
 const calls=providerFixture(t,db);
 const response=await worker.fetch(new Request(ORIGIN+'/api/checkout',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json',Authorization:'Bearer '+TOKEN,'Idempotency-Key':row.id},body:JSON.stringify(body)}),env);
 assert.equal(response.status,410);
 assert.equal(calls.filter(call=>call.method==='POST'&&call.url.endsWith('/checkout_sessions')).length,0);
 assert.equal(saved(db,row.id).state,'expired');
 assert.equal(saved(db,row.id).session_id,row.session_id);
 await runRetention(env,{fetchSession:async value=>expired(value),now:NOW});
 assert.equal(saved(db,row.id).request_hash,'');
 const retry=await worker.fetch(new Request(ORIGIN+'/api/checkout',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json',Authorization:'Bearer '+TOKEN,'Idempotency-Key':row.id},body:JSON.stringify(body)}),env);
 assert.equal(retry.status,410,'redaction must not make an old idempotency key reusable');
 assert.equal(calls.filter(call=>call.method==='POST'&&call.url.endsWith('/checkout_sessions')).length,0);
});
