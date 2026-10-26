// Destructive maintenance is opt-in and only applies to approved, proven unpaid closures.
// Order/session identifiers retained after redaction remain pseudonymous personal data.
export const RETENTION = Object.freeze({
 PII_MS:30*86400000,
 EVIDENCE_MS:1095*86400000,
 BATCH_SIZE:10,
 CHECK_INTERVAL_MS:3600000,
 SETTLEMENT_GRACE_MS:120000
});

export function sessionMatches(order,session){
 return Boolean(order.session_id&&session?.id===order.session_id&&session.reference===order.id&&session.currency==='KES'&&session.amount===order.amount);
}
export function paymentMatches(order,session){
 return sessionMatches(order,session)&&session.payment?.amount===order.amount&&session.payment?.merchant_reference===order.id&&session.payment?.status==='succeeded'&&typeof session.payment?.reference==='string'&&session.payment.reference.trim().length>0;
}
export function expiredUnpaid(order,session){
 // A failed/timed-out payment is not proof of an unpaid, unusable checkout.
 return sessionMatches(order,session)&&session.status==='expired'&&session.payment==null;
}
function changes(result){return Number(result?.meta?.changes)||0;}
function validTime(now){if(!Number.isSafeInteger(now)||now<=0)throw new TypeError('Invalid maintenance time');}
function missingRetentionTable(error){
 return [error?.message,error?.cause?.message].some(message=>typeof message==='string'&&/\bno such table:\s*(?:main\.)?order_retention\b/i.test(message));
}

export async function recordExpiredClosure(db,order,session,now=Date.now()){
 validTime(now);
 if(!expiredUnpaid(order,session))return order;
 const expiryUpdate="UPDATE orders SET state='expired',checkout_url=NULL WHERE id=? AND session_id=? AND amount=? AND currency='KES' AND state IN ('creating','pending','expired') AND paid_at IS NULL AND payment_reference IS NULL";
 try{
  // Check the invalidation marker in the same statement as the state transition.
  // An older successful GET must not undo a concurrent merchant-review lock.
  await db.prepare(expiryUpdate+` AND NOT EXISTS(SELECT 1 FROM order_retention r WHERE r.order_id=orders.id AND r.invalidated_at IS NOT NULL)`)
   .bind(order.id,order.session_id,order.amount).run();
 }catch(error){
  if(!missingRetentionTable(error))throw error;
  // Only the known legacy schema can use this fallback: it has no closure
  // metadata or approvals, so none of its data can qualify for retention.
  await db.prepare(expiryUpdate).bind(order.id,order.session_id,order.amount).run();
 }
 const current=await db.prepare('SELECT * FROM orders WHERE id=?').bind(order.id).first();
 if(!current||current.state!=='expired'||current.paid_at!=null||current.payment_reference!=null)return current||order;
 try{
  await db.prepare(`INSERT INTO order_retention(order_id,session_id,closure_kind,closed_at,last_verified_at,evidence_ref)
   SELECT id,session_id,'provider_expired',?,?,? FROM orders
   WHERE id=? AND state='expired' AND paid_at IS NULL AND payment_reference IS NULL AND session_id=? AND amount=? AND currency='KES'
   ON CONFLICT(order_id) DO UPDATE SET last_verified_at=excluded.last_verified_at
   WHERE order_retention.session_id=excluded.session_id AND order_retention.closure_kind='provider_expired' AND order_retention.invalidated_at IS NULL`)
   .bind(now,now,'provider:'+order.session_id,order.id,order.session_id,order.amount).run();
 }catch(error){
  if(!missingRetentionTable(error))throw error;
  // An unapplied additive migration cannot break checkout/settlement. Without its
  // closure metadata nothing can qualify for retention, so all data is retained.
 }
 return current;
}

// For authenticated operator tooling only. This function is never an HTTP route.
// Approval records a review of contracts, work, invoices, debts and disputes.
export async function approveClosure(db,{id,evidenceRef,expectedClosureAt,now=Date.now(),confirmNoObligation}={}){
 validTime(now);
 if(typeof id!=='string'||!id||!Number.isSafeInteger(expectedClosureAt)||expectedClosureAt<=0||expectedClosureAt>now||confirmNoObligation!==true||typeof evidenceRef!=='string'||! /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(evidenceRef))throw new TypeError('Explicit closure review and a non-personal evidence reference are required');
 const result=await db.prepare(`UPDATE order_retention SET disposal_approved_at=?,evidence_ref=?
  WHERE order_id=? AND closed_at=? AND closure_kind='provider_expired' AND legal_hold=0 AND invalidated_at IS NULL
  AND last_verified_at>=closed_at AND last_verified_at<=?
  AND EXISTS(SELECT 1 FROM orders o WHERE o.id=order_retention.order_id AND o.session_id=order_retention.session_id
   AND o.state='expired' AND o.paid_at IS NULL AND o.payment_reference IS NULL)`)
  .bind(now,evidenceRef,id,expectedClosureAt,now).run();
 return changes(result)===1;
}

async function invalidateClosure(db,order,now){
 // Contradictory provider evidence makes the old closure unusable, including for
 // browser retry. A merchant must reconcile it; later cron reads cannot reapprove it.
 const statements=[
  db.prepare(`UPDATE order_retention SET disposal_approved_at=NULL,invalidated_at=?
   WHERE order_id=? AND closed_at=? AND session_id=?`).bind(now,order.id,order.closed_at,order.closure_session_id),
  db.prepare("UPDATE orders SET state='pending' WHERE id=? AND session_id=? AND state IN ('expired','closed_unpaid') AND paid_at IS NULL AND payment_reference IS NULL")
   .bind(order.id,order.session_id)
 ];
 await db.batch(statements);
}

export async function runRetention(env,{fetchSession,now=Date.now(),dryRun=false}={}){
 validTime(now);
 const stats={checked:0,redacted:0,deleted:0,retained:0,errors:0,disabled:false,wouldRedact:0,wouldDelete:0,observedPaid:0};
 if((env.ORDER_RETENTION_ENABLED!=='true'&&!dryRun)||!env.DB||!env.PAYNECTA_PUBLIC_KEY||!env.PAYNECTA_SECRET_KEY||typeof fetchSession!=='function'){
  stats.disabled=true;return stats;
 }
 let candidates;
 try{
  candidates=await env.DB.prepare(`SELECT o.*,r.closed_at,r.disposal_approved_at,r.redacted_at,r.evidence_ref,r.session_id AS closure_session_id
   FROM orders o JOIN order_retention r ON r.order_id=o.id
   WHERE o.state IN ('expired','closed_unpaid') AND o.paid_at IS NULL AND o.payment_reference IS NULL
   -- Longer than both authentication/request timeouts including one auth retry.
   AND (o.checked_at IS NULL OR o.checked_at<=?)
   AND o.session_id IS NOT NULL AND o.session_id=r.session_id AND r.closure_kind='provider_expired'
   AND r.disposal_approved_at IS NOT NULL AND r.disposal_approved_at>=r.closed_at AND r.disposal_approved_at<=?
   AND r.legal_hold=0 AND r.invalidated_at IS NULL AND r.closed_at>0 AND r.closed_at<=?
   AND (r.redacted_at IS NULL OR r.closed_at<=?)
   AND (r.last_attempt_at IS NULL OR r.last_attempt_at<=?)
   ORDER BY COALESCE(r.last_attempt_at,0),r.closed_at,o.id LIMIT ?`)
   .bind(now-RETENTION.SETTLEMENT_GRACE_MS,now,now-RETENTION.PII_MS,now-RETENTION.EVIDENCE_MS,now-RETENTION.CHECK_INTERVAL_MS,RETENTION.BATCH_SIZE).all();
 }catch{
  stats.errors++;return stats;
 }
 for(const order of candidates.results){
  try{
   if(!dryRun){
    const claim=await env.DB.prepare(`UPDATE order_retention SET last_attempt_at=? WHERE order_id=? AND closed_at=?
     AND disposal_approved_at=? AND legal_hold=0 AND invalidated_at IS NULL
     AND (last_attempt_at IS NULL OR last_attempt_at<=?)`)
     .bind(now,order.id,order.closed_at,order.disposal_approved_at,now-RETENTION.CHECK_INTERVAL_MS).run();
    if(!changes(claim)){stats.retained++;continue;}
   }
   // Always obtain fresh provider evidence; cached checked_at is never deletion proof.
   stats.checked++;
   const session=await fetchSession(order);
   if(paymentMatches(order,session)){
    stats.observedPaid++;
    if(!dryRun)await env.DB.prepare("UPDATE orders SET state='paid',payment_reference=?,paid_at=?,checkout_url=NULL WHERE id=? AND session_id=? AND amount=? AND currency='KES' AND state!='paid' AND paid_at IS NULL AND payment_reference IS NULL")
     .bind(session.payment.reference,now,order.id,order.session_id,order.amount).run();
    stats.retained++;continue;
   }
   if(!expiredUnpaid(order,session)){
    if(!dryRun)await invalidateClosure(env.DB,order,now);
    stats.retained++;continue;
   }
   const erase=order.closed_at<=now-RETENTION.EVIDENCE_MS;
   if(dryRun){stats[erase?'wouldDelete':'wouldRedact']++;continue;}
   // Every destructive statement rechecks the same approval, closure/session and
   // paid markers. A hold, revoked approval or settlement during the GET wins.
   const guard=`id=? AND session_id=? AND amount=? AND currency='KES'
    AND state IN ('expired','closed_unpaid') AND paid_at IS NULL AND payment_reference IS NULL
    AND checked_at IS ?
    AND EXISTS(SELECT 1 FROM order_retention r WHERE r.order_id=orders.id AND r.session_id=orders.session_id
     AND r.closure_kind='provider_expired' AND r.closed_at=? AND r.closed_at<=? AND r.disposal_approved_at=?
     AND r.evidence_ref=? AND r.legal_hold=0 AND r.invalidated_at IS NULL AND r.last_attempt_at=?)`;
   const args=[order.id,order.session_id,order.amount,order.checked_at??null,order.closed_at,now-(erase?RETENTION.EVIDENCE_MS:RETENTION.PII_MS),order.disposal_approved_at,order.evidence_ref,now];
   if(erase){
    // The foreign key's ON DELETE CASCADE removes closure metadata atomically.
    const result=await env.DB.prepare('DELETE FROM orders WHERE '+guard).bind(...args).run();
    if(changes(result))stats.deleted++;else stats.retained++;
   }else{
    const results=await env.DB.batch([
     env.DB.prepare("UPDATE orders SET customer='{}',items='[]',request_hash='',checkout_url=NULL WHERE "+guard).bind(...args),
     env.DB.prepare(`UPDATE order_retention SET redacted_at=COALESCE(redacted_at,?),last_verified_at=?
      WHERE order_id=? AND closed_at=? AND disposal_approved_at=? AND evidence_ref=? AND legal_hold=0 AND invalidated_at IS NULL AND last_attempt_at=?
      AND EXISTS(SELECT 1 FROM orders o WHERE o.id=order_retention.order_id AND o.session_id=order_retention.session_id
       AND o.state IN ('expired','closed_unpaid') AND o.paid_at IS NULL AND o.payment_reference IS NULL
       AND o.checked_at IS ? AND o.amount=? AND o.currency='KES'
       AND o.customer='{}' AND o.items='[]' AND o.request_hash='')`)
      .bind(now,now,order.id,order.closed_at,order.disposal_approved_at,order.evidence_ref,now,order.checked_at??null,order.amount)
    ]);
    if(changes(results[0]))stats.redacted++;else stats.retained++;
   }
  }catch{
   stats.errors++;stats.retained++;
  }
 }
 return stats;
}
