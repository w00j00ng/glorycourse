-- 삭제했던 원래 연결 값은 복원하지 않고 NULL로 시작한다.
ALTER TABLE enrollments ADD COLUMN source_draft_id TEXT;
ALTER TABLE enrollments ADD COLUMN source_draft_item_id TEXT;
