-- B-3: make successful placement-log retries idempotent.
ALTER TABLE placement_logs
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS placement_logs_idempotency_key_uq
  ON placement_logs (idempotency_key);
