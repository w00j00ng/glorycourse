-- 반복 선택이 있으면 UNIQUE 복원이 실패하며 전체 DDL은 롤백된다. 원본을 자동 삭제하지 않는다.
CREATE TEMP TABLE saved_choice_source_refs AS SELECT * FROM application_choice_source_refs;
DROP TABLE application_choice_source_refs;
CREATE TABLE replacement_application_choices (
  -- 컬럼: id - 레코드 식별자.
  id TEXT PRIMARY KEY,
  -- 컬럼: position - 원본 배열 또는 표시 순서를 보존하는 0 기반 순번.
  position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
  -- 컬럼: application_id - 수강 신청 식별자.
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  -- 컬럼: semester_course_id - 학기별 개설 강좌 식별자.
  semester_course_id TEXT NOT NULL REFERENCES semester_courses(id),
  -- 컬럼: preference - 신청 강좌의 희망 순위.
  preference INTEGER CHECK (preference BETWEEN 1 AND 9007199254740991),
  -- 컬럼: created_at - 레코드 생성 시각.
  created_at TEXT NOT NULL,
  -- 컬럼: updated_at - 레코드 최종 수정 시각.
  updated_at TEXT NOT NULL,
  UNIQUE (application_id, semester_course_id)
) STRICT;
INSERT INTO replacement_application_choices SELECT * FROM application_choices;
DROP TABLE application_choices;
ALTER TABLE replacement_application_choices RENAME TO application_choices;
CREATE TABLE application_choice_source_refs (
  -- 컬럼: application_choice_id - 수강 신청 강좌 선택 식별자.
  application_choice_id TEXT NOT NULL REFERENCES application_choices(id) ON DELETE CASCADE,
  -- 컬럼: position - 원본 배열 또는 표시 순서를 보존하는 0 기반 순번.
  position INTEGER NOT NULL CHECK (position >= 0),
  -- 컬럼: import_batch_id - 가져오기 작업 식별자.
  import_batch_id TEXT NOT NULL REFERENCES import_batches(id),
  -- 컬럼: sheet - 원본 엑셀 시트 이름.
  sheet TEXT NOT NULL,
  -- 컬럼: row_number - 원본 시트의 1 기반 행 번호.
  row_number INTEGER NOT NULL CHECK (row_number >= 1),
  PRIMARY KEY (application_choice_id, position)
) STRICT;
INSERT INTO application_choice_source_refs SELECT * FROM saved_choice_source_refs;
DROP TABLE saved_choice_source_refs;

ALTER TABLE allocation_snapshot_applications DROP COLUMN applicant_note;
ALTER TABLE applications DROP COLUMN applicant_note;
