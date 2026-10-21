-- 다운로드 완료 시각과 당시 리비전은 삭제된다.
ALTER TABLE allocation_drafts DROP COLUMN enrollment_report_downloaded_at;
ALTER TABLE allocation_drafts DROP COLUMN enrollment_report_store_revision;
