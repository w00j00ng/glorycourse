ALTER TABLE allocation_drafts
ADD COLUMN enrollment_report_downloaded_at TEXT;

ALTER TABLE allocation_drafts
ADD COLUMN enrollment_report_store_revision INTEGER
CHECK (enrollment_report_store_revision BETWEEN 0 AND 9007199254740991);
