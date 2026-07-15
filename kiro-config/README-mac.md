# Kiro 설정 번들 — macOS / Linux 판 (배포 표준 자동 준수)

이 번들을 **프로젝트 루트에 그대로 넣고 훅을 한 번 설치하면**, Kiro가 코드를 만들 때 사내
배포 플랫폼(AppHub)의 배포 표준을 자동으로 지키도록 돕고, 커밋할 때 표준 위반을 미리 걸러준다.

> Windows 사용자는 **`kiro-config-windows.zip`** 을 받으세요. (설치기가 PowerShell 판으로 다릅니다.)

## 넣는 법 (비개발자용 안내)
1. 플랫폼 웹 화면의 **"Kiro 설정 다운로드(Mac)"** 버튼으로 zip을 받는다.
2. 압축을 풀면 나오는 파일들을 **여러분의 앱 프로젝트 최상위 폴더**에 넣는다
   (`.kiro/` 폴더 + `hooks/` 폴더 + `install-hooks.sh`).
3. 터미널에서 프로젝트 폴더로 이동해 한 번만 실행한다: `sh install-hooks.sh`
   - 이게 커밋 검사 훅을 여러분의 저장소에 설치한다(한 번이면 됨).
   - Kiro에게 "배포 표준 훅 설치해줘"라고 요청하면 Kiro가 대신 실행해줄 수도 있다.
4. 끝. 이제 Kiro가 배포 가능한 형태로 코드를 만들고, 커밋할 때 표준 위반을 미리 잡아준다.
5. 배포가 실패하면, 플랫폼 화면에 나온 안내 문구를 그대로 Kiro에게 전달하면 된다.

## 들어있는 파일 (3개)
```
.kiro/
└── steering/
    └── deployment-standard.md   # 항상 적용되는 배포 표준 지침 (inclusion: always)
hooks/
└── pre-commit                   # 커밋 직전에 도는 배포 표준 검사 스크립트 (POSIX sh)
install-hooks.sh                 # pre-commit 을 .git/hooks/ 에 설치하는 스크립트 (1회 실행)
```

- **`deployment-standard.md`** — Kiro가 코드를 생성·수정할 때 항상 참조하는 규칙
  (8080 포트 하나만, `GET /health`, Dockerfile 표준, 무상태, 시크릿=환경변수, stdout 로그).
- **`hooks/pre-commit`** — git 커밋 직전에 자동 실행되는 검사(아래 "무엇을 검사하나" 참고).
- **`install-hooks.sh`** — `hooks/pre-commit`을 `.git/hooks/pre-commit`으로 복사하고 실행 권한을
  준다. 멱등: 이미 같으면 통과, 다른 훅이 있으면 물어본 뒤 백업(`.bak`) 후 교체(`--force` 로 확인
  생략), git 저장소가 아니면 안내.

## pre-commit 훅은 무엇을 검사하나 (결정적으로 판정 가능한 것만)
커밋할 때 아래를 검사하고, 걸리면 **한국어로 사유를 안내하며 커밋을 멈춘다**:
1. 레포 루트에 **Dockerfile 존재**.
2. Dockerfile의 **EXPOSE는 8080 하나만** (없음/다른 포트/8080+다른포트 → 실패, `8080/tcp` 표기 허용).
3. **금지 항목**: `--privileged`, `/var/run/docker.sock`, `--network host`, `--cap-add`,
   호스트 경로 바인드 마운트 (플랫폼 검증기와 동일 기준).
4. **고신뢰 시크릿 패턴 2종**: AWS Access Key(`AKIA…`), PEM 개인키 헤더
   (`-----BEGIN … PRIVATE KEY-----`). 이번 커밋에 포함되는 텍스트 파일만 검사한다(바이너리 제외).

> non-root 실행·`/health`·무상태·stdout 로그는 스크립트로 확실히 판정하기 어려워
> pre-commit에서 제외했다(권장 사항이며 `deployment-standard.md`가 안내한다).
> **이들과 헬스체크 실동작의 최종 강제는 플랫폼의 배포 전 검증이 담당한다.**

## 훅은 보조 수단, 최종 강제는 플랫폼 (개발자/관리자용)
- 이 pre-commit 훅은 **미리 걸러주는 보조 수단**이다. **최종 강제는 플랫폼의 배포 전 검증**
  (Dockerfile 정적 검증 + 이미지 실행 스모크)이 담당한다. Kiro/훅을 안 쓴 레포도 플랫폼에서
  같은 기준으로 걸러진다(신뢰 경계 = 플랫폼 검증, KIRO-STANDARDS 3장).
- pre-commit의 EXPOSE·금지 항목 검사는 플랫폼 정적 검증기(`backend/app/validator/dockerfile.py`)와
  **동일한 규칙**을 따른다(8080 하나만, 금지 항목 패턴 동일).
- 훅은 의존성 없이 **POSIX sh + grep + git**만 사용한다. mac/linux 어디서든 동작한다.
  (Windows에서는 Git for Windows에 번들된 sh가 동일한 훅을 실행한다 — `kiro-config-windows.zip` 참고.)
- 급히 훅을 건너뛰어야 하면 `git commit --no-verify`로 우회할 수 있으나 권장하지 않는다
  (어차피 플랫폼 배포 전 검증에서 같은 항목이 걸린다).

## 이 번들은 어떻게 서빙되는가 (계약)
`_workspace/contracts/api-contract.md`의 "Kiro 설정 다운로드" 계약 참조.
zip은 `scripts/build-kiro-bundle.sh`로 생성하며, 플랫폼 자산 버킷의 고정 키
`s3://{assets}/kiro-config/kiro-config-mac.zip`에 업로드된다.
(Windows 판은 `.../kiro-config-windows.zip`.)
