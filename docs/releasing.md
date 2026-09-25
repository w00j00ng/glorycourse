# 배포 관리자 안내

고객의 다운로드·실행·종료·업데이트 절차는 [README](../README.md), 업무 화면 사용법은 [사용 설명서](usage.md)에 있다. 이 문서는 배포 파일을 만들고 GitHub Release로 제공하는 담당자를 위한 절차다.

## 현재 검증 범위

Windows용 ZIP은 로컬에서 생성하고 별도 임시 폴더에 추출해 검증한다. 기존에 기록된 2026-09-25 [Portable release 실행](https://github.com/w00j00ng/glorycourse/actions/runs/36091456318)은 Windows 2022 x64, macOS 15 arm64, Ubuntu 24.04 x64 패키지 검증 결과다. 이 과거 결과가 새 커밋의 검증을 대신하지 않는다. 실제 GUI 첫 실행은 별도 검증 대상이다. 특히 Mac은 서명·공증 없는 시험 배포이며 일반 고객용 정식 지원으로 전환하기 전에 Finder/Gatekeeper 검증이 필요하다.

## 배포 전 로컬 확인

```sh
npm ci
npm run verify
npm run package
npm run test:package
```

`scripts/release-config.json`이 동봉 Node 버전, OS/아키텍처, 공식 배포 파일 SHA-256 및 최종 파일명을 정한다. Node를 올릴 때 [공식 배포 검증 안내](https://github.com/nodejs/node#verifying-binaries)에 따라 검증값을 갱신하고 세 OS를 다시 확인한다. 패키징은 해당 OS/아키텍처에서 수행한다.

`dist`에 최종 압축 파일과 `.sha256`이 생긴다. 패키지는 `backend/src`, `frontend`, `schema/migrations` 전체 이력과 manifest, 저장 스키마, 실행기, production 의존성, Node 및 라이선스를 포함한다. 개발자의 자료 폴더와 작업 문서는 포함하지 않는다. `release.json`에는 목표 DB 버전과 migration manifest의 SHA-256을 기록한다. `MANIFEST.json`에는 파일별 SHA-256, 앱/Node 버전, 커밋과 수정 여부가 있다. 수정 중인 로컬 빌드는 `dirty: true`로 표시하며 고객 Release에는 사용하지 않는다.

압축본 검증은 개발 폴더 밖의 한글·공백 경로에 추출하고 시스템 Node 검색 경로를 제거한 상태에서 실제 Windows/Linux 실행 파일을 호출한다. Mac CI는 앱 안의 동봉 Node와 실행기를 검증하며 Finder 실행은 별도 수동 검사다. 신청 등록, xlsx 생성/가져오기 미리보기, 백업/복원, 중복 실행, 종료, 재시작 후 자료 보존을 확인한다.

## GitHub에서 준비하기

1. 배포할 변경과 사용 설명서를 검토·커밋·push한다. `package.json`과 lockfile의 버전을 맞추고 공개할 커밋을 확정한다.
2. Actions의 **Portable release**를 수동 실행하면 세 OS 빌드와 검증만 수행한다. 테스트용 artifact는 workflow 실행 화면에서 내려받는다.
3. 공개할 커밋에 버전과 같은 `v0.1.0` 형식의 태그를 만들어 push한다. 세 OS 검증이 전부 통과하면 **초안 Release**와 압축 파일 3개, `SHA256SUMS`를 만든다. 태그와 버전이 다르면 실패한다.
4. 해당 초안의 파일을 일반 사용자 환경으로 내려받아 아래 점검표를 수행한다. Windows 11, macOS 15 Apple Silicon, Ubuntu 24.04 GNOME에서 각기 확인한다. macOS 서명·공증과 조직 정책은 별도 조건이다.
5. 검증 상태와 변경 내용을 Release 본문에 기록하고 관리자가 **Publish release**를 누른다. 정식 버전만 latest로 지정한다. 미검증 버전은 초안 또는 사전 배포 상태로 유지한다.

자동화는 공개된 Release를 덮어쓰지 않는다. 같은 태그를 재실행할 때는 아직 초안인 경우에만 파일을 교체한다. 배포 권한은 초안 생성 job에만 부여한다. 개인 토큰을 소스에 넣지 않고 GitHub의 기본 `GITHUB_TOKEN`을 사용한다.

태그를 만들거나 소스 코드를 push하는 것만으로 고객용 배포가 완료되지는 않는다. 압축 파일이 붙은 Release를 공개해야 한다. 이미 공개한 버전을 수정하려면 새 버전과 새 태그로 배포한다.

[공식 runner 목록](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)에 맞춰 Windows 2022 x64, macOS 15 arm64, Ubuntu 24.04 x64 runner를 사용한다. Windows 서버 runner 통과는 고객용 Windows 11 GUI 검증을 대신하지 않는다.

## 공개 전 사용자 관점 점검

시험용 자료 폴더와 가상 회원명을 사용한다. 기존 고객의 실제 자료로 삭제·복원 시험을 하지 않는다.

- [ ] README의 OS별 다운로드 파일명과 실제 Release 자산이 일치한다.
- [ ] 개발 도구 없는 PC에서 압축 해제 후 시작·중복 시작·종료·재시작이 된다. 읽기 전용 배포 폴더에서도 사용자 자료 폴더를 사용한다.
- [ ] 실제 데스크톱에서 브라우저와 자료 폴더가 열리며, 보안 경고와 대응 안내가 해당 OS에서 맞는다.
- [ ] 로그인한 데스크톱에서 `npm run test:desktop`으로 실제 기본 브라우저의 페이지 요청을 확인한다. OS 열기 명령의 종료 코드만으로 브라우저 열기 성공을 판단하지 않는다.
- [ ] 빈 자료에서 홈 안내를 따라 학기 추가 → 여러 강좌 입력 또는 이전 학기 복사 → 신청 양식 작성·업로드 → 배정초안 검토·확정을 완료한다.
- [ ] 신청 없이 과거 수강이력을 등록·수정할 수 있고, 신청·초안 삭제 후에도 이력이 남는다.
- [ ] 현재 학기 현황 다운로드 후 홈에 완료가 표시된다. 일반 현황 다운로드와의 차이, 자료 변경 뒤 재다운로드 안내가 사용 설명서와 맞는다.
- [ ] 수동 백업·중복 백업 방지·백업 복원과 복원 전 안전 사본을 확인한다.
- [ ] 이전 배포본의 시험 DB를 새 버전으로 열어 자료 유지·미적용 migration·재시작을 확인한다. 더 새로운 DB를 구버전 프로그램으로 여는 경우 안전하게 거절한다.
- [ ] 한글 파일명과 시각이 포함된 신청·이력 양식 및 현황 파일을 실제로 열어 내용을 확인한다.
- [ ] 결과에 OS·앱 버전·커밋·검증 날짜를 기록하고, 미검증 항목을 Release 본문에 명시한다.

## 고객에게 전달하기

정식 Release를 공개한 뒤 [저장소 README](https://github.com/w00j00ng/glorycourse)를 제공한다. README의 고정 다운로드 주소는 [GitHub latest asset 링크 규칙](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases)을 따른다. 초안/사전 배포만 있는 동안에는 latest 다운로드 링크가 동작하지 않을 수 있다.

공개 후 로그아웃한 브라우저에서 README의 다운로드 링크 3개와 사용 설명서 링크를 확인한다. `Not Found`이면 정식 공개 여부, latest 지정과 자산 파일명을 확인한다. 고객에게 Actions artifact나 Source code 압축 파일을 실행 파일로 안내하지 않는다.

Release 본문에는 주요 변경, 지원·시험 대상 OS, DB 형식 변경 여부와 백업 후 업데이트 순서를 적는다. README와 `docs/usage.md`는 현재 소스 설명이므로 배포 전 기능이 함께 보일 수 있다. 해당 Release 태그의 문서 링크도 제공하면 고객이 설치한 버전에 맞는 안내를 읽을 수 있다.

자동 업데이트는 제공하지 않는다. 고객은 백업 → 종료 → 새 폴더에 압축 해제 → 실행 → 자료 확인 순서로 갱신한다. 이전 개발용 `.data`는 백업/복원으로 옮기며 원본을 자동 삭제하지 않는다. 자료 형식이 변경되는 배포에서는 먼저 마이그레이션과 구버전 거절을 검증한다.

새 버전에서 DB 형식이 바뀐 뒤에는 이전 실행 파일만 다시 사용하는 것으로 되돌릴 수 없다. 이전 버전을 사용해야 한다면 그 버전과 호환되는 업데이트 전 백업으로 복원하는 절차가 필요하며, 업데이트 후 변경 자료는 별도로 확인해야 한다. 고객 안내에는 `backups`와 `update-backups` 위치를 함께 전달한다.

## 문서 유지

- 화면 용어·버튼·업무 순서: [사용 설명서](usage.md)와 README의 빠른 안내를 갱신한다.
- 개발 명령·DB 관리·검증: [개발 환경](development.md)과 실제 npm scripts를 맞춘다.
- API·저장·완료 조건: [계약 결정 기록](contract-decisions.md), OpenAPI, schema를 확인한다.
- 런타임·패키지: [직접 의존성](dependencies.md), lockfile, release config와 동봉 라이선스를 확인한다.
- 커버리지 수치는 문서에 직접 기록하지 않는다. 기본 브랜치 CI가 배포하는 GitHub Pages 배지와 보고서 링크를 유지한다.
