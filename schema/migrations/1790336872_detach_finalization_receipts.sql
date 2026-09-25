CREATE TABLE finalization_receipts (
  idempotency_key TEXT PRIMARY KEY,
  position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
  request_hash TEXT NOT NULL,
  semester_id TEXT NOT NULL REFERENCES semesters(id),
  draft_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL UNIQUE,
  created_count INTEGER NOT NULL CHECK (created_count >= 0),
  finalized_at TEXT NOT NULL,
  enrollment_report_downloaded_at TEXT,
  enrollment_report_store_revision INTEGER CHECK (enrollment_report_store_revision >= 0)
) STRICT;

CREATE TABLE finalization_receipt_enrollment_ids (
  idempotency_key TEXT NOT NULL REFERENCES finalization_receipts(idempotency_key) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  enrollment_id TEXT NOT NULL,
  PRIMARY KEY (idempotency_key, position)
) STRICT;

INSERT INTO finalization_receipts (
  idempotency_key, position, request_hash, semester_id, draft_id, receipt_id,
  created_count, finalized_at, enrollment_report_downloaded_at, enrollment_report_store_revision
)
SELECT f.idempotency_key, d.position, f.request_hash, d.semester_id, d.id, r.receipt_id,
  r.created_count, r.finalized_at, d.enrollment_report_downloaded_at, d.enrollment_report_store_revision
FROM allocation_drafts d
JOIN allocation_finalizations f ON f.allocation_draft_id = d.id
JOIN allocation_finalization_receipts r ON r.allocation_draft_id = d.id
WHERE d.status = 'FINALIZED';

INSERT INTO finalization_receipt_enrollment_ids (idempotency_key, position, enrollment_id)
SELECT f.idempotency_key, e.position, e.enrollment_id
FROM allocation_finalization_enrollment_ids e
JOIN allocation_finalizations f ON f.allocation_draft_id = e.allocation_draft_id
JOIN allocation_drafts d ON d.id = e.allocation_draft_id
WHERE d.status = 'FINALIZED';

DELETE FROM allocation_drafts WHERE status = 'FINALIZED';
