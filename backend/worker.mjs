import {paymentMatches,expiredUnpaid,recordExpiredClosure,runRetention} from './retention.mjs';
export {paymentMatches} from './retention.mjs';
const BASE = 'https://api.paynecta.co.ke/v1';
export const TERMS = '2026-10-20-paynecta-v2';
// All amounts are integer KES cents. Browser amounts are never accepted.
export const PRODUCTS = Object.freeze({
 setup: {amount:300000,en:'Domain & Setup',cs:'Doména a nastavení'},
 basic: {amount:500000,en:'Basic One-Page Site',cs:'Základní jednostránkový web'},
 signature: {amount:900000,en:'Signature One-Page Site',cs:'Jednostránkový web na míru'},
 logo: {amount:200000,en:'Custom Logo Design',cs:'Vlastní návrh loga'},
 page: {amount:300000,en:'Additional Website Page',cs:'Další stránka webu'},
 domain: {amount:65000,editable:true,en:'Domain registration · first year',cs:'Registrace domény · první rok'}
});
class HttpError extends Error { constructor(status,code){super(code);this.status=status;this.code=code;} }
function fail(status,code){throw new HttpError(status,code);}
export function priceCart(items){
 if(!Array.isArray(items)||!items.length||items.length>6)fail(400,'invalid_cart');
 const seen=new Set();let amount=0;
 const lines=items.map(item=>{
  if(!item||!Object.hasOwn(PRODUCTS,item.id)||seen.has(item.id)||!Number.isInteger(item.quantity)||item.quantity<1||item.quantity>10)fail(400,'invalid_cart');
  if(item.id==='domain'){
   const domain=typeof item.domain==='string'?item.domain.trim().toLowerCase():'';
   if(item.quantity!==1||!Number.isSafeInteger(item.amount)||item.amount<PRODUCTS.domain.amount||item.amount>25000000||item.amount%100!==0||domain.length>253||! /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain))fail(400,'invalid_domain');
   seen.add(item.id);amount+=item.amount;return {id:item.id,quantity:1,amount:item.amount,domain};
  }
  seen.add(item.id);amount+=PRODUCTS[item.id].amount*item.quantity;
  return {id:item.id,quantity:item.quantity};
 }).sort((a,b)=>a.id.localeCompare(b.id));
 if(seen.has('basic')&&seen.has('signature'))fail(400,'choose_one_website');
 if(amount>25000000)fail(400,'amount_limit');
 return {items:lines,amount,currency:'KES'};
}
async function hash(value){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');}
function bearer(request){const value=request.headers.get('Authorization')||'';if(!/^Bearer [a-f0-9]{64}$/.test(value))fail(401,'unauthorized');return value.slice(7);}
function json(body,status=200,origin){const headers={'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};if(origin){headers['Access-Control-Allow-Origin']=origin;headers.Vary='Origin';}return new Response(JSON.stringify(body),{status,headers});}
let tokenCache;
async function paynecta(env,path,body,retry=true){
 if(!tokenCache||tokenCache.expires<Date.now()){
  const res=await fetch(BASE+'/auth/token',{method:'POST',headers:{Authorization:'Basic '+btoa(env.PAYNECTA_PUBLIC_KEY+':'+env.PAYNECTA_SECRET_KEY)},signal:AbortSignal.timeout(15000)});
  const issued=await res.json();
  if(!res.ok||issued.status!==true||!issued.data?.access_token)fail(503,'provider_unavailable');
  tokenCache={value:issued.data.access_token,expires:Date.now()+Math.min(Number(issued.data.expires_in)||3600,3600)*1000-60000};
 }
 const response=await fetch(BASE+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+tokenCache.value,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
 if(response.status===401&&retry){tokenCache=null;return paynecta(env,path,body,false);}
 const result=await response.json();
 if(!response.ok||result.status!==true)fail(503,'provider_unavailable');
 return result.data;
}
async function verify(env,order){
 if(order.state==='paid'||!order.session_id)return order;
 if(order.checked_at&&Date.now()-order.checked_at<10000)return order;
 // Reserve a polling interval atomically before making a provider request.
 const claim=await env.DB.prepare('UPDATE orders SET checked_at=? WHERE id=? AND (checked_at IS NULL OR checked_at<?)').bind(Date.now(),order.id,Date.now()-10000).run();
 if(!claim.meta.changes)return order;
 const session=await paynecta(env,'/checkout_sessions/'+encodeURIComponent(order.session_id));
 if(paymentMatches(order,session)){
  await env.DB.prepare("UPDATE orders SET state='paid', payment_reference=?, paid_at=?, checkout_url=NULL WHERE id=? AND state!='paid'").bind(session.payment.reference,Date.now(),order.id).run();
  return {...order,state:'paid',payment_reference:session.payment.reference};
 }
 // Only the provider can release an expired checkout. Never release an unresolved payment.
 if(expiredUnpaid(order,session))return recordExpiredClosure(env.DB,order,session);
 if(order.state==='expired'||order.state==='closed_unpaid'){
  // New contradictory evidence supersedes the old closure, including in the UI.
  await env.DB.prepare("UPDATE orders SET state='pending' WHERE id=? AND session_id=? AND state IN ('expired','closed_unpaid') AND paid_at IS NULL AND payment_reference IS NULL").bind(order.id,order.session_id).run();
  try{await env.DB.prepare('UPDATE order_retention SET disposal_approved_at=NULL,invalidated_at=? WHERE order_id=? AND session_id=?').bind(Date.now(),order.id,order.session_id).run();}catch{/* Missing retention migration keeps the order pending and retained. */}
  return await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(order.id).first()||order;
 }
 // Neither a return URL, session status, nor a browser message settles an order.
 return order;
}
async function rateLimit(env,request){
 const now=Date.now(),window=Math.floor(now/60000);
 const bucket=await hash(env.PAYNECTA_SECRET_KEY+'|'+(request.headers.get('CF-Connecting-IP')||'local')+'|'+window);
 const row=await env.DB.prepare('INSERT INTO rate_limits(bucket,count,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count').bind(bucket,now+120000).first();
 if(row.count>3)fail(429,'rate_limited');
 const hourBucket=await hash(env.PAYNECTA_SECRET_KEY+'|hour|'+(request.headers.get('CF-Connecting-IP')||'local')+'|'+Math.floor(now/3600000));
 const hourly=await env.DB.prepare('INSERT INTO rate_limits(bucket,count,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count').bind(hourBucket,now+3600000).first();
 if(hourly.count>12)fail(429,'rate_limited');
}
async function verifyBot(request,env,body,origin){
 if(env.TURNSTILE_REQUIRED!=='true')return;
 if(typeof body.botToken!=='string'||body.botToken.length<1||body.botToken.length>2048)fail(403,'bot_verification_failed');
 let response,result;try{response=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:env.TURNSTILE_SECRET_KEY,response:body.botToken,remoteip:request.headers.get('CF-Connecting-IP')||undefined}),signal:AbortSignal.timeout(10000)});result=await response.json();}catch{fail(503,'bot_unavailable');}
 if(!response.ok||result.success!==true||result.hostname!==new URL(origin).hostname||result.action!=='checkout')fail(403,'bot_verification_failed');
}
async function createOrder(request,env,origin){
 if((Number(request.headers.get('Content-Length'))||0)>12000)fail(413,'too_large');
 const reader=request.body?.getReader();if(!reader)fail(400,'invalid_request');
 let bytes=0;const chunks=[];
 while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>12000){await reader.cancel();fail(413,'too_large');}chunks.push(part.value);}
 const combined=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){combined.set(chunk,offset);offset+=chunk.byteLength;}
 const text=new TextDecoder().decode(combined);
 let body;try{body=JSON.parse(text);}catch{fail(400,'invalid_request');}
 if(body.currency!=='KES')fail(400,'currency_unavailable');
 if(body.termsVersion!==TERMS||body.acceptTerms!==true)fail(400,'terms_required');
 if(!['en','cs'].includes(body.language))fail(400,'invalid_language');
 const cart=priceCart(body.items);
 const customer={name:String(body.customer?.name||'').trim(),email:String(body.customer?.email||'').trim(),brief:String(body.customer?.brief||'').trim()};
 if(customer.name.length>120||customer.email.length>254||!/^\S+@\S+\.\S+$/.test(customer.email)||customer.brief.length<10||customer.brief.length>2000)fail(400,'customer_required');
 const tokenHash=await hash(bearer(request));
 const id=request.headers.get('Idempotency-Key');
 if(!/^[a-f0-9-]{36}$/.test(id||''))fail(400,'invalid_idempotency_key');
 const fingerprint=await hash(JSON.stringify({...cart,customer,language:body.language,earlyStart:body.earlyStart===true,terms:TERMS}));
 let order=await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();
 if(order){
  if(order.token_hash!==tokenHash)fail(401,'unauthorized');
  if(order.state==='expired'||order.state==='closed_unpaid')fail(410,'order_closed');
  if(order.request_hash!==fingerprint)fail(409,'cart_changed');
  if(order.session_id)return json({id,sessionId:order.session_id,url:order.checkout_url,state:order.state,amount:order.amount,currency:'KES'},200,origin);
  fail(409,'checkout_uncertain');
 }
 await rateLimit(env,request);
 await verifyBot(request,env,body,origin);
 const insert=await env.DB.prepare("INSERT OR IGNORE INTO orders(id,token_hash,request_hash,amount,currency,items,customer,language,terms_version,early_start,state,created_at) VALUES(?,?,?,?,'KES',?,?,?,?,?,'creating',?)").bind(id,tokenHash,fingerprint,cart.amount,JSON.stringify(cart.items),JSON.stringify(customer),body.language,TERMS,body.earlyStart===true?1:0,Date.now()).run();
 if(!insert.meta.changes)fail(409,'checkout_uncertain');
 // Persist before calling the provider. Never retry an ambiguous session POST.
 const returnPath=body.language==='cs'?'/cs/payment-success.html':'/payment-success.html';
 const data=await paynecta(env,'/checkout_sessions',{tapflow:env.PAYNECTA_TAPFLOW,amount:cart.amount,reference:id,redirect_url:origin+returnPath,cancel_url:origin+(body.language==='cs'?'/cs/':'/')+'index.html',frame_origins:[origin]});
 let checkout;try{checkout=new URL(data.url);}catch{fail(503,'provider_unavailable');}
 if(checkout.origin!=='https://pay.paynecta.co.ke'||!/^\/s\/chk_[a-zA-Z0-9]+$/.test(checkout.pathname)||!checkout.hash||!/^chk_[a-zA-Z0-9]+$/.test(data.id)||checkout.pathname!=='/s/'+data.id||data.amount!==cart.amount||data.currency!=='KES')fail(503,'provider_unavailable');
 await env.DB.prepare("UPDATE orders SET session_id=?,checkout_url=?,state='pending' WHERE id=?").bind(data.id,data.url,id).run();
 return json({id,sessionId:data.id,url:data.url,state:'pending',amount:cart.amount,currency:'KES'},201,origin);
}
function configured(env){return env.PAYMENTS_ENABLED==='true'&&env.DB&&env.PAYNECTA_PUBLIC_KEY&&env.PAYNECTA_SECRET_KEY&&env.PAYNECTA_TAPFLOW&&(env.TURNSTILE_REQUIRED!=='true'||(env.TURNSTILE_SECRET_KEY&&env.TURNSTILE_SITE_KEY));}
const readiness=new WeakMap();
async function ready(env){
 if(!configured(env))return false;
 const cached=readiness.get(env);if(cached&&cached.until>Date.now())return cached.value;
 let value=false;
 try{const flows=await paynecta(env,'/tapflows?usable=true&per_page=100');const balance=await paynecta(env,'/balance');value=Array.isArray(flows)&&flows.some(f=>(f.slug===env.PAYNECTA_TAPFLOW||f.id===env.PAYNECTA_TAPFLOW)&&f.active===true&&f.open_amount===true&&f.can_collect===true)&&balance.can_collect===true;}catch{}
 readiness.set(env,{value,until:Date.now()+60000});return value;
}
export default {
 async fetch(request,env){
  const url=new URL(request.url);
  if(!url.pathname.startsWith('/api/'))return env.ASSETS.fetch(request);
  const allowed=(env.ALLOWED_ORIGINS||'https://kitonyo.com,https://www.kitonyo.com').split(',').map(s=>s.trim());
  const origin=request.headers.get('Origin')||url.origin;
  if(!allowed.includes(origin))return json({error:'origin_denied'},403);
  try{
   if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Authorization,Content-Type,Idempotency-Key','Access-Control-Max-Age':'600','Vary':'Origin'}});
   if(url.pathname==='/api/catalog'&&request.method==='GET')return json({enabled:await ready(env),currency:'KES',termsVersion:TERMS,products:PRODUCTS,botRequired:env.TURNSTILE_REQUIRED==='true',siteKey:env.TURNSTILE_SITE_KEY||null},200,origin);
   if(!configured(env))fail(503,'payments_not_ready');
   if(url.pathname==='/api/checkout'&&request.method==='POST'){
    if(!await ready(env))fail(503,'payments_not_ready');
    if(!(request.headers.get('Content-Type')||'').startsWith('application/json'))fail(415,'invalid_request');
    return await createOrder(request,env,origin);
   }
   const match=url.pathname.match(/^\/api\/orders\/([a-f0-9-]{36})$/);
   if(match&&request.method==='GET'){
    let order=await env.DB.prepare('SELECT * FROM orders WHERE id=?').bind(match[1]).first();
    if(!order||order.token_hash!==await hash(bearer(request)))fail(404,'order_not_found');
    order=await verify(env,order);
    return json({id:order.id,state:order.state==='closed_unpaid'?'expired':order.state,amount:order.amount,currency:'KES',items:JSON.parse(order.items),paymentReference:order.state==='paid'?order.payment_reference:null},200,origin);
   }
   fail(404,'not_found');
  }catch(error){return json({error:error instanceof HttpError?error.code:'temporarily_unavailable'},error instanceof HttpError?error.status:503,origin);}
 },
 async scheduled(event,env,ctx){
  if(!env.DB)return;
  if(configured(env)){
   // Keep checking after the payer closes the browser; age is never proof of failure.
   const result=await env.DB.prepare("SELECT * FROM orders WHERE state='pending' AND created_at>? ORDER BY COALESCE(checked_at,0) LIMIT 30").bind(Date.now()-7*86400000).all();
   for(const order of result.results){try{await verify(env,order);}catch{/* Retain pending and retry. Never log provider/customer payloads. */}}
  }
  await env.DB.prepare('DELETE FROM rate_limits WHERE expires_at<?').bind(Date.now()).run();
  const retention=await runRetention(env,{fetchSession:order=>paynecta(env,'/checkout_sessions/'+encodeURIComponent(order.session_id))});
  if(!retention.disabled)console.log('order_retention',JSON.stringify(retention));
 }
};
