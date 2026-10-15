CREATE TABLE IF NOT EXISTS users (id BIGSERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, full_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer' CHECK(role IN ('customer','admin')), status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','suspended')), created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS accounts (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id), account_type TEXT NOT NULL CHECK(account_type IN ('personal','business')), label TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS transactions (id BIGSERIAL PRIMARY KEY, account_id BIGINT NOT NULL REFERENCES accounts(id), posted_at TIMESTAMPTZ NOT NULL DEFAULT now(), description TEXT NOT NULL, amount_cents BIGINT NOT NULL, source TEXT NOT NULL DEFAULT 'simulation');
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id), expires_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log (id BIGSERIAL PRIMARY KEY, actor_id BIGINT REFERENCES users(id), action TEXT NOT NULL, target_id BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_tx_account_date ON transactions(account_id, posted_at DESC);

ALTER TABLE users ADD COLUMN IF NOT EXISTS requested_account_types TEXT[] NOT NULL DEFAULT ARRAY['personal','business']::TEXT[];
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_account_type_per_user ON accounts(user_id,account_type);
CREATE INDEX IF NOT EXISTS idx_session_expiry ON sessions(expires_at);
