CREATE TABLE IF NOT EXISTS orders (
 id TEXT PRIMARY KEY,
 token_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 amount INTEGER NOT NULL,
 currency TEXT NOT NULL CHECK(currency = 'KES'),
 items TEXT NOT NULL,
 customer TEXT NOT NULL,
 language TEXT NOT NULL,
 terms_version TEXT NOT NULL,
 early_start INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL DEFAULT 'creating',
 session_id TEXT UNIQUE,
 checkout_url TEXT,
 payment_reference TEXT,
 created_at INTEGER NOT NULL,
 checked_at INTEGER,
 paid_at INTEGER
);
CREATE INDEX IF NOT EXISTS orders_pending ON orders(state, checked_at);
CREATE TABLE IF NOT EXISTS rate_limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
-- Retention is opt-in. A provider closure alone never authorizes erasure.
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
