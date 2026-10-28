-- Additive and idempotent. Existing orders are not inferred closed or approved.
-- Apply before enabling ORDER_RETENTION_ENABLED; D1 enforces foreign keys.
CREATE TABLE IF NOT EXISTS order_retention (
 order_id TEXT PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
 session_id TEXT,
 closure_kind TEXT NOT NULL CHECK(closure_kind IN ('provider_expired','reconciled_unpaid')),
 closed_at INTEGER NOT NULL CHECK(closed_at > 0),
 last_verified_at INTEGER NOT NULL,
 evidence_ref TEXT NOT NULL CHECK(length(evidence_ref) BETWEEN 1 AND 120),
 disposal_approved_at INTEGER,
 legal_hold INTEGER NOT NULL DEFAULT 0 CHECK(legal_hold IN (0,1)),
 hold_reason TEXT,
 redacted_at INTEGER,
 last_attempt_at INTEGER,
 invalidated_at INTEGER
);
CREATE INDEX IF NOT EXISTS order_retention_due ON order_retention(legal_hold,closed_at,last_attempt_at);
