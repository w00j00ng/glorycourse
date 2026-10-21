-- 복원 성공 영수증은 프로그램 재시작과 이후 백업 복원에도 유지한다.
CREATE TABLE restore_receipts (
  idempotency_key TEXT PRIMARY KEY NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  receipt_id TEXT NOT NULL UNIQUE,
  previous_backup_id TEXT NOT NULL,
  store_revision INTEGER NOT NULL CHECK (store_revision BETWEEN 0 AND 9007199254740991),
  store_epoch TEXT NOT NULL,
  restored_at TEXT NOT NULL
) STRICT;
