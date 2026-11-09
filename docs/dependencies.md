# 직접 의존성

일반 사용자는 패키지를 직접 설치하지 않고 [배포본](../README.md#다운로드)을 사용한다. 이 문서는 개발·배포 담당자를 위한 목록이다.

모든 npm 의존성은 공개 레지스트리에서 설치하며 직접 의존성의 버전 조건은 [package.json](../package.json), 실제 설치 버전과 무결성 값은 [package-lock.json](../package-lock.json)에 기록한다. `npm ci`는 lockfile의 버전을 재현한다. 비공개 저장소의 코드·패키지·생성물은 사용하지 않는다.

## 실행 의존성

| 패키지 | 용도 | 라이선스 | 공개 출처 |
|---|---|---|---|
| `@excel.js/exceljs` 0.15.0 | XLSX 생성·파싱 | MIT | <https://github.com/excel-js/exceljs> |
| `@excel.js/jszip` 0.2.0 | XLSX 압축 항목 크기·외부 링크 사전 검사 | MIT | <https://github.com/excel-js/excel-js/tree/main/packages/jszip> |
| `ajv` 8.20.0 | 실행 중 저장 자료의 JSON Schema 검증 | MIT | <https://github.com/ajv-validator/ajv> |
| `ajv-formats` 3.0.1 | 저장 자료의 날짜 등 format 검증 | MIT | <https://github.com/ajv-validator/ajv-formats> |
| `immer` 11.1.18 | 저장 명령에서 변경된 경로만 복사 | MIT | <https://github.com/immerjs/immer> |

저장은 Node.js 내장 `node:sqlite`를 사용하며 별도 SQLite 패키지를 설치하지 않는다. 기준 런타임 Node.js 22.14의 해당 API는 experimental 상태다. [공식 API 문서](https://nodejs.org/download/release/v22.14.0/docs/api/sqlite.html)를 기준으로 사용한다.

배포본의 Node.js는 [release-config.json](../scripts/release-config.json)에 고정한 22.23.3을 사용한다. 공식 바이너리의 SHA-256을 확인하고 Node LICENSE와 production 의존성의 원래 라이선스 파일을 동봉한다. `ajv`, `ajv-formats`, `immer`는 개발 도구 없이도 필요한 실행 의존성이다. JSON Schema는 저장 전 구조 검증용이며 SQLite에 업무 자료를 JSON으로 보관한다는 의미가 아니다.

## 개발 의존성

| 패키지 | 용도 |
| --- | --- |
| `@redocly/cli` 2.54.2 | OpenAPI 계약 lint |
| `@types/node` 22.20.4 | Node.js API 타입 |
| `@playwright/test` ^1.63.0 (lockfile 1.63.0) | 실제 Chromium 사용자 흐름 검증 (Apache-2.0, <https://github.com/microsoft/playwright>) |
| `typescript` 5.9.2 | `tsc --noEmit` 타입 검사 |
| `yaml` 2.9.1 | 계약 테스트의 YAML 읽기 |
| `c8` 12.0.0 | 테스트 커버리지와 HTML·LCOV 보고서 |
| `marked` 16.0.0 | 배포용 오프라인 HTML 설명서 생성 (MIT) |
| `node` 22.23.3 | npm 명령에서 사용할 프로젝트 전용 Node.js 런타임 (MIT, <https://github.com/aredridel/node-bin-gen>) |

테스트 실행에는 Node.js 내장 test runner를 사용한다. 프런트엔드는 별도 프레임워크나 빌드 의존성이 없다. `marked`는 배포 파일을 만들 때만 사용하며, 생성된 HTML은 외부 스크립트 없이 열린다. 개발 의존성은 고객용 production 설치 대상에 포함하지 않는다.

## 의존성을 변경할 때

1. `package.json`과 `package-lock.json`을 함께 갱신하고 위 목록·라이선스를 확인한다.
2. `npm ci`로 고정 버전 설치를 재현하고 `npm audit` 결과를 검토한다. 과거의 취약점 0건 결과를 현재 상태로 재사용하지 않는다.
3. `npm run verify`를 통과시키고 실행 의존성·Node 변경 시 각 배포 OS에서 `npm run package`와 `npm run test:package`를 확인한다.
4. 배포본에 포함되는 전이 의존성의 라이선스도 확인한다. 상세 게시 절차는 [배포 관리자 안내](releasing.md)를 따른다.

## 정기 보안 검사와 공통 Task

공개 [w00j00ng/tasks](https://github.com/w00j00ng/tasks)를 `tasks` Git 서브모듈로
포함하고 루트 `Taskfile.yml`에서 호출한다. 제품 실행·배포 의존성에는 포함하지 않는다.
공통 코드는 소비 저장소가 기록한 커밋으로 고정하며 자동으로 최신 커밋을 따라가지 않는다.

```sh
git submodule update --init --recursive
go install github.com/go-task/task/v3/cmd/task@v3.54.0
task security:test
task --exit-code security:npm
```

Task v3.54.0, jq 및 POSIX 명령 도구가 필요하며 실제 GitHub 보고에는 `gh`도 필요하다.
기존 Node 22.23.3과 루트 lockfile을 사용하고 개발 의존성을 포함한다.
high·critical 취약점에서 CI가 실패하며 일반 레지스트리·네트워크 오류는 취약점 알림으로
취급하지 않는다. 검사·테스트 과정에서 패키지를 설치하거나 자동 수정하지 않는다.

기존 매주 월요일 00:17 UTC(09:17 KST) 일정을 유지한다. PR·push·수동 실행도 검사하지만,
이슈 생성·갱신은 `main` 정기 검사에서 확인된 취약점만 대상으로 한다. 열린 자동 보안 이슈를
재사용하고, 닫힌 이슈만 있으면 새 이슈를 만든다. 본문은 최신 결과로 갱신하며 이슈마다
검사 날짜(KST)별로 `@w00j00ng` 멘션 댓글을 1회 남긴다. 정상 검사로 자동 종료하지 않으므로
조치 후 이슈를 닫는다. 이슈 본문의 `<!-- dependency-security-issue:v1 -->` 마커는 유지한다.

이메일은 GitHub의 참여·멘션·댓글 이메일 설정을 따른다. Actions 실행 이메일은 꺼둘 수 있다.
보고 job에만 `issues: write`와 `actions: read`를 부여하고 내장 `GITHUB_TOKEN`을 사용한다.
정기 검사는 default branch에 병합한 후 적용되며 실제 메일 수신은 별도 확인이 필요하다.

CI의 checkout은 `submodules: true`를 사용한다. 새 복제는
`git clone --recurse-submodules https://github.com/w00j00ng/glorycourse.git`로 수행하거나
복제 후 위 초기화 명령을 실행한다. 공통 변경을 적용할 때는 검증한 서브모듈 커밋으로
포인터를 갱신하고 함께 검증한다.
