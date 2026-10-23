PRAGMA application_id = 1195593557;

-- 테이블: schema_migrations - 적용된 데이터베이스 마이그레이션 이력을 관리한다.
CREATE TABLE schema_migrations (
  -- 컬럼: version - Unix timestamp 형식의 마이그레이션 버전.
  version INTEGER PRIMARY KEY NOT NULL CHECK (version BETWEEN 1000000000 AND 9999999999),
  -- 컬럼: name - 적용한 마이그레이션 SQL 파일 이름.
  name TEXT NOT NULL,
  -- 컬럼: checksum - 마이그레이션 SQL의 SHA-256 체크섬.
  checksum TEXT NOT NULL CHECK (length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'),
  -- 컬럼: applied_at - 마이그레이션 적용 시각.
  applied_at TEXT NOT NULL,
  -- 컬럼: app_version - 마이그레이션을 적용한 프로그램 버전.
  app_version TEXT NOT NULL
) STRICT;

-- 테이블: store_meta - 데이터 저장소의 단일 메타데이터와 낙관적 잠금 리비전을 관리한다.
CREATE TABLE store_meta (
  -- 컬럼: id - 레코드 식별자.
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- 컬럼: store_epoch - 백업 복원 등 저장소 계보 변경을 구분하는 식별자.
  store_epoch TEXT NOT NULL,
  -- 컬럼: store_revision - 저장소 전체 변경 순번.
  store_revision INTEGER NOT NULL CHECK (store_revision BETWEEN 0 AND 9007199254740991)
) STRICT;

-- 테이블: semesters - 수강 신청 대상 학기를 관리한다.
CREATE TABLE semesters (
  -- 컬럼: id - 레코드 식별자.
  id TEXT PRIMARY KEY,
  -- 컬럼: position - 원본 배열 또는 표시 순서를 보존하는 0 기반 순번.
  position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
  -- 컬럼: name - 사용자에게 표시할 이름.
  name TEXT NOT NULL,
  -- 컬럼: name_key - 중복 비교에 사용하는 정규화된 이름.
  name_key TEXT NOT NULL UNIQUE,
  -- 컬럼: semester_order - 학기의 시간 순서.
  semester_order INTEGER CHECK (semester_order BETWEEN 1 AND 9007199254740991),
  -- 컬럼: allocation_input_revision - 배정 입력 데이터의 변경 순번.
  allocation_input_revision INTEGER NOT NULL CHECK (allocation_input_revision BETWEEN 0 AND 9007199254740991),
  -- 컬럼: created_at - 레코드 생성 시각.
  created_at TEXT NOT NULL,
  -- 컬럼: updated_at - 레코드 최종 수정 시각.
  updated_at TEXT NOT NULL
) STRICT;

-- 테이블: members - 수강 신청 회원을 관리한다.
CREATE TABLE members (
  -- 컬럼: id - 레코드 식별자.
  id TEXT PRIMARY KEY,
  -- 컬럼: position - 원본 배열 또는 표시 순서를 보존하는 0 기반 순번.
  position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
  -- 컬럼: name - 사용자에게 표시할 이름.
  name TEXT NOT NULL,
  -- 컬럼: name_key - 중복 비교에 사용하는 정규화된 이름.
  name_key TEXT NOT NULL UNIQUE,
  -- 컬럼: created_at - 레코드 생성 시각.
  created_at TEXT NOT NULL,
  -- 컬럼: updated_at - 레코드 최종 수정 시각.
  updated_at TEXT NOT NULL
) STRICT;

-- 테이블: courses - 강좌 기본 정보를 관리한다.
CREATE TABLE courses (
  -- 컬럼: id - 레코드 식별자.
  id TEXT PRIMARY KEY,
  -- 컬럼: position - 원본 배열 또는 표시 순서를 보존하는 0 기반 순번.
  position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
  -- 컬럼: name - 사용자에게 표시할 이름.
  name TEXT NOT NULL,
  -- 컬럼: name_key - 중복 비교에 사용하는 정규화된 이름.
  name_key TEXT NOT NULL UNIQUE,
  -- 컬럼: created_at - 레코드 생성 시각.
  created_at TEXT NOT NULL,
  -- 컬럼: updated_at - 레코드 최종 수정 시각.
  updated_at TEXT NOT NULL
) STRICT;

-- 테이블: semester_courses - 학기별 개설 강좌와 정원을 관리한다.
CREATE TABLE semester_courses (
  -- 컬럼: id - 레코드 식별자.
  id TEXT PRIMARY KEY,
  -- 컬럼: position - 원본 배열 또는 표시 순서를 보존하는 0 기반 순번.
  position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
  -- 컬럼: semester_id - 학기 식별자.
  semester_id TEXT NOT NULL REFERENCES semesters(id),
  -- 컬럼: course_id - 강좌 식별자.
  course_id TEXT NOT NULL REFERENCES courses(id),
  -- 컬럼: capacity - 개설 강좌 정원.
  capacity INTEGER CHECK (capacity BETWEEN 0 AND 9007199254740991),
  -- 컬럼: created_at - 레코드 생성 시각.
  created_at TEXT NOT NULL,
  -- 컬럼: updated_at - 레코드 최종 수정 시각.
  updated_at TEXT NOT NULL,
  UNIQUE (semester_id, course_id)
) STRICT;

-- 테이블: import_batches - 엑셀 가져오기 작업의 단위와 처리 상태를 관리한다.
CREATE TABLE import_batches (
  -- 컬럼: id - 레코드 식별자.
  id TEXT PRIMARY KEY,
  -- 컬럼: position - 원본 배열 또는 표시 순서를 보존하는 0 기반 순번.
  position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
  -- 컬럼: kind - 가져오기 자료 종류.
  kind TEXT NOT NULL CHECK (kind IN ('APPLICATIONS', 'ENROLLMENTS')),
  -- 컬럼: template_version - 가져오기 파일 템플릿 버전.
  template_version TEXT NOT NULL,
  -- 컬럼: file_hash - 가져오기 원본 파일의 해시.
  file_hash TEXT NOT NULL,
  -- 컬럼: imported_at - 원본 파일을 읽은 시각.
  imported_at TEXT NOT NULL,
  -- 컬럼: status - 현재 처리 상태.
  status TEXT NOT NULL CHECK (status IN ('STAGED', 'APPLIED'))
) STRICT;

-- 테이블: import_raw_rows - 가져온 원본 시트의 행 위치를 보존한다.
CREATE TABLE import_raw_rows (
  -- 컬럼: import_batch_id - 가져오기 작업 식별자.
  import_batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  -- 컬럼: position - 원본 배열 또는 표시 순서를 보존하는 0 기반 순번.
  position INTEGER NOT NULL CHECK (position >= 0),
  -- 컬럼: sheet - 원본 엑셀 시트 이름.
  sheet TEXT NOT NULL,
  -- 컬럼: row_number - 원본 시트의 1 기반 행 번호.
  row_number INTEGER NOT NULL CHECK (row_number >= 1),
  PRIMARY KEY (import_batch_id, position),
  UNIQUE (import_batch_id, sheet, row_number)
) STRICT;

-- 테이블: import_raw_cells - 가져온 원본 행의 셀 값을 컬럼별로 보존한다.
CREATE TABLE import_raw_cells (
  -- 컬럼: import_batch_id - 가져오기 작업 식별자.
  import_batch_id TEXT NOT NULL,
  -- 컬럼: row_position - 가져오기 원본 행의 0 기반 순번.
  row_position INTEGER NOT NULL CHECK (row_position >= 0),
  -- 컬럼: position - 원본 배열 또는 표시 순서를 보존하는 0 기반 순번.
  position INTEGER NOT NULL CHECK (position >= 0),
  -- 컬럼: column_name - 원본 셀의 컬럼 이름.
  column_name TEXT NOT NULL,
  -- 컬럼: cell_value - 원본 셀 값.
  cell_value TEXT,
  PRIMARY KEY (import_batch_id, row_position, position),
  UNIQUE (import_batch_id, row_position, column_name),
  FOREIGN KEY (import_batch_id, row_position) REFERENCES import_raw_rows(import_batch_id, position) ON DELETE CASCADE
) STRICT;

-- 테이블: import_resolutions - 가져오기 충돌과 경고에 대한 사용자 해결 선택을 관리한다.
CREATE TABLE import_resolutions (
  -- 컬럼: import_batch_id - 가져오기 작업 식별자.
  import_batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  -- 컬럼: position - 원본 배열 또는 표시 순서를 보존하는 0 기반 순번.
  position INTEGER NOT NULL CHECK (position >= 0),
  -- 컬럼: entity - 해결 대상 엔터티 종류.
  entity TEXT NOT NULL CHECK (entity IN ('APPLICATION', 'ENROLLMENT', 'SEMESTER', 'SEMESTER_COURSE')),
  -- 컬럼: action - 사용자가 선택한 해결 방법.
  action TEXT NOT NULL CHECK (action IN ('KEEP_EXISTING', 'REPLACE_APPLICATION', 'CONFIRM_APPLICATION_ORDER', 'APPLY_FILE_VALUE', 'ACKNOWLEDGE_WARNING')),
  -- 컬럼: field - 해결 대상 필드.
  field TEXT CHECK (field IN ('order', 'capacity')),
  -- 컬럼: semester_name - 가져오기 자료에 기록된 학기 이름.
  semester_name TEXT,
  -- 컬럼: member_name - 가져오기 자료에 기록된 회원 이름.
  member_name TEXT,
  -- 컬럼: course_name - 가져오기 자료에 기록된 강좌 이름.
  course_name TEXT,
  -- 컬럼: application_order - 학기 내 신청 접수 순번.
  application_order INTEGER CHECK (application_order BETWEEN 1 AND 9007199254740991),
  -- 컬럼: warning_digest - 확인 대상 경고 집합의 해시.
  warning_digest TEXT,
  -- 컬럼: acknowledgement_note - 사용자가 남긴 경고 확인 메모.
  acknowledgement_note TEXT,
  PRIMARY KEY (import_batch_id, position)
) STRICT;

-- 테이블: import_receipts - 가져오기 반영 결과와 멱등성 정보를 관리한다.
CREATE TABLE import_receipts (
  -- 컬럼: import_batch_id - 가져오기 작업 식별자.
  import_batch_id TEXT PRIMARY KEY REFERENCES import_batches(id) ON DELETE CASCADE,
  -- 컬럼: receipt_id - 처리 결과 영수증 식별자.
  receipt_id TEXT NOT NULL UNIQUE,
  -- 컬럼: preview_id - 반영에 사용한 미리보기 식별자.
  preview_id TEXT NOT NULL,
  -- 컬럼: store_epoch - 백업 복원 등 저장소 계보 변경을 구분하는 식별자.
  store_epoch TEXT NOT NULL,
  -- 컬럼: idempotency_key - 중복 요청 방지 키.
  idempotency_key TEXT NOT NULL,
  -- 컬럼: request_hash - 요청 내용의 해시.
  request_hash TEXT NOT NULL,
  -- 컬럼: inserted_count - 새로 생성된 레코드 수.
  inserted_count INTEGER NOT NULL CHECK (inserted_count >= 0),
  -- 컬럼: updated_count - 수정된 레코드 수.
  updated_count INTEGER NOT NULL CHECK (updated_count >= 0),
  -- 컬럼: skipped_count - 변경 없이 건너뛴 레코드 수.
  skipped_count INTEGER NOT NULL CHECK (skipped_count >= 0),
  -- 컬럼: committed_at - 가져오기 결과를 반영한 시각.
  committed_at TEXT NOT NULL
) STRICT;

-- 테이블: applications - 회원별 학기 수강 신청과 신청 순서를 관리한다.
CREATE TABLE applications (
  -- 컬럼: id - 레코드 식별자.
  id TEXT PRIMARY KEY,
  -- 컬럼: position - 원본 배열 또는 표시 순서를 보존하는 0 기반 순번.
  position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
  -- 컬럼: semester_id - 학기 식별자.
  semester_id TEXT NOT NULL REFERENCES semesters(id),
  -- 컬럼: member_id - 회원 식별자.
  member_id TEXT NOT NULL REFERENCES members(id),
  -- 컬럼: application_order - 학기 내 신청 접수 순번.
  application_order INTEGER CHECK (application_order BETWEEN 1 AND 9007199254740991),
  -- 컬럼: application_order_status - 신청 순번의 유효성 또는 충돌 상태.
  application_order_status TEXT NOT NULL CHECK (application_order_status IN ('NORMAL', 'CONFLICT', 'MISSING', 'INVALID')),
  -- 컬럼: order_resolution - 신청 순번이 결정된 방식.
  order_resolution TEXT NOT NULL CHECK (order_resolution IN ('SOURCE_AGREED', 'ADMIN_CONFIRMED', 'UNRESOLVED')),
  -- 컬럼: order_resolution_note - 신청 순번 결정에 대한 관리자 메모.
  order_resolution_note TEXT,
  -- 컬럼: revision - 레코드 변경 순번.
  revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  -- 컬럼: created_at - 레코드 생성 시각.
  created_at TEXT NOT NULL,
  -- 컬럼: updated_at - 레코드 최종 수정 시각.
  updated_at TEXT NOT NULL,
  UNIQUE (semester_id, member_id)
) STRICT;

-- 테이블: application_choices - 수강 신청에 포함된 강좌 선택과 희망 순위를 관리한다.
CREATE TABLE application_choices (
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

-- 테이블: application_choice_source_refs - 강좌 선택이 유래한 가져오기 원본 위치를 관리한다.
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

-- 테이블: allocation_drafts - 수강 배정 초안과 실행 기준 정보를 관리한다.
CREATE TABLE allocation_drafts (
  -- 컬럼: id - 레코드 식별자.
  id TEXT PRIMARY KEY,
  -- 컬럼: position - 원본 배열 또는 표시 순서를 보존하는 0 기반 순번.
  position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
  -- 컬럼: semester_id - 학기 식별자.
  semester_id TEXT NOT NULL,
  -- 컬럼: status - 현재 처리 상태.
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'FINALIZED', 'ARCHIVED')),
  -- 컬럼: revision - 레코드 변경 순번.
  revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  -- 컬럼: mode - 배정 초안 생성 방식.
  mode TEXT NOT NULL CHECK (mode IN ('AUTO', 'MANUAL')),
  -- 컬럼: policy_id - 적용한 배정 정책 식별자.
  policy_id TEXT NOT NULL,
  -- 컬럼: policy_version - 적용한 배정 정책 버전.
  policy_version TEXT NOT NULL,
  -- 컬럼: engine_version - 배정 엔진 버전.
  engine_version TEXT NOT NULL,
  -- 컬럼: random_seed - 동률 처리 재현에 사용하는 무작위 시드.
  random_seed TEXT NOT NULL,
  -- 컬럼: source_revision - 배정 초안이 참조한 입력 데이터 변경 순번.
  source_revision INTEGER NOT NULL CHECK (source_revision BETWEEN 0 AND 9007199254740991),
  -- 컬럼: input_fingerprint - 배정 입력 전체의 해시.
  input_fingerprint TEXT NOT NULL,
  -- 컬럼: created_at - 레코드 생성 시각.
  created_at TEXT NOT NULL,
  -- 컬럼: updated_at - 레코드 최종 수정 시각.
  updated_at TEXT NOT NULL,
  -- 컬럼: finalized_at - 배정 초안을 확정한 시각.
  finalized_at TEXT
) STRICT;

-- 테이블: allocation_draft_policy_settings - 배정 초안에 적용된 정책 설정을 관리한다.
CREATE TABLE allocation_draft_policy_settings (
  -- 컬럼: allocation_draft_id - 배정 초안 식별자.
  allocation_draft_id TEXT PRIMARY KEY REFERENCES allocation_drafts(id) ON DELETE CASCADE,
  -- 컬럼: preference_mode - 희망 순위 적용 방식.
  preference_mode TEXT NOT NULL CHECK (preference_mode IN ('NEW_FIRST', 'RANK_FIRST')),
  -- 컬럼: fallback_mode - 대체 배정 방식.
  fallback_mode TEXT NOT NULL CHECK (fallback_mode = 'MAX_CARDINALITY_PRIORITIZED')
) STRICT;

-- 테이블: allocation_snapshot_semesters - 배정 실행 시점의 학기 정보를 보존한다.
CREATE TABLE allocation_snapshot_semesters (
  -- 컬럼: allocation_draft_id - 배정 초안 식별자.
  allocation_draft_id TEXT PRIMARY KEY REFERENCES allocation_drafts(id) ON DELETE CASCADE,
  -- 컬럼: semester_id - 학기 식별자.
  semester_id TEXT NOT NULL,
  -- 컬럼: name - 사용자에게 표시할 이름.
  name TEXT NOT NULL,
  -- 컬럼: semester_order - 학기의 시간 순서.
  semester_order INTEGER CHECK (semester_order BETWEEN 1 AND 9007199254740991)
) STRICT;

-- 테이블: allocation_snapshot_semester_courses - 배정 실행 시점의 개설 강좌 정보를 보존한다.
CREATE TABLE allocation_snapshot_semester_courses (
  -- 컬럼: allocation_draft_id - 배정 초안 식별자.
  allocation_draft_id TEXT NOT NULL REFERENCES allocation_drafts(id) ON DELETE CASCADE,
  -- 컬럼: position - 원본 배열 또는 표시 순서를 보존하는 0 기반 순번.
  position INTEGER NOT NULL CHECK (position >= 0),
  -- 컬럼: semester_course_id - 학기별 개설 강좌 식별자.
  semester_course_id TEXT NOT NULL,
  -- 컬럼: course_id - 강좌 식별자.
  course_id TEXT NOT NULL,
  -- 컬럼: course_name - 배정 초안 생성 시점의 강좌 이름.
  course_name TEXT NOT NULL,
  -- 컬럼: capacity - 개설 강좌 정원.
  capacity INTEGER CHECK (capacity BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (allocation_draft_id, position),
  UNIQUE (allocation_draft_id, semester_course_id)
) STRICT;

-- 테이블: allocation_snapshot_applications - 배정 실행 시점의 수강 신청 정보를 보존한다.
CREATE TABLE allocation_snapshot_applications (
  -- 컬럼: allocation_draft_id - 배정 초안 식별자.
  allocation_draft_id TEXT NOT NULL REFERENCES allocation_drafts(id) ON DELETE CASCADE,
  -- 컬럼: position - 원본 배열 또는 표시 순서를 보존하는 0 기반 순번.
  position INTEGER NOT NULL CHECK (position >= 0),
  -- 컬럼: application_id - 수강 신청 식별자.
  application_id TEXT NOT NULL,
  -- 컬럼: member_id - 회원 식별자.
  member_id TEXT NOT NULL,
  -- 컬럼: member_name - 배정 초안 생성 시점의 회원 이름.
  member_name TEXT NOT NULL,
  -- 컬럼: application_order - 학기 내 신청 접수 순번.
  application_order INTEGER CHECK (application_order BETWEEN 1 AND 9007199254740991),
  -- 컬럼: application_order_status - 신청 순번의 유효성 또는 충돌 상태.
  application_order_status TEXT NOT NULL CHECK (application_order_status IN ('NORMAL', 'CONFLICT', 'MISSING', 'INVALID')),
  PRIMARY KEY (allocation_draft_id, position),
  UNIQUE (allocation_draft_id, application_id)
) STRICT;

-- 테이블: allocation_snapshot_choices - 배정 실행 시점의 강좌 선택 정보를 보존한다.
CREATE TABLE allocation_snapshot_choices (
  -- 컬럼: allocation_draft_id - 배정 초안 식별자.
  allocation_draft_id TEXT NOT NULL REFERENCES allocation_drafts(id) ON DELETE CASCADE,
  -- 컬럼: position - 원본 배열 또는 표시 순서를 보존하는 0 기반 순번.
  position INTEGER NOT NULL CHECK (position >= 0),
  -- 컬럼: choice_id - 스냅샷에 보존한 강좌 선택 식별자.
  choice_id TEXT NOT NULL,
  -- 컬럼: application_id - 수강 신청 식별자.
  application_id TEXT NOT NULL,
  -- 컬럼: semester_course_id - 학기별 개설 강좌 식별자.
  semester_course_id TEXT NOT NULL,
  -- 컬럼: preference - 신청 강좌의 희망 순위.
  preference INTEGER CHECK (preference BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (allocation_draft_id, position),
  UNIQUE (allocation_draft_id, choice_id)
) STRICT;

-- 테이블: allocation_snapshot_past_enrollments - 배정 판단에 사용한 과거 수강 이력을 보존한다.
CREATE TABLE allocation_snapshot_past_enrollments (
  -- 컬럼: allocation_draft_id - 배정 초안 식별자.
  allocation_draft_id TEXT NOT NULL REFERENCES allocation_drafts(id) ON DELETE CASCADE,
  -- 컬럼: position - 원본 배열 또는 표시 순서를 보존하는 0 기반 순번.
  position INTEGER NOT NULL CHECK (position >= 0),
  -- 컬럼: enrollment_id - 수강 내역 식별자.
  enrollment_id TEXT NOT NULL,
  -- 컬럼: member_id - 회원 식별자.
  member_id TEXT NOT NULL,
  -- 컬럼: course_id - 강좌 식별자.
  course_id TEXT NOT NULL,
  -- 컬럼: semester_id - 학기 식별자.
  semester_id TEXT NOT NULL,
  -- 컬럼: semester_order - 학기의 시간 순서.
  semester_order INTEGER CHECK (semester_order BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (allocation_draft_id, position),
  UNIQUE (allocation_draft_id, enrollment_id)
) STRICT;

-- 테이블: allocation_snapshot_existing_enrollments - 배정 판단에 사용한 현재 학기 수강 이력을 보존한다.
CREATE TABLE allocation_snapshot_existing_enrollments (
  -- 컬럼: allocation_draft_id - 배정 초안 식별자.
  allocation_draft_id TEXT NOT NULL REFERENCES allocation_drafts(id) ON DELETE CASCADE,
  -- 컬럼: position - 원본 배열 또는 표시 순서를 보존하는 0 기반 순번.
  position INTEGER NOT NULL CHECK (position >= 0),
  -- 컬럼: enrollment_id - 수강 내역 식별자.
  enrollment_id TEXT NOT NULL,
  -- 컬럼: member_id - 회원 식별자.
  member_id TEXT NOT NULL,
  -- 컬럼: member_name - 배정 초안 생성 시점의 회원 이름.
  member_name TEXT NOT NULL,
  -- 컬럼: semester_course_id - 학기별 개설 강좌 식별자.
  semester_course_id TEXT NOT NULL,
  PRIMARY KEY (allocation_draft_id, position),
  UNIQUE (allocation_draft_id, enrollment_id)
) STRICT;

-- 테이블: allocation_draft_items - 회원별 자동 배정 결과와 최종 결정을 관리한다.
CREATE TABLE allocation_draft_items (
  -- 컬럼: id - 레코드 식별자.
  id TEXT PRIMARY KEY,
  -- 컬럼: position - 원본 배열 또는 표시 순서를 보존하는 0 기반 순번.
  position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
  -- 컬럼: allocation_draft_id - 배정 초안 식별자.
  allocation_draft_id TEXT NOT NULL REFERENCES allocation_drafts(id) ON DELETE CASCADE,
  -- 컬럼: member_id - 회원 식별자.
  member_id TEXT NOT NULL,
  -- 컬럼: source_application_id - 배정 항목의 원본 수강 신청 식별자.
  source_application_id TEXT,
  -- 컬럼: member_name_at_generation - 배정 초안 생성 시점의 회원 이름.
  member_name_at_generation TEXT NOT NULL,
  -- 컬럼: auto_semester_course_id - 자동 배정된 개설 강좌 식별자.
  auto_semester_course_id TEXT,
  -- 컬럼: auto_decision - 자동 배정 단계의 결정.
  auto_decision TEXT NOT NULL CHECK (auto_decision IN ('SELECTED', 'REJECTED', 'NOT_EVALUATED')),
  -- 컬럼: auto_reason_code - 자동 배정 결정 사유 코드.
  auto_reason_code TEXT NOT NULL,
  -- 컬럼: final_semester_course_id - 최종 배정된 개설 강좌 식별자.
  final_semester_course_id TEXT,
  -- 컬럼: final_decision - 관리자 검토 후 최종 결정.
  final_decision TEXT NOT NULL CHECK (final_decision IN ('SELECTED', 'REJECTED')),
  -- 컬럼: final_reason_code - 최종 결정 사유 코드.
  final_reason_code TEXT,
  -- 컬럼: updated_at - 레코드 최종 수정 시각.
  updated_at TEXT NOT NULL
) STRICT;

-- 테이블: allocation_item_preference_attempts - 희망 순위별 배정 시도 결과를 관리한다.
CREATE TABLE allocation_item_preference_attempts (
  -- 컬럼: allocation_draft_item_id - 회원별 배정 초안 항목 식별자.
  allocation_draft_item_id TEXT NOT NULL REFERENCES allocation_draft_items(id) ON DELETE CASCADE,
  -- 컬럼: position - 원본 배열 또는 표시 순서를 보존하는 0 기반 순번.
  position INTEGER NOT NULL CHECK (position >= 0),
  -- 컬럼: choice_id_at_generation - 초안 생성 시점의 강좌 선택 식별자.
  choice_id_at_generation TEXT NOT NULL,
  -- 컬럼: semester_course_id - 학기별 개설 강좌 식별자.
  semester_course_id TEXT NOT NULL,
  -- 컬럼: course_name_at_generation - 초안 생성 시점의 강좌 이름.
  course_name_at_generation TEXT NOT NULL,
  -- 컬럼: preference - 신청 강좌의 희망 순위.
  preference INTEGER NOT NULL CHECK (preference BETWEEN 1 AND 9007199254740991),
  -- 컬럼: decision - 배정 시도 결과.
  decision TEXT NOT NULL CHECK (decision IN ('SELECTED', 'REJECTED', 'NOT_EVALUATED')),
  -- 컬럼: reason_code - 배정 결과 사유 코드.
  reason_code TEXT NOT NULL,
  PRIMARY KEY (allocation_draft_item_id, position)
) STRICT;

-- 테이블: allocation_item_fallbacks - 희망 강좌 미배정 시 대체 배정 결과를 관리한다.
CREATE TABLE allocation_item_fallbacks (
  -- 컬럼: allocation_draft_item_id - 회원별 배정 초안 항목 식별자.
  allocation_draft_item_id TEXT PRIMARY KEY REFERENCES allocation_draft_items(id) ON DELETE CASCADE,
  -- 컬럼: selected_semester_course_id - 대체 배정으로 선택된 개설 강좌 식별자.
  selected_semester_course_id TEXT,
  -- 컬럼: reason_code - 배정 결과 사유 코드.
  reason_code TEXT NOT NULL,
  -- 컬럼: total_assigned_in_stage - 해당 대체 배정 단계의 전체 배정 인원.
  total_assigned_in_stage INTEGER NOT NULL CHECK (total_assigned_in_stage >= 0)
) STRICT;

-- 테이블: allocation_item_fallback_candidates - 대체 배정 검토 대상 강좌를 순서대로 관리한다.
CREATE TABLE allocation_item_fallback_candidates (
  -- 컬럼: allocation_draft_item_id - 회원별 배정 초안 항목 식별자.
  allocation_draft_item_id TEXT NOT NULL REFERENCES allocation_item_fallbacks(allocation_draft_item_id) ON DELETE CASCADE,
  -- 컬럼: position - 원본 배열 또는 표시 순서를 보존하는 0 기반 순번.
  position INTEGER NOT NULL CHECK (position >= 0),
  -- 컬럼: semester_course_id - 학기별 개설 강좌 식별자.
  semester_course_id TEXT NOT NULL,
  PRIMARY KEY (allocation_draft_item_id, position)
) STRICT;

-- 테이블: allocation_item_final_reasons - 관리자가 입력한 최종 배정 결정 사유를 관리한다.
CREATE TABLE allocation_item_final_reasons (
  -- 컬럼: allocation_draft_item_id - 회원별 배정 초안 항목 식별자.
  allocation_draft_item_id TEXT PRIMARY KEY REFERENCES allocation_draft_items(id) ON DELETE CASCADE,
  -- 컬럼: note - 관리자 또는 사용자가 입력한 설명.
  note TEXT NOT NULL
) STRICT;

-- 테이블: allocation_finalizations - 배정 확정 요청의 멱등성 정보를 관리한다.
CREATE TABLE allocation_finalizations (
  -- 컬럼: allocation_draft_id - 배정 초안 식별자.
  allocation_draft_id TEXT PRIMARY KEY REFERENCES allocation_drafts(id) ON DELETE CASCADE,
  -- 컬럼: idempotency_key - 중복 요청 방지 키.
  idempotency_key TEXT NOT NULL UNIQUE,
  -- 컬럼: request_hash - 요청 내용의 해시.
  request_hash TEXT NOT NULL
) STRICT;

-- 테이블: allocation_finalization_receipts - 배정 확정 처리 결과를 관리한다.
CREATE TABLE allocation_finalization_receipts (
  -- 컬럼: allocation_draft_id - 배정 초안 식별자.
  allocation_draft_id TEXT PRIMARY KEY REFERENCES allocation_finalizations(allocation_draft_id) ON DELETE CASCADE,
  -- 컬럼: receipt_id - 처리 결과 영수증 식별자.
  receipt_id TEXT NOT NULL UNIQUE,
  -- 컬럼: created_count - 배정 확정으로 생성된 수강 내역 수.
  created_count INTEGER NOT NULL CHECK (created_count >= 0),
  -- 컬럼: finalized_at - 배정 초안을 확정한 시각.
  finalized_at TEXT NOT NULL
) STRICT;

-- 테이블: allocation_finalization_enrollment_ids - 배정 확정으로 생성된 수강 내역 식별자를 관리한다.
CREATE TABLE allocation_finalization_enrollment_ids (
  -- 컬럼: allocation_draft_id - 배정 초안 식별자.
  allocation_draft_id TEXT NOT NULL REFERENCES allocation_finalization_receipts(allocation_draft_id) ON DELETE CASCADE,
  -- 컬럼: position - 원본 배열 또는 표시 순서를 보존하는 0 기반 순번.
  position INTEGER NOT NULL CHECK (position >= 0),
  -- 컬럼: enrollment_id - 수강 내역 식별자.
  enrollment_id TEXT NOT NULL,
  PRIMARY KEY (allocation_draft_id, position),
  UNIQUE (allocation_draft_id, enrollment_id)
) STRICT;

-- 테이블: allocation_finalization_warnings - 배정 확정 시 사용자가 확인한 경고를 관리한다.
CREATE TABLE allocation_finalization_warnings (
  -- 컬럼: allocation_draft_id - 배정 초안 식별자.
  allocation_draft_id TEXT NOT NULL REFERENCES allocation_finalizations(allocation_draft_id) ON DELETE CASCADE,
  -- 컬럼: position - 원본 배열 또는 표시 순서를 보존하는 0 기반 순번.
  position INTEGER NOT NULL CHECK (position >= 0),
  -- 컬럼: code - 경고 코드.
  code TEXT NOT NULL,
  -- 컬럼: message - 사용자에게 표시한 경고 메시지.
  message TEXT NOT NULL,
  -- 컬럼: severity - 경고 심각도.
  severity TEXT NOT NULL CHECK (severity = 'WARNING'),
  -- 컬럼: subject_entity_type - 경고 대상 엔터티 종류.
  subject_entity_type TEXT NOT NULL,
  -- 컬럼: subject_entity_id - 경고 대상 엔터티 식별자.
  subject_entity_id TEXT,
  -- 컬럼: subject_member_id - 경고 대상 회원 식별자.
  subject_member_id TEXT,
  -- 컬럼: subject_course_id - 경고 대상 강좌 식별자.
  subject_course_id TEXT,
  -- 컬럼: change_code - 경고와 관련된 변경 코드.
  change_code TEXT,
  -- 컬럼: note - 관리자 또는 사용자가 입력한 설명.
  note TEXT NOT NULL,
  -- 컬럼: acknowledged_at - 사용자가 경고를 확인한 시각.
  acknowledged_at TEXT NOT NULL,
  PRIMARY KEY (allocation_draft_id, position)
) STRICT;

-- 테이블: enrollments - 확정된 회원별 수강 내역을 관리한다.
CREATE TABLE enrollments (
  -- 컬럼: id - 레코드 식별자.
  id TEXT PRIMARY KEY,
  -- 컬럼: position - 원본 배열 또는 표시 순서를 보존하는 0 기반 순번.
  position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
  -- 컬럼: semester_course_id - 학기별 개설 강좌 식별자.
  semester_course_id TEXT NOT NULL REFERENCES semester_courses(id),
  -- 컬럼: member_id - 회원 식별자.
  member_id TEXT NOT NULL REFERENCES members(id),
  -- 컬럼: source_draft_id - 수강 내역을 생성한 배정 초안 식별자.
  source_draft_id TEXT,
  -- 컬럼: source_draft_item_id - 수강 내역을 생성한 배정 항목 식별자.
  source_draft_item_id TEXT,
  -- 컬럼: revision - 레코드 변경 순번.
  revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  -- 컬럼: created_at - 레코드 생성 시각.
  created_at TEXT NOT NULL,
  -- 컬럼: updated_at - 레코드 최종 수정 시각.
  updated_at TEXT NOT NULL
) STRICT;

-- 테이블: enrollment_acknowledgements - 수강 등록 시 사용자가 확인한 경고를 관리한다.
CREATE TABLE enrollment_acknowledgements (
  -- 컬럼: enrollment_id - 수강 내역 식별자.
  enrollment_id TEXT PRIMARY KEY REFERENCES enrollments(id) ON DELETE CASCADE,
  -- 컬럼: warning_digest - 확인 대상 경고 집합의 해시.
  warning_digest TEXT NOT NULL,
  -- 컬럼: note - 관리자 또는 사용자가 입력한 설명.
  note TEXT NOT NULL,
  -- 컬럼: acknowledged_at - 사용자가 경고를 확인한 시각.
  acknowledged_at TEXT NOT NULL
) STRICT;
