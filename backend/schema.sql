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
