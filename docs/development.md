# Glorycourse 개발 환경

일반 사용자의 설치·종료는 [README](../README.md), 업무 화면과 Excel 작성법은 [사용 설명서](usage.md)를 참고한다. 아래 명령은 소스 개발용이다. 배포본 실행기는 OS별 사용자 자료 폴더와 빈 포트를 선택하지만, `npm start`는 저장소의 `.data`와 기본 포트 4173을 사용한다. `GLORYCOURSE_DATA_DIR`와 `PORT`로 시험 경로와 포트를 지정할 수 있다.

로컬 단일 관리자용 수강신청·수강이력·배정 관리 시스템이다. 프런트엔드와 API는 외부 서비스 없이 같은 loopback 주소에서 실행된다.

## 기술 구성과 디렉터리

백엔드는 TypeScript와 Node.js 내장 HTTP·SQLite 모듈을 사용한다. Express 같은 웹 프레임워크는 사용하지 않는다. 프런트엔드는 HTML/CSS와 JavaScript ES modules이며 별도의 번들 빌드 없이 서버가 정적 파일을 제공한다.

| 경로 | 역할 |
| --- | --- |
| `backend/src/api/` | HTTP 라우팅, 요청 처리, 세션과 오류 응답 |
| `backend/src/services/` | 신청·이력·배정·이관·복원의 업무 규칙 |
| `backend/src/allocation/` | 배정 입력 스냅샷과 계산 엔진 |
| `backend/src/excel/` | XLSX 양식·현황 생성과 업로드 검증 |
| `backend/src/storage/` | 저장 직렬화, 잠금, 백업과 마이그레이션 |
| `backend/src/storage/queries/` | 업무 자료를 명시 컬럼과 자식 테이블로 읽고 쓰는 SQL 구현 |
| `frontend/` | 화면, 메뉴, 도움말, 대시보드 판단과 다운로드 파일명 |
| `schema/migrations/` | Unix timestamp SQL, manifest와 DB 변경 이력 |
| `schema/store-schema.json` | 메모리 내 관계형 상태의 검증 계약 |
| `openapi/openapi.yaml` | API 계약과 입력 한도 |
| `tests/` | 사용자 관점 기능·계약·저장·운영 테스트 |
| `scripts/` | 실행기, 배포 패키지, migration manifest, 커버리지 보고서 |

업무 SQL은 `storage/queries/`에서 관리하며 마이그레이션·백업 파일 검사 등 저장 장치 관리용 SQL은 해당 `storage/` 모듈에 있다. 실제 DB 자료를 JSON 문서로 저장하지 않는다. HTTP 요청·검증 스키마·배포 설정의 JSON 사용은 별개다.

## 실행과 종료

Node.js 22.14 이상이 필요하다.

```powershell
npm ci
npm start
```

브라우저에서 <http://127.0.0.1:4173>을 연다. 업무 자료는 기본적으로 `.data/db.sqlite`, 수동 백업과 복원 직전 안전 사본은 `.data/backups/`, DB 변경 전 안전 사본은 `.data/update-backups/`에 저장된다. `.data`는 Git에서 제외되며 동시에 두 서버를 같은 자료 경로로 실행할 수 없다.

`npm start`를 실행한 터미널에서 **Ctrl+C**를 누르거나 화면의 **프로그램 종료**를 사용한다. 브라우저 탭만 닫으면 서버는 계속 실행된다. `InstanceAlreadyRunningError`가 나오면 같은 자료 폴더를 사용하는 기존 서버를 먼저 종료한다. 실행 중인 서버가 있는 상태에서 잠금 파일을 임의로 삭제하지 않는다.

실제 업무 자료와 개발 시험을 분리하는 PowerShell 예시:

```powershell
$env:GLORYCOURSE_DATA_DIR = Join-Path $env:TEMP 'glorycourse-dev-test'
$env:PORT = '4174'
npm start
```

이 설정은 현재 터미널에서 시작하는 서버에 적용된다. 종료 후 기본값으로 돌아가려면 해당 환경변수를 지우거나 새 터미널을 사용한다. `npm start`는 브라우저를 자동으로 열지 않으므로 출력된 주소에 직접 접속한다.

## DB 스키마 변경

DB 스키마는 `schema/migrations/<10자리 Unix seconds>_description.sql`과 `schema_migrations`로 관리한다. 업무 자료는 JSON 문서가 아니라 명시 컬럼과 자식 테이블에 저장한다. 실행 전에 이력을 확인하고, 미적용 SQL이 있으면 `update-backups/`에 SQLite 백업을 만든 뒤 한 트랜잭션으로 적용한다. `npm run migrations:manifest`로 manifest를 갱신하고 `npm run migrations:check`로 검증한다. 미배포 개발용 `db.json` 및 이력 테이블이 없는 SQLite DB는 자동 이전하지 않는다.

일반 저장은 직전 상태와 후보를 비교해 변경된 행만 INSERT·UPDATE·DELETE한다. Excel 원본, 배정 스냅샷과 자동 사유 등 자식 자료는 해당 내용이 달라질 때만 교체한다. `backend/src/storage/queries/`에서 SQL을 관리하며, 저장 버전 확인부터 연관 행 변경까지 한 트랜잭션으로 처리한다. 초기 생성·백업 복원은 전체 교체 경로를 사용한다. 메모리의 전체 후보 복제·검증·비교 비용은 여전히 자료량에 비례한다.

1. 기존 최대 버전보다 큰 Unix 초 timestamp로 새 `.sql` 파일을 추가한다. 이미 배포한 파일의 이름·내용은 수정하거나 삭제하지 않는다.
2. SQL은 UTF-8 BOM 없이 LF 줄바꿈으로 작성한다. 트랜잭션은 실행기가 관리하므로 `BEGIN`·`COMMIT`이나 `schema_migrations` 직접 변경문을 넣지 않는다.
3. `store.ts`, `store-schema.json`, `storage/queries/`와 필요한 API 계약을 함께 갱신한다. 반복 값은 자식 테이블, 단일 값은 개별 컬럼으로 저장한다.
4. `npm run migrations:manifest` 후 새 DB 생성·기존 DB 업그레이드·백업 복원 경로를 검증하고 `npm run verify`를 실행한다.

적용 이력의 checksum 불일치, 누락 또는 실행 프로그램보다 새로운 DB 버전이면 시작을 거절한다. 마이그레이션에 실패하면 변경을 롤백하며, 임의로 이력 값을 고쳐서 우회하지 않는다. 지원하는 자동 다운그레이드는 없다.

## 화면과 업무 규칙 변경

- 페이지별 도움말과 대시보드 업무 설명은 `frontend/help-content.js`의 `PAGE_HELP`를 공유한다. 필수 진행 단계인 `PROGRESS_WORKFLOW`에는 선택 기능인 백업을 포함하지 않는다.
- 현재 학기 정렬과 다음 할 일 판단은 `frontend/dashboard-view.js`의 순수 함수다. 빈 자료, 설정 중, 신청 접수, 초안 검토, 확정과 현황 다운로드 상태를 사용자 입력·기대 안내 표로 검증한다.
- 업무 완료는 일반 `GET /enrollments/export`가 아니라 `POST /semesters/{id}/enrollment-report`로 기록한다. 파일 생성 시점과 저장 시점의 자료가 같아야 하며, 상세 규칙은 [계약 결정 기록](contract-decisions.md)에 있다.
- 사용자가 보는 버튼·양식·완료 조건을 변경하면 [사용 설명서](usage.md), [문제 해결](troubleshooting.md), [README](../README.md)도 맞춘다. `npm run docs:html`은 같은 Markdown 원본에서 배포용 오프라인 HTML을 `dist/guide-preview`에 생성한다. 현재 소스에 있는 기능과 공개된 배포본의 기능을 구별한다.

## 백업과 복원

**자료 관리**에서 사용자가 요청할 때 SQLite 백업을 만들고 목록의 생성 시각·자료 버전·크기·SHA-256을 확인할 수 있다. 최근 정상 백업의 `storeEpoch`와 `storeRevision`이 현재 자료와 같으면 기존 백업을 반환한다. 일반 등록·수정·삭제, Excel 반영, 배정 확정은 자동 백업을 만들지 않는다.

복원할 때 `.sqlite` 백업 파일을 선택해 현재 자료와 백업의 버전을 먼저 검토한다. 구버전 백업은 임시 사본에 SQL 마이그레이션을 적용한다. 백업 이후 변경 내용이 사라진다는 경고를 확인한 뒤 메모를 입력해야 복원되며, 복원 직전의 현재 자료도 자동으로 백업된다.

## 검증

```powershell
npm run verify
npm run test:coverage
npm run test:scale
npm run test:storage-scale
npm run test:workbook-scale
```

- `verify`: migration manifest, OpenAPI, 타입, 기능·계약·실제 파일 저장, 강제 종료 복구와 실행기 검증. 패키지·부하·실제 GUI 검증은 별도다.
- `test:coverage`: `verify`를 [c8](https://github.com/bcoe/c8)으로 실행해 `coverage/index.html`, `coverage/lcov.info`, `coverage/coverage-summary.json`과 요약을 생성한다. 백엔드 전체, 프런트엔드 JavaScript 전체, `launcher.mjs`와 `runtime-paths.mjs`가 대상이다. 아직 브라우저에서 테스트하지 않는 `frontend/app.js` 등 미실행 파일도 0%로 포함한다. 빌드·검증 스크립트와 테스트 자체는 집계하지 않는다.
- 기본 브랜치의 성공한 CI는 `coverage/pages/`의 정적 SVG 배지와 HTML 요약을 GitHub Pages에 배포한다. 저장소 설정의 **Pages → Build and deployment → Source**는 `GitHub Actions`로 한 번 지정해야 한다. CI는 README를 수정하거나 커밋하지 않으며 개인 토큰이나 외부 커버리지 서비스도 사용하지 않는다.
- README 상단의 Backend·Frontend 배지는 `https://w00j00ng.github.io/glorycourse/coverage/` 아래의 고정 경로를 참조한다. 배지는 `backend/src/`와 `frontend/`별 줄 커버리지를 표시하며, 파일별 실행 줄 수를 합산한다. 80% 이상은 초록색, 미만은 주황색이다.
- PR에서는 Backend·Frontend 각각의 줄 커버리지가 80% 미만이면 해당 영역과 수치를 GitHub Actions 경고 annotation과 실행 요약에 표시한다. 80% 이상이면 경고하지 않으며, 커버리지 미달 자체는 테스트 실패나 병합 차단으로 처리하지 않는다.
- `test:scale`: 10,000명·1,000강좌와 대체 배정 부하 검증
- `test:storage-scale`: 회원 1천·1만 명의 신청·이력·Excel 원본·초안이 섞인 자료에서 회원 한 건 수정의 시간과 SQLite 변경 건수를 측정한다. 복원용 전체 교체 경로와 일반 부분 저장을 비교하고 재시작 후 자료 일치도 검사한다. 시간은 환경에 따라 달라지며 변경 건수 회귀를 중점적으로 확인한다.
- `test:workbook-scale`: xlsx 기본 행 한도의 생성·재파싱 검증. 약 700MiB heap을 사용할 수 있어 별도로 실행한다.
- `test:desktop`: 로그인한 데스크톱에서 기본 브라우저를 실제로 열고 시험 페이지 요청까지 확인한다. 브라우저 탭 하나가 열리며 확인 후 닫아도 된다. GUI가 없는 CI의 `verify`에는 포함하지 않는다.

테스트는 사용자 동작의 입력과 기대 결과를 명시하고 기능을 호출해 검증한다. 브라우저 조작, 고객 PC의 보안 경고와 OS별 첫 실행은 자동 테스트 통과와 별도로 [배포 점검](releasing.md)을 수행한다. 실데이터 검증을 기록할 때는 개인정보 없는 표본과 환경·자료 규모·결과를 사용하고, 공개 문서에 실제 명단이나 백업을 포함하지 않는다.
