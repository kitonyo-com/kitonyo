-- READ ONLY. Run in the authenticated EU D1 console after the retention migration.
-- Results contain internal identifiers: keep them out of public logs/repositories.
-- No contact JSON, project brief or requested domain is selected.

SELECT state,COUNT(*) AS orders FROM orders GROUP BY state ORDER BY state;

-- Manual reconciliation queue, including legacy/missing-session uncertainty.
SELECT id,state,session_id,created_at,checked_at
FROM orders
WHERE state NOT IN ('paid','expired')
 AND created_at <= CAST(strftime('%s','now') AS INTEGER)*1000-7*86400000
ORDER BY created_at;

-- Legacy expired labels without a durable closure are not proof for disposal.
SELECT o.id,o.state,o.session_id,o.created_at,o.checked_at
FROM orders o LEFT JOIN order_retention r ON r.order_id=o.id
WHERE o.state='expired' AND r.order_id IS NULL ORDER BY o.created_at;

-- Closures awaiting review/approval, or held/contradictory evidence.
SELECT o.id,o.state,r.closure_kind,r.closed_at,r.last_verified_at,
 r.disposal_approved_at,r.legal_hold,r.hold_reason,r.invalidated_at
FROM orders o JOIN order_retention r ON r.order_id=o.id
WHERE r.disposal_approved_at IS NULL OR r.legal_hold=1 OR r.invalidated_at IS NOT NULL
ORDER BY r.closed_at;

-- Preliminary due counts only; provider verification and all live guards still apply.
SELECT
 SUM(CASE WHEN r.redacted_at IS NULL AND r.closed_at<=CAST(strftime('%s','now') AS INTEGER)*1000-30*86400000 THEN 1 ELSE 0 END) AS potentially_due_redactions,
 SUM(CASE WHEN r.closed_at<=CAST(strftime('%s','now') AS INTEGER)*1000-1095*86400000 THEN 1 ELSE 0 END) AS potentially_due_erasures
FROM orders o JOIN order_retention r ON r.order_id=o.id
WHERE o.state='expired' AND o.paid_at IS NULL AND o.payment_reference IS NULL
 AND o.session_id IS NOT NULL AND o.session_id=r.session_id
 AND r.closure_kind='provider_expired' AND r.disposal_approved_at IS NOT NULL
 AND r.legal_hold=0 AND r.invalidated_at IS NULL;

-- Restricted journal input: save outside D1 before approving/activating cleanup.
-- Reconcile actual redactions/missing orders with that journal after each batch.
SELECT r.order_id,r.session_id,r.closure_kind,r.closed_at,r.disposal_approved_at,
 r.evidence_ref,r.redacted_at,r.legal_hold,r.invalidated_at
FROM order_retention r ORDER BY r.closed_at,r.order_id;

-- Paid-record review reminder, NOT an erasure deadline. Establish actual contract
-- end and applicable accounting/claims periods before any operator action.
SELECT id,state,paid_at,created_at,payment_reference
FROM orders
WHERE (state='paid' OR paid_at IS NOT NULL OR payment_reference IS NOT NULL)
 AND datetime(COALESCE(paid_at,created_at)/1000,'unixepoch','+3 years')<=datetime('now')
ORDER BY COALESCE(paid_at,created_at);

-- Inconsistent states always require review and remain excluded from cleanup.
SELECT id,state,paid_at,payment_reference
FROM orders WHERE state!='paid' AND (paid_at IS NOT NULL OR payment_reference IS NOT NULL);
