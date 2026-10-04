-- 신청, 배정 초안 항목, 수강 이력에 당시 학생 소속을 별도로 보존한다.
ALTER TABLE applications ADD COLUMN affiliation TEXT CHECK (affiliation IS NULL OR length(affiliation) <= 200);
ALTER TABLE allocation_draft_items ADD COLUMN affiliation TEXT CHECK (affiliation IS NULL OR length(affiliation) <= 200);
ALTER TABLE enrollments ADD COLUMN affiliation TEXT CHECK (affiliation IS NULL OR length(affiliation) <= 200);

-- 기존 배정 스냅샷은 유지하고 추가된 소속은 NULL로 시작한다.
ALTER TABLE allocation_snapshot_applications ADD COLUMN affiliation TEXT CHECK (affiliation IS NULL OR length(affiliation) <= 200);
ALTER TABLE allocation_snapshot_existing_enrollments ADD COLUMN affiliation TEXT CHECK (affiliation IS NULL OR length(affiliation) <= 200);
