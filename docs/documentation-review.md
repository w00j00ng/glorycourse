# 문서 검증 및 개정 기록

## 2026-10-04 학생 소속과 기본 4순위 개정

기준은 `feat/student-affiliation` 작업 브랜치의 변경사항이며, 기준 커밋은 `d1620bf`다. 기능·문서 개정 이후 PR·릴리즈 준비에서 앱·lockfile·OpenAPI 버전을 `0.2.2`로 맞췄다. 이 기록은 기능 구현·반복 검토와 그에 따른 문서 개정 결과이며 공개 Release·고객 PC의 배포 검증 결과가 아니다. 아래 2026-10-03 기록은 당시 근거와 수치를 보존한다.

저장소의 README와 `docs/` Markdown 12개, OpenAPI 설명을 대조했다. 이번 기능과 관련된 현재 안내를 개정하고 의존성과 과거 측정값은 유지했다. 후속 리팩터링·조회 이관 계획에는 기록별 소속을 보존하는 조건을 추가했다.

| 문서 | 이번 개정 내용 |
| --- | --- |
| [README](../README.md) | 기본 4순위·선택 5순위, 소속 선택 입력·시점별 보존과 현황 파일·재등록 안내 |
| [사용 설명서](usage.md) | 소속 컬럼의 Excel 예시, 직접 입력·초안 수정·자동 복원 시 소속 유지·확정 검토, 신청 교체와 이력 소속 충돌·현황 다운로드 |
| [문제 해결](troubleshooting.md) | 기본 양식의 열 이름·버전 2 호환, 소속 충돌 해결과 기존 초안·이력이 소급 갱신되지 않는 이유 |
| [개발 환경](development.md) | 목표 DB 버전·nullable 컬럼·회원 테이블 제외, 소속 기능과 지연 응답의 회귀 검사 범위 |
| [계약 결정 기록](contract-decisions.md#c-14-학생-소속의-시점별-보관) | 다섯 캐싱 컬럼, 독립된 기록 간 복사, 수정 시 생략/null/공란·자동 복원 시 소속 유지, fingerprint·revision·digest·Excel 충돌 |
| [Excel 등록 검토 규칙](excel-import-review-design.md) | 신청·이력 버전 3, 소속 없는 버전 2, 원본 버전 기록과 빈 원본 파일 내보내기의 범위 |
| [배포 관리자 안내](releasing.md) | 4순위·소속 전달·구양식·기존 DB·Excel 재등록 점검과 Release에 기록할 형식 변경 |
| [저장소 전체 처리 점검](storage-full-operation-plan.md) | 기존 행·스냅샷을 보존하는 학생 소속 migration과 상세 계약 연결 |
| [프로젝트 점검 기록](maintenance-review.md) | 기존 결과를 당시 기록으로 유지하고 이번 변경·검증 기록으로 연결 |
| [저장·화면 분할 계획](refactoring-plan.md) | 후속 변경에서도 기록별 소속과 기존 null 스냅샷의 fingerprint를 보존하는 조건 |
| [Store.read 사용처 제거 계획](store-read-removal-plan.md) | 조회 이관에서 각 기록의 소속을 회원·현재 신청 값으로 대체하지 않는 조건 |
| [OpenAPI](../openapi/openapi.yaml) | 기본 4순위·현황 소속·버전 2 호환·소속 충돌·초안 생성/수정/자동 복원/확정의 소속 처리 설명 |

### 구현 근거

- [양식 구현](../backend/src/excel/workbooks.ts)의 기본 희망 열은 4개, 최대는 5개다. 신청·이력 기본 양식 버전은 모두 `3`이며 소속 없는 버전 `2`를 읽는다.
- [migration](../schema/migrations/1791072000_add_student_affiliation.sql)과 [manifest](../schema/migrations/manifest.json)는 6개 이력·목표 DB 버전 `1791072000`을 선언한다. 이전 SQL과 checksum은 유지하며 다섯 업무·스냅샷 테이블에 nullable `affiliation`을 추가한다. 회원 테이블에는 추가하지 않는다.
- [스냅샷](../backend/src/allocation/snapshot.ts)·[초안](../backend/src/services/drafts.ts)·[확정](../backend/src/services/finalization.ts)은 신청 소속을 초안에, 저장된 초안 소속을 이력에 복사한다. 원본 수정은 기존 기록을 덮어쓰지 않는다. null 소속의 기존 fingerprint도 유지한다.
- [신청](../backend/src/services/applications.ts)·[이력](../backend/src/services/enrollments.ts)·초안 수정 API는 소속 생략 시 기존 값을 유지하고 명시적 null·공란으로 비운다. [OpenAPI](../openapi/openapi.yaml)의 nullable·200자 계약과 일치한다.
- [가져오기 검토](../backend/src/services/import-preview.ts)·[반영](../backend/src/services/import-commit.ts)은 원본 `templateVersion`을 보관·반영 기록에 유지한다. 소속만 달라도 신청 충돌이며 기존 이력과 소속이 다르면 전체 반영을 막는다.

### 검증 범위

같은 작업 브랜치에서 문서 개정 직전 수행한 기능 구현·보완 검증은 Windows의 임시 합성 자료 기준이다. `npm run verify`의 기능·계약 253개, 강제 종료 복구 2개, 실행기 5개와 `npm run test:browser`의 Chromium 흐름 35개가 통과했다. 보완 후 독립 검토의 관련 테스트 59개도 통과했으며 추가 차단 사항은 발견되지 않았다.

이번 문서 개정에서는 제품 코드·의존성·DB·버전을 추가 변경하지 않았다. 추가 대조에서 API 다운로드 설명과 자동 복원 시 소속 유지 안내를 보완하고 저장·조회 개선 계획도 갱신했다. Markdown 13개와 로컬 링크 117개, 표의 열 수, 생성된 오프라인 HTML 두 개의 링크·앵커·소속·4순위 안내를 확인했다. `npm run docs:html`·`npm run test:openapi`·`git diff --check`가 통과했으며 OpenAPI의 설명·요약을 제외한 요청·응답 구조는 수정 전과 같음을 비교했다. SQL 변경도 다시 확인하여 `npm run migrations:check`의 migration 6개와 실제 SQLite 저장·재시작을 포함한 통합 테스트 9개가 통과했다. 패키지·공개 Release·원격 CI·실제 고객 자료·GUI 첫 실행·성능·커버리지는 이번 문서 개정의 검증 범위에 포함하지 않는다.

### v0.2.2 게시 전 확인

릴리즈 준비에서 앱·lockfile·OpenAPI를 `0.2.2`로 맞추고 전체 검증을 다시 수행했다. `npm run verify`의 기능·계약 253개, 강제 종료 복구 2개, 실행기 5개와 Chromium 흐름 35개가 통과했다. `npm run package`·`npm run test:package`로 Windows x64 압축본의 파일 무결성·동봉 Node·실행기·기본 4순위와 소속 양식·소속의 Excel 재등록·재시작 보존을 확인했다. 압축본에는 새 소속 SQL migration도 포함된다.

이 압축본은 커밋 전 로컬 검증용이며 `dirty: true`다. 고객 Release에 그대로 사용하지 않는다. PR 병합 후 공개할 `main` 커밋에 `v0.2.2` 태그를 붙이고 그 태그의 세 OS 패키지 CI와 사용자 PC 첫 실행을 확인한다. 이번 게시 준비에서는 태그·초안 Release·공개 Release를 생성하지 않는다.

## 이전 검토: 2026-10-03

검토일: 2026-10-03 (한국 시간). 기준은 작업 브랜치 `fix/npm-start-node-runtime`의 `b9db3c9`와 앱 버전 `0.2.0`이다. 기본 브랜치의 최근 구현 `09b64ef`를 포함하며, 이번 작업의 문서 수정은 해당 커밋 위에 적용했다. 공개 Release나 원격 브랜치의 최신 상태를 검증한 기록은 아니다.

## 분석 범위

기존 Markdown 문서 12개를 모두 읽고, 화면·서비스·저장 계층·배포 스크립트와 최근 변경 이력을 대조했다. OpenAPI·저장 스키마·SQL migration과 manifest·런타임 설정도 문서의 근거로 확인했다. 이 파일은 이번 대조 결과를 기록하기 위해 추가했다.

| 문서 | 제공 내용 | 대조 결과와 개정 |
| --- | --- | --- |
| [README](../README.md) | 다운로드·실행·업무 순서·자료 보관 | 수동 초안의 신청 없는 직접 배정, 경고 무시의 적용 범위를 보완 |
| [사용 설명서](usage.md) | 화면별 사용법·Excel 예시·학기 완료 | 과거 이력의 파일 정원 우선 규칙, 수동 초안·홈 완료 조건, 오류·충돌·확정 검토를 구분 |
| [문제 해결](troubleshooting.md) | 실행·입력·배정·업데이트 오류 | 이력 5분·확정 10분·Excel 15분의 검토 만료와 경고 무시의 한계를 추가 |
| [개발 환경](development.md) | 실행·코드 구조·DB 변경·검증 | 고정 Node 설정을 확인하고 안전 사본·남은 내부 복원·타입 검사·검토 만료 설명을 정리 |
| [직접 의존성](dependencies.md) | 실행·개발 패키지와 라이선스 | 누락된 Playwright를 추가하고 package.json의 허용 버전과 lockfile의 설치 버전을 구분 |
| [배포 관리자 안내](releasing.md) | 패키징·CI·Release·고객 업데이트 | 과거 Windows 검증과 현재 검증을 구분하고 동봉 문서 범위·Node·현재 태그 예시를 정리 |
| [계약 결정 기록](contract-decisions.md) | revision·토큰·멱등성·업무 불변조건 | 양식 버전·검토 유효시간·원본 보관·차이 저장·제한의 실제 적용 범위를 수정 |
| [Excel 등록 검토 규칙](excel-import-review-design.md) | 양식·경고·정원·메모·후보 반영 | 현재 구현 근거, Preview 만료·보관·재시도, Excel 안내와 직접 입력 경고의 차이를 명시 |
| [프로젝트 점검 기록](maintenance-review.md) | 이전 수정·시험·성능 측정 | 2026-09-26의 역사적 기록으로 명시하고 이후 제거·추가된 기능을 정리. 과거 계정 한도·중단 지침은 제거 |
| [저장 경로와 화면 분할 계획](refactoring-plan.md) | 저장 최적화·화면 책임 분리 | 당시 완료 기록과 현재 상태를 구분하고 삭제된 백업 화면 참조·남은 조회와 타입 검사 범위를 정리 |
| [저장소 전체 처리 점검](storage-full-operation-plan.md) | 전체 DB 처리와 복제의 경계 | 사용자 복원 제거, 내부 후보 검증·차이 저장, 마이그레이션 안전 사본을 현재 동작으로 수정 |
| [Store.read 사용처 제거 계획](store-read-removal-plan.md) | 전체 상태 조회의 단계별 이관 | 시작 당시 33곳과 현재 남은 5곳을 구분하고 실제 파일별 범위·메모리 조회를 명시 |

| 기계 판독 계약·설정 | 확인 결과 |
| --- | --- |
| [OpenAPI](../openapi/openapi.yaml) | API 설명 버전을 현재 앱 `0.2.0`과 맞추고 검토 유효시간·강제되지 않는 `storeBytes`를 설명. 경로와 요청·응답 구조는 유지 |
| [저장 스키마](../schema/store-schema.json) | 현재 Store 타입·검증과 대조. 기존 복원 영수증 필드는 호환성 때문에 유지하며 스키마 수정은 필요하지 않음 |
| [SQL migrations](../schema/migrations/)·[manifest](../schema/migrations/manifest.json) | 5개 migration, 목표 DB 버전 `1790336872`. 기존 이력과 checksum은 수정하지 않음 |
| [package.json](../package.json)·[lockfile](../package-lock.json)·`.nvmrc`·[배포 설정](../scripts/release-config.json)·CI | 앱 `0.2.0`, 최소 Node `22.14.0`, 개발·배포·CI Node `22.23.3` 일치. Playwright는 허용 범위 `^1.63.0`, 설치 버전 `1.63.0` |

## 최근 구현과 핵심 불일치

최근 기능 변경은 `da1e41e`(과거 이력 입력·검토), `09b64ef`(Excel 보관·수동 배정), `b9db3c9`(개발 Node 고정)이다. 사용자 문서는 상당 부분 반영되어 있었지만 계약 문서와 이전 계획에 다음 불일치가 남아 있었다.

| 항목 | 기존 문서의 문제 | 확인한 구현과 개정 기준 |
| --- | --- | --- |
| 이력 Excel 버전 | 계약 C-13은 버전 `1`, 다른 문서는 버전 `2` | [workbooks.ts](../backend/src/excel/workbooks.ts)의 `TEMPLATE_VERSIONS`는 신청·이력 모두 `2`. 이력은 메모와 개설강좌 정원을 보존 |
| 검토 유효시간 | 이력·확정 모두 10분, Excel 30분으로 안내 | [EnrollmentService](../backend/src/services/enrollments.ts) 5분, [FinalizationService](../backend/src/services/finalization.ts) 10분, [ImportPreviewService](../backend/src/services/import-preview.ts) 15분 |
| 전체 교체 저장 | 초기화·복원에는 전체 교체가 남는다고 안내 | [관계형 저장](../backend/src/storage/queries/relational-store.ts)은 최초 생성 시 빈 테이블 삽입, 일반 쓰기·내부 복원 시 이전 상태와 다른 행만 저장 |
| 수동 백업·복원 | 이전 계획·점검 결과에서 현재 기능처럼 참조 | 사용자 UI/API와 전용 서비스는 제거. 기존 파일·DB 필드·내부 `Store.restore()`와 migration 안전 사본은 유지 |
| 전체 자료 200 MiB | 선언값을 실제 강제 제한으로 안내 | `storeBytes` 선언·비교 테스트만 남고 현재 저장 경로에서 읽지 않음. 실행 한도 목록과 구분 |
| 가져오기 원본 | STAGED 원본만 SQLite에 남는다고 설명 | [반영 서비스](../backend/src/services/import-commit.ts)는 APPLIED 배치에도 rawRows를 저장. STAGED 원본도 보관하며 미반영 Preview 자체는 프로세스 메모리 |
| 과거 이력 정원 | 첫 등록 학생 수로 정원을 설정한다고만 설명 | 파일의 개설강좌 정원을 먼저 적용. 해당 강좌 행을 생략한 새 강좌에만 첫 등록 학생 수를 적용 |
| 안내와 경고 | 새 학기·강좌 기본값을 모두 안내로 설명 | Excel은 새 항목을 INFO로 표시, 직접·일괄 이력 검토는 WARNING을 유지. 메모는 둘 다 선택 사항 |
| 경고 무시 | 오류는 유지하지만 충돌·확정 검토 설명은 부족 | [경고 확인 창](../frontend/warning-dialog.js)의 표시·확인만 생략. 서버 검증·digest·[충돌 선택](../frontend/imports-page.js)과 배정 확정 검토는 유지 |
| 의존성·배포 문서 | Playwright 누락, 동봉 문서와 과거 OS 검증 범위가 불명확 | 실제 의존성과 명시적 패키징 목록을 대조. 과거 검증은 현재 지원 결과로 재사용하지 않음 |

## 구현이 이미 문서와 일치한 주요 규칙

- 신청은 학기·회원당 한 행, 희망은 최대 5개이며 기본 양식은 1~3순위다. 빈 순위는 건너뛰고 기존 여러 행 양식은 거절한다.
- 신청 현황은 조회된 신청 학기의 순서와 전체 개설강좌·정원을 보존한다. 이력 현황은 조회된 이력의 개설강좌 정원과 학생별 메모를 보존한다. 검색·정렬은 전체 결과에 적용하며 현황은 현재 페이지로 제한하지 않는다.
- 기존 이력과 메모는 Excel 재등록으로 덮어쓰지 않는다. 정원 충돌은 유지 또는 파일 값 적용을 명시적으로 선택한다. 이후 이력 추가·수정·삭제는 기존 정원을 자동 변경하지 않는다.
- 수동 초안은 정책을 적용하지 않으며 신청 없이 이름으로 회원을 추가할 수 있다. 같은 학기 이력이 있는 회원·중복 초안 회원·다른 학기의 강좌는 거절한다.
- 초안 확정은 이력과 독립 영수증을 저장하고 초안·항목을 삭제한다. 신청·초안 삭제는 이력을 삭제하지 않는다. 동일 확정 요청의 재시도는 영수증을 먼저 조회한다.
- 홈의 완료는 현재 학기 신청·배정 흐름과 전용 현황 다운로드 기록을 기준으로 한다. 일반 현황 다운로드는 완료를 기록하지 않으며 다른 학기 변경도 재다운로드 안내를 만들 수 있다.

## 검증 결과

검증은 macOS arm64, npm scripts의 Node `22.23.3`, 임시 합성 자료로 수행했다. 시스템 Node `20.11.1` 환경에서도 프로젝트 Node로 실행됨을 확인했다. 최초 샌드박스 실행의 HTTP 테스트 18개는 `listen EPERM`으로 실패했으며 로컬 시험 서버 실행 권한을 적용한 재실행 결과를 아래에 기록한다.

| 검증 | 결과 |
| --- | --- |
| `npm run verify` | 통과: manifest·OpenAPI·백엔드/프런트 타입 검사, 기능·계약 233개, 강제 종료 복구 2개, 실행기 4개. Windows 전용 실행기 1개는 이 환경에서 제외 |
| `npm run docs:html` | 통과: Markdown 원본에서 오프라인 사용 설명서·문제 해결 HTML 생성 |
| `npm run test:openapi` | 통과: 개정한 API 설명과 기존 계약 문법 확인 |
| `npm run test:browser` | 통과: Chromium 사용자 흐름 33개. 초기에는 브라우저 실행 파일이 없어 시작하지 못했으며 임시 경로에 headless shell을 설치한 뒤 재실행 |
| 문서 링크·오프라인 HTML | 통과: Markdown 13개(기존 12개와 이 기록)의 로컬 참조와 두 HTML의 문서 이동·본문 anchor를 확인. HTML에 외부 스크립트 없음 |
| `git diff --check` | 통과: 개정 파일의 공백·패치 형식 확인 |

실제 사용자 PC의 Windows GUI·Finder/Gatekeeper·Linux 데스크톱, 새 배포 압축본과 공개 Release, 성능·커버리지를 이번 문서 작업에서 재측정하지 않았다. 과거 측정값은 원래 날짜의 기록으로 보존했다.

## 남은 구현 범위

- `Store.read()` 운영 호출 5곳과 `frontend/app.js`의 타입 검사 제외는 아직 남아 있다. 계획의 완료로 표시하지 않았다.
- `x-operational-limits.storeBytes`는 현재 강제되지 않는 선언이다. 필요하면 별도 구현과 실제 초과 입력 시험이 필요하다.
- 수동 백업·복원 제거와 기존 DB 필드 보존을 구분한다. 자동 사본은 DB 형식 변경 전이며 일반 저장의 자동 백업을 보장하지 않는다.
- 문서 개정은 현재 소스 기준이다. 고객 배포에서는 해당 Release 태그의 문서와 각 OS의 검증 결과를 함께 제공한다.
