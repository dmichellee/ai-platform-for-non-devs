# Kiro 설정 번들 — Windows 판 (배포 표준 자동 준수)

이 번들을 **프로젝트 루트에 그대로 넣고 훅을 한 번 설치하면**, Kiro가 코드를 만들 때 사내
배포 플랫폼(AppHub)의 배포 표준을 자동으로 지키도록 돕고, 커밋할 때 표준 위반을 미리 걸러준다.

> macOS/Linux 사용자는 **`kiro-config-mac.zip`** 을 받으세요. (설치기가 `sh` 판으로 다릅니다.)

## 먼저 준비물
- **Git for Windows** 가 설치돼 있어야 한다 (https://git-scm.com). 커밋 검사 훅은 여기에 번들된
  `sh` 로 실행되므로, Git for Windows만 있으면 훅은 그대로 동작한다.
- 설치는 **PowerShell** 로 한다(윈도우 기본 탑재). 별도 설치 필요 없음.

## 넣는 법 (비개발자용 안내)
1. 플랫폼 웹 화면의 **"Kiro 설정 다운로드(Windows)"** 버튼으로 zip을 받는다.
2. 압축을 풀면 나오는 파일들을 **여러분의 앱 프로젝트 최상위 폴더**에 넣는다
   (`.kiro\` 폴더 + `hooks\` 폴더 + `install-hooks.ps1`).
3. 프로젝트 폴더에서 **PowerShell** 을 열고(폴더에서 `Shift + 우클릭 → "여기에 PowerShell 창 열기"`)
   한 번만 실행한다:
   ```powershell
   powershell -ExecutionPolicy Bypass -File install-hooks.ps1
   ```
   - `-ExecutionPolicy Bypass` 는 이 한 번의 실행에만 적용되며 시스템 정책을 바꾸지 않는다(안전).
   - 이게 커밋 검사 훅을 여러분의 저장소에 설치한다(한 번이면 됨).
   - Kiro에게 "배포 표준 훅 설치해줘"라고 요청하면 Kiro가 대신 실행해줄 수도 있다.
4. 끝. 이제 Kiro가 배포 가능한 형태로 코드를 만들고, 커밋할 때 표준 위반을 미리 잡아준다.
5. 배포가 실패하면, 플랫폼 화면에 나온 안내 문구를 그대로 Kiro에게 전달하면 된다.

## 들어있는 파일 (3개)
```
.kiro\
└── steering\
    └── deployment-standard.md   # 항상 적용되는 배포 표준 지침 (inclusion: always)
hooks\
└── pre-commit                   # 커밋 직전에 도는 배포 표준 검사 스크립트 (POSIX sh)
install-hooks.ps1                # pre-commit 을 .git\hooks\ 에 설치하는 스크립트 (1회 실행)
```

- **`deployment-standard.md`** — Kiro가 코드를 생성·수정할 때 항상 참조하는 규칙
  (8080 포트 하나만, `GET /health`, Dockerfile 표준, 무상태, 시크릿=환경변수, stdout 로그).
- **`hooks\pre-commit`** — git 커밋 직전에 자동 실행되는 검사(아래 "무엇을 검사하나" 참고).
  **이 파일은 sh 스크립트이며 mac 판과 동일하다** — Git for Windows의 sh가 실행한다.
- **`install-hooks.ps1`** — `hooks\pre-commit`을 `.git\hooks\pre-commit`으로 복사한다. 멱등: 이미
  같으면 통과, 다른 훅이 있으면 물어본 뒤 백업(`.bak`) 후 교체(`-Force` 로 확인 생략),
  git 저장소가 아니면 안내. 훅은 바이트 그대로 복사돼 줄바꿈(LF)이 보존된다.

## PC 처음 설정 (코드 저장소 로그인) — 해당 회사만
zip 안에 **`apphub-aws.conf` 와 `setup-aws-git.ps1`** 이 들어 있다면, 이 회사는 코드 저장소(AWS CodeCommit)에
**회사 AWS 로그인**으로 접속한다. 이 설정은 **저장소마다가 아니라 PC당 한 번**이며, 처음 `git clone` 하기 전에 한다.
(두 파일이 없으면 이 절은 건너뛴다.)

1. **AWS CLI 버전 2 설치** — https://docs.aws.amazon.com/ko_kr/cli/latest/userguide/getting-started-install.html
   에서 Windows 용 `AWSCLIV2.msi` 를 받아 설치한다(회사 PC는 관리자 권한이 필요할 수 있다).
   설치 후 **PowerShell 창을 새로 열고** `aws --version` 이 `aws-cli/2.` 로 시작하는지 확인한다.
2. zip 을 푼 폴더에서 PowerShell 로 한 번 실행한다:
   ```powershell
   powershell -ExecutionPolicy Bypass -File setup-aws-git.ps1
   ```
   - `%USERPROFILE%\.aws\config` 에 `apphub` 로그인 설정을 추가하고, git 이 **CodeCommit 주소에서만** AWS 로그인을
     쓰게 한다(이 주소에서만 Windows 기본 로그인 도우미를 끈다. GitHub 등 다른 git 설정은 그대로).
   - 몇 번 실행해도 안전하다. 이미 다른 값의 `apphub` 설정이 있으면 덮어쓰지 않고 멈추며,
     바꾸려면 끝에 `-Force` 를 붙인다(원본은 `config.bak.시각` 으로 백업).
   - 되돌리려면 끝에 `-Uninstall` 을 붙여 실행한다(이 스크립트가 넣은 설정만 지운다).
3. 브라우저가 열리면 **회사 AWS 계정**(관리자가 알려준 이메일)으로 로그인하고 '허용'을 누른다.
   확인: `aws sts get-caller-identity --profile apphub`
4. 로그인은 **보통 하루에 한 번** 만료된다. push/clone 이 `403` 이나 `Unable to locate credentials` 로
   실패하면 `aws sso login --profile apphub` 를 실행한 뒤 다시 시도한다(Kiro에게 "AWS 로그인해줘"라고 해도 된다).
   다시 로그인해도 403 이면 관리자에게 "회사 AWS 로그인 계정·그룹·이메일이 AppHub 계정과 같은지" 확인을 요청한다.
- 저장소 주소는 플랫폼 화면의 **HTTPS 주소**(`https://git-codecommit.…/v1/repos/…`)를 쓴다.
- 예전에 이 주소의 아이디·비밀번호(Git 자격 증명)를 Windows 자격 증명 관리자에 저장한 적이 있어도, 이 설정 뒤에는
  그 값 대신 회사 AWS 로그인이 쓰인다.

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

## 문제가 생기면 (Windows 특화)
- **"install-hooks.ps1 을(를) 로드할 수 없습니다" / 실행 정책 오류** → 위 3번의
  `-ExecutionPolicy Bypass` 를 반드시 붙여서 실행하세요.
- **커밋할 때 훅이 안 도는 것 같아요** → Git for Windows가 설치돼 있는지 확인하세요.
  훅은 Git Bash의 sh로 실행됩니다.
- **다른 pre-commit 훅이 이미 있다고 나와요** → 물어보면 `y` 를 눌러 교체하거나, 자동화라면
  `-Force` 를 붙여 다시 실행하세요(기존 훅은 `.bak` 으로 백업됩니다).

## 훅은 보조 수단, 최종 강제는 플랫폼 (개발자/관리자용)
- 이 pre-commit 훅은 **미리 걸러주는 보조 수단**이다. **최종 강제는 플랫폼의 배포 전 검증**
  (Dockerfile 정적 검증 + 이미지 실행 스모크)이 담당한다. Kiro/훅을 안 쓴 레포도 플랫폼에서
  같은 기준으로 걸러진다(신뢰 경계 = 플랫폼 검증, KIRO-STANDARDS 3장).
- pre-commit의 EXPOSE·금지 항목 검사는 플랫폼 정적 검증기(`backend/app/validator/dockerfile.py`)와
  **동일한 규칙**을 따른다(8080 하나만, 금지 항목 패턴 동일).
- 훅은 의존성 없이 **POSIX sh + grep + git**만 사용한다. Windows에서는 Git for Windows에 번들된
  sh가 mac 판과 **동일한 훅**을 실행하므로 검사 결과가 같다.
- 급히 훅을 건너뛰어야 하면 `git commit --no-verify`로 우회할 수 있으나 권장하지 않는다
  (어차피 플랫폼 배포 전 검증에서 같은 항목이 걸린다).

## 이 번들은 어떻게 서빙되는가 (계약)
`_workspace/contracts/api-contract.md`의 "Kiro 설정 다운로드" 계약 참조.
zip은 `scripts/build-kiro-bundle.sh`로 생성하며, 플랫폼 자산 버킷의 고정 키
`s3://{assets}/kiro-config/kiro-config-windows.zip`에 업로드된다.
(macOS/Linux 판은 `.../kiro-config-mac.zip`.)
