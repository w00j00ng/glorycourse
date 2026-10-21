-- 각 기록과 스냅샷의 학생 소속 값은 삭제된다.
ALTER TABLE applications DROP COLUMN affiliation;
ALTER TABLE allocation_draft_items DROP COLUMN affiliation;
ALTER TABLE enrollments DROP COLUMN affiliation;
ALTER TABLE allocation_snapshot_applications DROP COLUMN affiliation;
ALTER TABLE allocation_snapshot_existing_enrollments DROP COLUMN affiliation;
