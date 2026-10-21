# Glorycourse 개발 환경

일반 사용자의 설치·종료는 [README](../README.md), 업무 화면과 Excel 작성법은 [사용 설명서](usage.md)를 참고한다. 아래 명령은 소스 개발용이다. 배포본 실행기는 OS별 사용자 자료 폴더와 빈 포트를 선택하지만, `npm start`는 저장소의 `.data`와 기본 포트 4173을 사용한다. `GLORYCOURSE_DATA_DIR`와 `PORT`로 시험 경로와 포트를 지정할 수 있다.

로컬 단일 관리자용 수강신청·수강이력·배정 관리 시스템이다. 프런트엔드와 API는 외부 서비스 없이 같은 loopback 주소에서 실행된다.

## 기술 구성과 디렉터리

백엔드는 TypeScript와 Node.js 내장 HTTP·SQLite 모듈을 사용한다. Express 같은 웹 프레임워크는 사용하지 않는다. 프런트엔드는 HTML/CSS와 JavaScript ES modules이며 별도의 번들 빌드 없이 서버가 정적 파일을 제공한다.

| 경로 | 역할 |
| --- | --- |
| `backend/src/api/` | HTTP 라우팅, 요청 처리, 세션과 오류 응답 |
| `backend/src/services/` | 신청·이력·배정·이관의 업무 규칙 |
| `backend/src/bootstrap/` | 마이그레이션·스냅샷 SQL·Repository 초기화의 조합 |
| `backend/src/repository/` | 이름 있는 업무 SQL, 결과 매핑, 읽기·쓰기 트랜잭션과 충돌·복구 처리 |
| `backend/src/allocation/` | 배정 입력 스냅샷과 계산 엔진 |
| `backend/src/excel/` | XLSX 양식·현황 생성과 업로드 검증 |
| `backend/src/domain/` | 공용 레코드·조회 View·Filter·정렬 타입과 충돌·검증·복구 오류 |
| `backend/src/storage/` | 프로세스 잠금, SQLite 안전 사본·마이그레이션, 파일·스냅샷 검증 |
| `frontend/` | 화면, 메뉴, 도움말, 대시보드 판단과 다운로드 파일명 |
| `schema/migrations/` | Unix timestamp up/down SQL, manifest와 기존 이력 호환 metadata |
| `schema/migration_target/schema.sql` | 모든 migration을 적용한 현재 SQLite 전체 DDL |
| `schema/store-schema.json` | 메모리 내 관계형 상태의 검증 계약 |
| `openapi/openapi.yaml` | API 계약과 입력 한도 |
| `tests/` | 사용자 관점 기능·계약·저장·운영 테스트 |
| `scripts/` | 실행기, 배포 패키지, migration manifest, 커버리지 보고서 |

업무 SQL은 `repository/`의 업무별 TypeScript 파일에서 직접 확인할 수 있다. 서비스는 타입이 있는 인자를 repository 함수에 전달하며 SQL이나 전체 `DatabaseState`를 조회·변경하지 않는다. 마이그레이션·안전 사본 검사 등 저장 장치 관리용 SQL은 해당 `storage/` 모듈에 있다. 실제 DB 자료를 JSON 문서로 저장하지 않는다. HTTP 요청·검증 스키마·배포 설정의 JSON 사용은 별개다.

기본 서버는 `bootstrap/database.ts`의 `openRepository()`로 SQLite 파일을 열고 같은 repository를 라우터와 서비스에 주입한다. bootstrap은 storage 마이그레이션에 repository의 스냅샷 읽기·쓰기 함수를 전달한다. 초기화와 up 후 전체 검증은 같은 DDL 트랜잭션에서 처리하며, 실패하면 업무 자료를 롤백하고 dirty 상태를 유지한다. storage는 repository·services를 import하지 않고 repository는 services·bootstrap을 import하지 않는다. 공용 조회 타입은 `domain/query-models.ts`에서 가져온다. 일반 조회는 SQL로 현재 자료를 읽으며 업무 상태 전체를 메모리에 계속 보관하지 않는다. 한 응답에 필요한 여러 조회는 같은 읽기 트랜잭션에서 처리한다. 쓰기는 직렬화된 `BEGIN IMMEDIATE` 트랜잭션에서 버전 검사, 업무 SQL, 전체 revision 증가를 함께 커밋한다. 커밋 응답이 불확실하면 버전과 SQLite `data_version`을 확인하고, 판단할 수 없으면 후속 쓰기를 차단한다.

목록의 문자 그대로 검색은 `instr`로 처리한다. 한국어·영문 혼합 정렬의 기존 `localeCompare('ko')` 결과는 repository에서 보존하며 정렬 뒤 페이지를 나눈다. 배정·Excel 검토는 repository가 읽은 업무별 자료로 순수 계산을 수행한다. 따라서 모든 조회가 페이지 크기만큼만 읽는다고 해석하지 않는다. Store·SQLiteAdapter와 SQL 재노출 호환 경로는 제거했다. 사용자 정의 서버 핸들러도 `context.repository`의 이름 있는 쿼리를 사용한다. GET·HEAD 핸들러에는 `read()`·`version()`만 제공하고, 읽기 트랜잭션에서도 SQLite 쓰기를 차단한다. 서버 반환값은 `repository`를 제공하며 `store`는 제공하지 않는다.

## 실행과 종료

실행 런타임은 Node.js 22.14 이상이 필요하며, 개발 의존성의 `node` 패키지에 배포본과 같은 22.23.3을 고정한다. `npm ci`로 설치하면 `npm start`와 `npm run` 명령은 프로젝트의 `node_modules/.bin/node`를 우선 사용한다. 시스템 Node.js가 20인 환경에서도 설치 후에는 필요한 런타임으로 실행된다. `npm ci --ignore-scripts`는 Node 바이너리 설치를 생략하므로, 이 옵션을 쓰는 CI는 먼저 지원 버전의 Node.js를 준비해야 한다.

```powershell
npm ci
npm start
```

`node: bad option: --experimental-strip-types`가 나오면 시스템의 오래된 Node.js로 실행되고 있는 것이다. `npm ci`를 다시 실행하고 `node_modules/.bin/node --version`이 `v22.23.3`인지 확인한다. 런타임을 시스템에서 직접 관리하려면 `.nvmrc`를 사용하는 `nvm install`과 `nvm use`로 같은 버전을 선택할 수 있다. Node.js 20에는 내장 SQLite도 없으므로 시작 명령에서 타입 제거 옵션만 삭제해서 해결할 수 없다.

시스템 Node.js 20으로 `npm ci`를 실행할 때는 설치 단계에서 `EBADENGINE` 경고가 나올 수 있다. 기본 설정에서는 설치가 계속되고 이후 npm 명령은 프로젝트 런타임을 사용한다. `engine-strict=true`로 설치 자체가 차단되는 환경에서는 먼저 `.nvmrc`의 Node.js 버전으로 전환한다.

브라우저에서 <http://127.0.0.1:4173>을 연다. 업무 자료는 기본적으로 `.data/db.sqlite`, DB 변경 전 안전 사본은 `.data/update-backups/`에 저장된다. 수동 백업·복원 기능은 제거했으며 기존 파일은 삭제하지 않는다. `.data`는 Git에서 제외되며 동시에 두 서버를 같은 자료 경로로 실행할 수 없다.

`npm start`를 실행한 터미널에서 **Ctrl+C**를 누르거나 화면의 **프로그램 종료**를 사용한다. 브라우저 탭만 닫으면 서버는 계속 실행된다. `InstanceAlreadyRunningError`가 나오면 같은 자료 폴더를 사용하는 기존 서버를 먼저 종료한다. 실행 중인 서버가 있는 상태에서 잠금 파일을 임의로 삭제하지 않는다.

실제 업무 자료와 개발 시험을 분리하는 PowerShell 예시:

```powershell
$env:GLORYCOURSE_DATA_DIR = Join-Path $env:TEMP 'glorycourse-dev-test'
$env:PORT = '4174'
npm start
```

이 설정은 현재 터미널에서 시작하는 서버에 적용된다. 종료 후 기본값으로 돌아가려면 해당 환경변수를 지우거나 새 터미널을 사용한다. `npm start`는 브라우저를 자동으로 열지 않으므로 출력된 주소에 직접 접속한다.

## DB 스키마 변경

DB 스키마는 `schema/migrations/<10자리 Unix seconds>_description.up.sql`과 같은 버전의 `.down.sql` 쌍으로 관리한다. `schema_migrations`는 `version INTEGER`·`dirty INTEGER` 두 컬럼의 현재 상태 한 행만 저장한다. `dirty`는 0 또는 1이며, 버전 0은 업무 테이블을 만들기 전 상태다. 앱 버전과 DB 버전은 별개다. 업무 자료는 명시 컬럼과 자식 테이블에 저장한다. 미배포 개발용 `db.json` 및 이력 테이블이 없는 비어 있지 않은 SQLite DB는 자동 이전하지 않는다.

| 기동 시 DB 상태 | 동작 |
| --- | --- |
| 신규 빈 DB 또는 정상 버전 0 | 전체 up과 초기 자료 저장 |
| 정상이며 목표보다 낮은 알려진 버전 | 남은 up을 오름차순으로 적용 |
| 정상이며 목표와 같은 버전 | DDL 생략 |
| `dirty=1` | 기동 차단, 업데이트 전 안전 사본으로 복구 |
| 더 새로운 버전·알 수 없는 버전·잘못된 상태 행 | 기동 차단 |

기존 DB의 up/down과 이력 변환 전에 `update-backups/`에 검증된 SQLite 안전 사본을 만든다. 적용할 목적 버전과 `dirty=1`을 먼저 별도 트랜잭션으로 영속화한 뒤, 전체 DDL 묶음·up 결과 자료 검증·`dirty=0` 확정을 한 트랜잭션으로 처리한다. SQL 실패나 강제 종료 시 업무 DDL·자료는 롤백되지만 dirty 표시는 남아 다음 기동을 차단한다. 이때 `version`은 적용 완료를 뜻하지 않는다. 신규 DB에는 백업할 기존 업무 자료가 없으며 실패 후 dirty 상태만 남을 수 있다.

기존 5컬럼 이력의 파일명·checksum·연속된 버전은 고정된 `legacy-manifest.json`과 먼저 대조한 뒤 두 컬럼으로 변환한다. 이미 최신 업무 구조여도 이 변환과 안전 사본은 필요하다. 이번 전환에서 기존 SQL을 `.up.sql`로 옮기고 초기 up의 상태 테이블 정의를 바꾸며, 나머지 up의 내용·checksum은 유지한다. 원래 초기 SQL은 `tests/fixtures/migrations/1790294400_init.sql`에 보존한다. 이후 배포한 up/down SQL과 기존 metadata는 수정하지 않는다. 두 컬럼으로 변환한 뒤에는 DB 안에 과거 checksum을 저장하지 않으므로, 적용 이력의 변경 여부를 DB 자체로 재검증할 수 없다. 동봉 SQL의 checksum 검사와 배포 파일의 수정 금지 규칙을 유지한다.

전체 테이블·인덱스와 제약은 [migration target](../schema/migration_target/schema.sql)에서 확인한다. `npm run migrations:manifest`는 up을 메모리 SQLite에 순서대로 적용하고 manifest와 최종 DDL을 생성한다. 기존 metadata의 모든 항목을 런타임과 같은 버전·파일명·checksum 기준으로 검사하고, 대응 SQL이 없는 여분 항목도 거절한다. 기존 이력을 보존한 채 새 up/down 쌍을 추가할 수 있다. 모든 down을 역순으로 실행해 이전 객체·컬럼 목록 복원과 FK 위반 여부도 검사한다. 이 역검사는 CHECK·인덱스 등의 정의 전체나 삭제한 자료의 복원까지 보장하지 않는다. `npm run migrations:check`는 같은 검사를 수행하며 생성 파일을 변경하지 않고 manifest·target의 불일치를 거절한다. `verify`·패키징에도 포함된다. target은 자료·상태 행이 없는 생성 파일이며 직접 편집하지 않는다. 서버의 DB 업데이트는 개별 migration을 사용한다.

`store-schema.json`은 자동 생성되지 않는 수기 논리 계약이다. `storage/validate-store.ts`가 실행 시 Ajv로 초기·복구 후보와 up 후 전체 자료를 검증하고, `repository/validation.ts`가 일반 저장의 변경 행을 검증한다. `npm run schema:check`는 실제 TypeScript `DatabaseState`와 필드·필수 여부·원시 타입·nullable·enum/const·배열·중첩 객체 구조를 비교하고 불일치를 거절하며, `verify`와 패키징에 포함된다. `$ref`·`oneOf`·타입 없는 `allOf`에 구조 키워드를 함께 지정하거나, `type` 옆의 `allOf`가 조건부 업무 규칙 외에 구조를 제한하면 거절한다. 선언 없는 `required`, 정규화한 선택지가 중복·부분 중첩되는 `oneOf`, `enum`·`const` 동시 지정도 거절한다. 배열은 일반 `items` 또는 `prefixItems`·`items: false`의 고정 tuple을 비교하며 두 방식을 혼합하면 거절한다. `anyOf`·`not`은 지원하지 않으며 설명 같은 주석 속성은 허용한다. 문자열 길이·숫자 범위·조건부 업무 제약·추가 속성 허용 규칙은 타입 대조 범위가 아니므로 Ajv와 기능 테스트로 확인한다. SQL 컬럼과 중첩 논리 자료는 일대일 구조가 아니며, 실제 SQLite 저장 왕복·migration 자료 보존 검사로 대응 관계를 검증한다.

일반 저장은 repository에서 변경할 행을 검증하고 명시적인 INSERT·UPDATE·DELETE를 실행한다. Excel 원본, 배정 스냅샷과 자동 사유 등 자식 자료는 해당 내용이 달라질 때만 교체한다. 저장 버전 확인부터 연관 행 변경까지 한 트랜잭션으로 처리한다. 초기 생성은 빈 테이블에 삽입한다. `Repository.snapshot()`·`restore()`와 전체 상태 SQL 매핑은 초기 검증·마이그레이션·내부 복구에만 사용한다. 내부 복구는 후보 전체 검증, 예상 버전 확인, 안전 사본 콜백, 변경 행 저장을 수행한다. 복구 COMMIT의 응답이 불확실하면 실제 전체 자료를 후보·이전 상태와 대조하며, 버전이 같아도 저장 전 실패와 저장 후 응답 유실을 구분한다. 기능 테스트도 실제 임시 SQLite를 사용하며 전체 상태 변경 헬퍼는 테스트 자료 준비에만 사용한다. 임시 변경이 필요한 미리보기는 분리된 업무 자료로 계산하며, 해당 자료의 배열 복사·행 탐색은 자료량에 비례할 수 있다.

1. 기존 최대 버전보다 큰 Unix 초 timestamp로 `.up.sql`·`.down.sql` 쌍을 추가한다. 배포한 쌍과 고정된 기존 metadata를 수정하거나 삭제하지 않는다.
2. SQL은 UTF-8 BOM 없이 LF 줄바꿈으로 작성한다. 트랜잭션은 실행기가 관리하므로 `BEGIN`·`COMMIT`이나 `schema_migrations` 직접 변경문을 넣지 않는다.
3. `domain/records.ts`, `store-schema.json`, `repository/`와 필요한 API 계약을 함께 갱신한다. 반복 값은 자식 테이블, 단일 값은 개별 컬럼으로 저장한다.
4. `npm run migrations:manifest`로 manifest와 target을 함께 갱신한 뒤 새 DB 생성·기존 DB 업그레이드·명시적 down/up·실패의 dirty 영속화·업데이트 안전 사본을 검증하고 `npm run verify`를 실행한다.

자동 down은 수행하지 않는다. 서버를 종료한 시험 DB에 명시적인 목표를 지정한다. 다음 명령은 `1792540800`에서 `1791158400`으로 내려 신청자 메모 컬럼을 제거하고 강좌 중복 선택 금지 제약을 복원한다. 메모가 유실되므로 먼저 안전 사본을 보관한다. 반복 강좌 선택이 있으면 down 전체가 롤백되고 dirty 상태를 유지한다. CLI는 서버와 같은 자료 폴더 잠금을 사용하며 실행 중인 서버가 있으면 거절한다.

```powershell
npm run migrations:down -- .data/db.sqlite 1791158400
```

알 수 없는 목표·현재보다 높은 목표·dirty DB는 거절한다. 목표 0은 모든 업무 테이블을 삭제하고 `version=0, dirty=0`만 남긴다. down으로 삭제한 소속·영수증과 이전 up에서 이미 삭제한 확정 초안 자료는 복원되지 않는다. 다음 정상 기동은 최신 up을 다시 적용하지만 유실된 값은 재생성하지 않는다. 상태 테이블은 down 후에도 두 컬럼이므로, 기존 5컬럼 이력을 사용하는 구버전 실행 파일로 복귀하려면 해당 버전과 호환되는 전환 전 안전 사본을 사용한다. dirty를 임의로 0으로 바꿔 실패를 우회하지 않는다.

현재 목표 DB 버전은 `1792540800`이며 manifest에는 8개 up/down 쌍이 있다. [신청 메모·반복 희망 up](../schema/migrations/1792540800_application_notes_repeated_choices.up.sql)은 신청과 초안 신청 스냅샷에 메모를 추가하고, 출처를 보존하며 같은 강좌의 반복 희망을 허용한다. 신청별 조회 인덱스는 비고유 인덱스로 유지한다. 이전 [명칭 변경 up](../schema/migrations/1791158400_rename_student_ministry.up.sql)은 신청·초안 항목·이력과 신청/동일 학기 이력 스냅샷의 소속 컬럼을 `ministry`로 바꾸고 기존 문자열·null 값을 유지한다. 이전 소속 추가 up의 내용·checksum은 보존하며 회원 테이블에는 추가하지 않는다. 기록 간 복사·수정 API·fingerprint 호환 규칙은 [학생 소속 계약](contract-decisions.md#c-14-학생-소속의-시점별-보관)을 따른다.

## 화면과 업무 규칙 변경

- 페이지별 도움말과 대시보드 업무 설명은 `frontend/help-content.js`의 `PAGE_HELP`를 공유한다. `PROGRESS_WORKFLOW`는 네 업무 페이지의 순서를 따른다.
- 현재 학기 정렬과 다음 할 일 판단은 `frontend/dashboard-view.js`의 순수 함수다. 빈 자료, 설정 중, 신청 접수, 초안 검토, 확정과 현황 다운로드 상태를 사용자 입력·기대 안내 표로 검증한다.
- 업무 완료는 일반 `GET /enrollments/export`가 아니라 `POST /semesters/{id}/enrollment-report`로 기록한다. 파일 생성 시점과 저장 시점의 자료가 같아야 하며, 상세 규칙은 [계약 결정 기록](contract-decisions.md)에 있다.
- 사용자가 보는 버튼·양식·완료 조건을 변경하면 [사용 설명서](usage.md), [문제 해결](troubleshooting.md), [README](../README.md)도 맞춘다. `npm run docs:html`은 같은 Markdown 원본에서 배포용 오프라인 HTML을 `dist/guide-preview`에 생성한다. 현재 소스에 있는 기능과 공개된 배포본의 기능을 구별한다.

## Excel 보관과 업데이트 안전 사본

수강신청·수강이력 현황 Excel을 보관하고 각 화면의 Excel 업로드로 재등록한다. 신청 현황 버전 `4`는 신청자 메모·반복 희망의 원래 순위, 조회된 신청 학기의 순서와 전체 개설강좌·정원을 포함하며 미정은 공란이다. 신청 버전 `2`·`3`도 읽으며 메모 열이 없으면 교체 반영 시 기존 메모를 유지한다. 메모 열이 있는 공란은 명시적 교체 시 null로 반영한다. 이력 양식 버전 `3`은 학생 소속·선택 메모와 별도 개설강좌 시트의 정원을 보존하며, 소속 열이 없는 버전 `2`도 읽는다. `미정`은 null 정원으로 읽으며 정원 충돌은 명시적 선택을 요구한다. 같은 이력은 기존 메모를 유지하며 소속이 다르면 충돌로 표시한다. 배정초안·시스템 기록은 Excel에 포함하지 않는다.

수동 백업·복원 UI/API와 `services/recovery.ts`·`storage/backup.ts`는 제거했다. 역사적 DB 필드와 기존 파일을 유지하므로 이 기능 제거를 위한 migration은 필요하지 않다. SQL migration 전의 안전 사본은 `sqlite-snapshot.ts`를 통해 계속 생성·검증한다. 내부 `Repository.restore()`의 복구 처리는 유지하며 사용자 복원 기능을 제공하지 않는다. Store·SQLiteAdapter의 호환 구현은 제거했다.

이력 검토 준비 토큰은 기본 5분, 배정 확정 검토는 10분, Excel 검토는 15분 후 만료된다. 프로세스 재시작이나 검토 후 자료 변경으로도 반영이 거절될 수 있으므로 새로 검토한다. 화면의 **입력 경고 무시**는 확인 창과 안내·경고 표시만 생략하고 서버의 오류·충돌·digest 검증은 유지한다.

## 검증

```powershell
npm run verify
npm run test:browser
npm run test:coverage
npm run test:scale
npm run test:storage-scale
npm run test:workbook-scale
```

- `verify`: migration 쌍·manifest·target, Store JSON/타입 구조 대조, OpenAPI, 타입, 기능·계약·실제 파일 저장, 강제 종료 복구와 실행기 검증. 패키지·부하·실제 GUI 검증은 별도다.
- `typecheck`: 백엔드 TypeScript와 `tsconfig.frontend.json`에 열거한 화면·목록·학기/강좌·파일명·경고 표시 모듈의 JavaScript를 `checkJs`로 검사한다. 이 모듈들이 가져오는 도움말·대시보드 판단 모듈도 함께 검사한다. 공통 초기화와 이벤트를 연결하는 `frontend/app.js`는 아직 타입 검사 대상이 아니다.
- `test:browser`: 별도 임시 자료 폴더에서 실제 Chromium을 열어 신청 양식 다운로드·Excel 반영, 과거 수강이력 일괄 등록, 소속·메모 수정과 Excel 정원·소속·메모 재등록, 강좌 편집값 보존 정렬과 수강이력 전체 정렬·페이지·Excel, 초안 최종 결정 저장·자동 복원·정원 현황과 확정, 대량 초안 페이지 처리를 검증한다. 최초 실행 전 `npx playwright install chromium --only-shell`로 브라우저를 설치한다. CI도 같은 테스트를 별도 작업으로 실행한다.
- `test:coverage`: `verify`를 [c8](https://github.com/bcoe/c8)으로 실행해 `coverage/index.html`, `coverage/lcov.info`, `coverage/coverage-summary.json`과 요약을 생성한다. 백엔드 전체, 프런트엔드 JavaScript 전체, `launcher.mjs`와 `runtime-paths.mjs`가 대상이다. 별도로 실행하는 브라우저 테스트의 사용 줄은 이 수치에 합산되지 않아 `frontend/app.js`처럼 Node 테스트에서 실행하지 않는 파일은 0%로 포함된다. 빌드·검증 스크립트와 테스트 자체는 집계하지 않는다.
- README 상단의 Backend·Frontend 배지와 링크는 `docs/coverage-report/`의 SVG·Markdown을 상대 경로로 참조한다. GitHub가 [현재 브랜치의 상대 이미지·링크로 해석](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes#relative-links-and-image-paths-in-markdown-files)하므로 브랜치를 바꾸면 해당 브랜치에 보관한 측정값이 표시된다. `test:coverage`가 이 생성 파일도 갱신하며 소스·테스트 변경과 함께 반영해야 한다. 생성 파일은 직접 편집하지 않는다.
- 배지는 `backend/src/`와 `frontend/`별 줄 커버리지를 표시하며, 파일별 실행 줄 수를 합산한다. 80% 이상은 초록색, 미만은 주황색이다. README는 브랜치에 보관한 측정 결과이며, 브랜치·PR별 최신 CI 결과는 해당 실행의 요약과 `coverage-report` artifact에서 확인한다.
- 기본 브랜치의 성공한 CI는 `coverage/pages/`의 정적 SVG 배지와 HTML 요약을 GitHub Pages에 배포한다. 저장소 설정의 **Pages → Build and deployment → Source**는 `GitHub Actions`로 한 번 지정해야 한다. CI는 README를 수정하거나 커밋하지 않으며 개인 토큰이나 외부 커버리지 서비스도 사용하지 않는다.
- PR에서는 Backend·Frontend 각각의 줄 커버리지가 80% 미만이면 해당 영역과 수치를 GitHub Actions 경고 annotation과 실행 요약에 표시한다. 80% 이상이면 경고하지 않으며, 커버리지 미달 자체는 테스트 실패나 병합 차단으로 처리하지 않는다.
- `test:scale`: 10,000명·1,000강좌와 대체 배정 부하 검증
- `test:storage-scale`: 회원 1천·1만 명의 신청·이력·Excel 원본·초안이 섞인 자료에서 회원 한 건 수정의 시간과 SQLite 변경 건수를 측정하고 재시작 후 자료 일치도 검사한다. 1만 신청·5만 반복 희망에서 강좌 필터의 신청자 수·페이지·재수강 경고와 조회 시간도 검증한다. 전체 교체 저장 경로는 제거했다. 시간은 환경에 따라 달라지며 변경 건수 회귀를 중점적으로 확인한다.
- `test:workbook-scale`: 메모·줄바꿈을 포함한 xlsx의 총 10만 행 보존과 한 행 초과 거절을 검증한다. 약 1GiB heap을 사용할 수 있어 별도로 실행한다.
- `test:desktop`: 로그인한 데스크톱에서 기본 브라우저를 실제로 열고 시험 페이지 요청까지 확인한다. 브라우저 탭 하나가 열리며 확인 후 닫아도 된다. GUI가 없는 CI의 `verify`에는 포함하지 않는다.

테스트는 사용자 동작의 입력과 기대 결과를 명시하고 기능을 호출해 검증한다. 고객 PC의 보안 경고와 OS별 첫 실행은 자동 브라우저 테스트 통과와 별도로 [배포 점검](releasing.md)을 수행한다. 실데이터 검증을 기록할 때는 개인정보 없는 표본과 환경·자료 규모·결과를 사용하고, 공개 문서에 실제 명단이나 백업을 포함하지 않는다.

학생 소속의 기능 검증은 `tests/integration/student-ministry.test.mjs`에서 양식 4순위·소속, 기존 3~5순위 양식, 직접·일괄 입력, 재시작, 초안 복사·수정·확정, 소속 충돌과 수정 요청의 생략/null/공란을 확인한다. `migrations.test.mjs`는 v0.2.2 DB의 문자열·null 소속과 스냅샷을 ministry로 이전하고 기존 fingerprint와 백업의 원래 이력을 보존하는지 확인한다. `migration-state.test.mjs`는 상태에 따른 기동·기존 이력 검증·실패 롤백·down/up과 유실·CLI 잠금을, `migration-manifest.test.mjs`는 실제 생성기와 런타임의 metadata 거부 기준 및 새 migration 추가를 검사한다. `store-schema-drift.test.mjs`는 변형한 JSON 계약의 불일치와 지원하지 않는 구조 조합의 거절을 검사한다. `crash-write.test.mjs`는 DDL 중 강제 종료 후 dirty 영속화와 기동 차단도 확인한다. `sqlite.test.mjs`·`sqlite-incremental.test.mjs`는 저장 왕복을, `app-reload.test.mjs`는 저장 대기 중 새로 입력한 소속 보존을 검사한다. 이 기능 검사는 `npm run verify`에 포함된다.
