-- 공개된 migration 이력과 각 기록의 값을 유지하며 학생 소속 컬럼명만 변경한다.
ALTER TABLE applications RENAME COLUMN affiliation TO ministry;
ALTER TABLE allocation_draft_items RENAME COLUMN affiliation TO ministry;
ALTER TABLE enrollments RENAME COLUMN affiliation TO ministry;
ALTER TABLE allocation_snapshot_applications RENAME COLUMN affiliation TO ministry;
ALTER TABLE allocation_snapshot_existing_enrollments RENAME COLUMN affiliation TO ministry;
