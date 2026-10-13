---
inclusion: always
---
# 배포 표준 (사내 앱 배포 플랫폼용)

이 프로젝트는 사내 배포 플랫폼(AppHub)으로 서비스된다.
코드를 생성하거나 수정할 때 아래를 **반드시** 지킨다. 이 지침은 모든 코드 생성에 항상 적용된다.

## 1. 포트
- 웹 서버는 반드시 **8080 포트**에서 리슨한다.
- 포트는 환경변수 `PORT`를 읽고, 없으면 기본값 8080을 쓴다.
  - Node: `const PORT = Number(process.env.PORT ?? 8080)`
  - Python: `port = int(os.environ.get("PORT", "8080"))`
- Dockerfile의 `EXPOSE`는 **8080 하나만** 둔다. 다른 포트를 EXPOSE하지 않는다
  (플랫폼은 8080만 라우팅한다). `8080/tcp` 프로토콜 표기는 허용된다.

## 2. 헬스체크
- `GET /health` 엔드포인트를 만들고 **200**을 반환한다. 본문은 자유(`{"status":"ok"}` 등).
- `/health`에는 **인증을 걸지 않는다**(플랫폼이 로그인 없이 상태를 확인한다).
- 앱은 **기동 60초 이내**에 `/health`가 200을 줄 수 있어야 한다.

## 3. Dockerfile (레포 루트)
- 레포 루트에 `Dockerfile`을 유지한다.
- `EXPOSE 8080` **하나만** 둔다(다른 포트 EXPOSE 금지).
- **non-root 사용자**로 실행한다(`USER` 지시자, 예: `USER node`).
- 특권 실행(`--privileged`), 호스트 도커 소켓(`/var/run/docker.sock`), 호스트 네트워크
  (`--network host`), 추가 커널 권한(`--cap-add`), 호스트 경로 바인드 마운트는 **금지**한다.

## 4. 무상태
- 로컬 파일시스템에 데이터를 **영속 저장하지 않는다**(재시작·스케일 시 소실됨).
- 데이터가 필요하면 외부 저장소(DB/오브젝트 스토리지) 연동을 사용자에게 제안한다.

## 5. 설정과 시크릿
- API 키·비밀번호 등을 **코드에 하드코딩하지 않는다**. 반드시 환경변수로 읽는다
  (`process.env.X` / `os.environ["X"]`).
- 필요한 환경변수 목록을 `README`에 기록한다(플랫폼 웹 화면에서 입력하게 된다).
- 시크릿(비밀값)과 일반 설정을 구분해 문서화한다.

## 6. 로그
- 로그는 표준 출력(`console.log` / `print`)으로만 남긴다.
- 파일 로그를 만들지 않는다(플랫폼이 파일 로그를 수집하지 못한다).

## 7. git 커밋 훅 설치 (pre-commit)
이 번들에는 커밋 직전에 배포 표준을 자동 점검하는 **git pre-commit 훅**이 들어 있다
(`hooks/pre-commit`). 코드를 만들거나 수정할 때 다음을 확인하고, 필요하면 대신 설치한다.

**사용자가 "커밋 검사 설치해줘" / "배포 표준 훅 설치해줘" / "pre-commit 설치해줘"라고 요청하면**,
아래 설치를 대신 수행한다(이 표현들은 모두 이 훅 설치 요청이다).

- 설치가 필요한 조건: 이 프로젝트에 `.git/hooks/pre-commit`이 **없거나** 번들의
  `hooks/pre-commit`과 **다르면** 설치한다.
- 설치 방법 — **사용자 OS에 맞는 설치기**를 프로젝트 루트에서 실행한다(번들에 둘 다 들어 있다):
  - macOS / Linux: `sh install-hooks.sh`
  - Windows: `powershell -ExecutionPolicy Bypass -File install-hooks.ps1`
  - (스크립트를 못 쓰는 상황이면 대안: `hooks/pre-commit`을 `.git/hooks/pre-commit`으로 복사하고
    macOS/Linux에서는 `chmod +x`를 준다.)
- 두 설치기는 **멱등**하다: 이미 같은 훅이 있으면 아무것도 하지 않고, 다른 훅이 있으면
  백업(`.bak`) 후 교체한다(비대화형에서는 `--force`/`-Force` 필요). 훅 자체는 OS 공통이며
  Windows에서는 Git for Windows에 번들된 `sh`가 실행한다.
- 이 훅은 커밋할 때 Dockerfile 존재·`EXPOSE 8080`(하나만)·금지 항목·고신뢰 시크릿 패턴을
  점검한다. 걸리면 한국어로 사유를 안내하며 커밋을 멈춘다.

### 코드를 저장·반영할 때 (git 기본 흐름)
사용자가 코드를 저장/반영/업로드하려 하거나 그 방법을 물으면, 프로젝트 루트에서 아래 순서로 안내·실행한다:
1. `git add --all` — 바뀐 파일을 모두 담는다.
2. `git commit -m "<변경 요약>"` — 저장한다. 이때 위 pre-commit 훅이 배포 표준을 자동 점검한다
   (훅에 걸리면 사유를 읽고 3~6장 규칙에 맞게 고친 뒤 다시 커밋한다).
3. `git push` — 원격 저장소로 올린다(플랫폼이 이 저장소를 배포에 사용한다).

## 7-1. 코드 저장소 로그인(AWS)
**이 설정을 쓰는 회사라면**(프로젝트 루트나 Kiro 설정 zip 에 `apphub-aws.conf` 와 `setup-aws-git.sh` /
`setup-aws-git.ps1` 이 있는 경우) 코드 저장소(AWS CodeCommit)에 push/clone 할 때 회사 AWS 로그인을 쓴다.
이 파일들이 없으면 이 절은 무시한다.

- **PC 처음 설정(한 번만)**: 사용자가 처음 `git clone`/`git push` 하기 전에 OS에 맞는 설정기를 실행한다.
  - macOS / Linux: `sh setup-aws-git.sh`
  - Windows: `powershell -ExecutionPolicy Bypass -File setup-aws-git.ps1`
  - AWS CLI 버전 2 가 없다고 나오면, 안내된 주소에서 설치한 뒤 다시 실행한다.
  - 이미 다른 값의 apphub 설정이 있다며 멈추면, 사용자에게 바꿔도 되는지 확인한 뒤 `--force`(Windows `-Force`)로 다시 실행한다.
- **사용자가 "AWS 로그인해줘"라고 하면** `aws sso login --profile apphub` 를 실행한다(브라우저가 열리면 회사 계정으로 로그인).
- **push/clone 인증 오류가 나면** — `403`, `The requested URL returned error: 403`, `Unable to locate credentials`,
  `Token has expired`/`토큰 만료`, `Error loading SSO Token` 등:
  1. `aws sso login --profile apphub` 를 실행해 다시 로그인한 뒤, 같은 git 명령을 다시 시도한다
     (로그인은 보통 하루에 한 번 만료된다).
  2. 다시 로그인했는데도 403 이면 더 시도하지 말고, 사용자에게 "회사 AWS 로그인 계정·그룹(AppHub-Developers)·
     이메일이 AppHub 계정과 같은지 관리자에게 확인해 주세요"라고 안내한다. (AppHub 에 저장소를 만든 사람과
     같은 이메일이어야 그 저장소에 접근할 수 있다.)
- **저장소 주소는 HTTPS 를 쓴다**: `https://git-codecommit.{리전}.amazonaws.com/v1/repos/{저장소이름}`
  (플랫폼 화면에 보이는 주소). `codecommit::` 로 시작하는 주소나 SSH 주소는 쓰지 않는다.
- 로그인 정보(토큰·비밀번호)를 코드·README·채팅에 적지 않는다. 설정 파일에는 비밀값이 없다.

## 8. "배포 표준에 맞춰줘" 요청 대응
사용자가 "배포 표준에 맞춰줘" 또는 "이 앱을 배포 표준에 맞게 준비해줘"라고 요청하면
위 1~6 항목을 **전부 점검**하고 미비점을 수정한다. 특히:
- Dockerfile이 없으면 생성한다(위 3 규칙 준수).
- 리슨 포트가 8080이 아니면 8080으로 바꾸고 `EXPOSE 8080` **하나만** 남긴다
  (8080 외 다른 EXPOSE가 있으면 제거한다).
- `/health` 라우트가 없으면 추가한다(200 반환).
- 하드코딩된 시크릿을 환경변수로 옮기고 README에 목록을 기록한다.
- 위 7의 pre-commit 훅이 설치돼 있지 않으면 설치한다.

## 참고: 최종 검증은 플랫폼이 한다
이 지침은 코드가 **처음부터 배포 가능한 형태**로 만들어지도록 돕는 보조 수단이다.
배포 가능 여부의 최종 판정은 플랫폼의 배포 전 검증(Dockerfile 정적 검증 + 이미지 실행 스모크)이
담당한다. 배포가 실패하면 플랫폼 화면의 안내 문구를 그대로 전달하면 된다.
