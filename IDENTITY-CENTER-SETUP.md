# AppHub — 코드 저장소(CodeCommit) 로그인 설정 안내 (IAM Identity Center)

AppHub 사용자가 자기 PC에서 AppHub의 코드 저장소(AWS CodeCommit)에 코드를 올리려면(`git push`)
AWS 인증이 필요합니다. AppHub는 이 인증에 **고객사의 AWS IAM Identity Center**를 사용합니다.

- IAM 사용자·장기 비밀번호를 만들지 않습니다. 사용자는 회사 AWS 로그인으로 받은 **임시 자격**으로만 접근합니다.
- 각 사용자는 **자기가 AppHub에서 만든 저장소에만** 접근할 수 있습니다.
- AppHub 화면 로그인(이메일/비밀번호)은 이와 별개로 지금처럼 동작합니다.

> 이 기능은 선택입니다. 설치 시 아래 3단계의 인자를 주지 않으면 이전과 동일하게 동작하며, 사용자 PC Git 인증은 각 회사 방식에 맡깁니다.

---

## 1. 전제조건

| 항목 | 요구 사항 |
|---|---|
| IAM Identity Center | **조직 인스턴스**가 활성화돼 있어야 합니다. *계정 인스턴스로는 동작하지 않습니다*(권한 세트·AWS 계정 접근 미지원). |
| AWS Organizations | 조직 인스턴스의 전제입니다. AppHub 계정이 독립 계정이면 그 계정으로 Organizations를 만들어 관리 계정으로 쓸 수 있습니다(무료). 단, AWS 모범 사례는 **관리 계정에 워크로드를 두지 않는 것**입니다 — 가능하면 별도 관리 계정을 만들고 AppHub 계정을 멤버로 두세요. AppHub 계정이 회사 조직의 **멤버 계정**이면 회사 AWS 관리자(관리 계정)가 아래 2단계를 수행합니다. |
| 사용자 PC | **AWS CLI v2.9 이상** 설치(공식 설치 파일, Python 불필요 — `sso-session` 설정이 2.9부터 지원). mac/Windows 모두 설치에 관리자 권한이 필요할 수 있으니 PC 관리 정책을 확인하세요. **설치 후 터미널/PowerShell 창을 새로 열어야** `aws` 명령이 인식됩니다. Git 설치. |
| 네트워크 | 사용자 PC에서 `*.awsapps.com`(SSO 로그인 포털), `oidc.<region>.amazonaws.com`, `git-codecommit.<region>.amazonaws.com` 에 HTTPS 접근. **AppHub를 private 모드로 설치해도 로그인에는 인터넷 경로가 필요합니다.** |

---

## 2. Identity Center 준비 (회사 AWS 관리자, 1회)

AppHub 설치 스크립트는 Identity Center 설정을 **만들거나 바꾸지 않습니다.** 아래를 먼저 준비해 주세요.

### 2.1 그룹
- 이름 예: `AppHub-Developers` — AppHub로 앱을 만들 사람을 이 그룹에 넣습니다.

### 2.2 접근 제어용 속성(ABAC) — **필수**
Identity Center 콘솔 → 설정 → **Attributes for access control** → 활성화 후 속성 추가:

| 키(Key) | 값(Value) |
|---|---|
| `email` | `${path:emails[primary eq true].value}` |

> 이 설정이 없으면 모든 사용자의 push가 거부됩니다(권한 판정에 이메일을 씁니다).
>
> **사용자의 이메일이 "기본(primary)" 으로 지정돼 있어야 합니다.** 위 값은 *기본 이메일*만 읽기 때문에, 기본 지정이 없는 사용자는
> 세션에 이메일이 실리지 않아 **자기 저장소에도 403** 이 납니다. Identity Center 콘솔에서 만든 사용자는 보통 자동 지정되지만,
> **API·CLI·스크립트로 만든 사용자는 빠질 수 있습니다.** 확인: `aws identitystore describe-user --identity-store-id <ID> --user-id <USER_ID> --query Emails`
> 결과에 `"Primary": true` 가 있어야 합니다. 없으면 `aws identitystore update-user ... --operations '[{"AttributePath":"emails","AttributeValue":[{"Value":"<이메일>","Primary":true}]}]'` 로 지정하세요.
> 값을 바꾼 뒤 사용자는 **로그아웃 후 다시 로그인**(`aws sso logout --profile apphub` → `aws sso login --profile apphub`)해야 반영됩니다.

### 2.3 권한 세트
- 이름 예: `AppHubGit` (설치 시 이 이름을 넘깁니다)
- 세션 시간: 권장 **8시간** (사용자는 이 시간마다 다시 로그인합니다)
- 인라인 정책 — `<REGION>`, `<ACCOUNT_ID>` 를 AppHub 설치 리전·계정으로 바꿉니다:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AppHubGitOwnRepositoriesOnly",
      "Effect": "Allow",
      "Action": ["codecommit:GitPull", "codecommit:GitPush"],
      "Resource": "arn:aws:codecommit:<REGION>:<ACCOUNT_ID>:*",
      "Condition": {
        "StringEqualsIgnoreCase": {
          "aws:ResourceTag/apphub:owner": "${aws:PrincipalTag/email}"
        }
      }
    }
  ]
}
```

- 다른 권한(콘솔, 저장소 생성·삭제, 태그 변경 등)은 넣지 마세요. 저장소 생성은 AppHub 화면이 대신합니다.
- 조건 연산자는 반드시 **`StringEqualsIgnoreCase`** 로 두세요. AppHub는 소유 태그를 소문자 이메일로 저장하므로 `StringEquals` 로 바꾸면 대문자가 섞인 이메일 사용자는 403이 납니다.

### 2.4 계정 할당
- AWS 계정(AppHub 설치 계정) → 그룹 `AppHub-Developers` → 권한 세트 `AppHubGit`

### 2.5 설치에 넘길 값 메모
- **AWS 액세스 포털 URL**(SSO 시작 URL): 예 `https://d-1234567890.awsapps.com/start`
- **Identity Center 리전**: 예 `ap-northeast-2`
- **권한 세트 이름**: 예 `AppHubGit`

---

## 3. AppHub 설치·업그레이드

```bash
./scripts/deploy.sh --stage prod --domain apps.example.com --region ap-northeast-2 \
    --sso-start-url https://d-1234567890.awsapps.com/start \
    --sso-region ap-northeast-2 \
    --sso-permission-set AppHubGit
```

- 세 값은 **모두 주거나 모두 생략**합니다. 일부만 주면 설치가 사전 점검에서 멈춥니다.
- 설치 시 다음이 자동으로 됩니다.
  - 사용자에게 배포되는 **Kiro 설정 파일(zip)** 에 PC 로그인 설정 도구가 포함됩니다.
  - **기존 저장소에 소유자 표시(태그)를 채웁니다**(없는 것만, 반복 실행 안전). 업그레이드 설치라면 이 단계가 끝나야 기존 사용자도 push·clone할 수 있습니다. 이미 붙어 있는 태그는 값과 무관하게 바꾸지 않습니다(수동으로 넘긴 소유자 보존).
  - 소유자(AppHub 사용자)를 찾지 못한 저장소(퇴사자 등)는 경고만 남기고 건너뜁니다 — 설치 로그의 경고를 확인해 관리자가 `apphub:owner` 태그를 직접 붙이세요.
- Identity Center 값이 바뀌면(포털 URL, 권한 세트 이름) 같은 명령으로 다시 설치하고, 사용자에게 **새 Kiro 설정 파일로 PC 설정을 다시 하도록** 안내하세요.

---

## 4. 사용자 등록·퇴사 운영 (중요)

회사 IdP 연동 없이 운영하므로 사용자는 **두 곳에 각각** 만들어야 합니다.

| 상황 | AppHub (관리자 화면 → **사용자** 탭) | Identity Center (회사 AWS 관리자) |
|---|---|---|
| 신규 사용자 | 이메일로 초대 | 사용자 생성(**AppHub와 같은 이메일**) + `AppHub-Developers` 그룹 추가 |
| 퇴사·권한 회수 | 사용자 비활성화 | 사용자 비활성화(또는 그룹 제외). **즉시 차단**하려면 콘솔에서 활성 세션 회수 — 그렇지 않으면 이미 받은 세션이 세션 시간까지 유효 |
| 이메일 변경 | (권장하지 않음) | (권장하지 않음) |

- **두 곳의 이메일이 다르면 그 사용자는 자기 저장소에도 push할 수 없습니다**(대소문자 차이는 허용).
- 이메일에 `'` `!` `%` 같은 특수문자가 있으면 AWS 태그 값 제약 때문에 저장소를 만들 수 없습니다(문자·숫자와 `@ . _ - + =` 만 허용). 이런 주소는 사용하지 마세요. AppHub는 초대 시 Identity Center 계정 존재 여부를 확인하지 않습니다.
- Identity Center 사용자는 초대 메일로 비밀번호·MFA를 설정합니다. AppHub 초대 메일과 **별개의 메일**이라는 점을 사용자에게 미리 알려 주세요.
- 저장소 소유자는 **그 저장소를 만든 AppHub 사용자**로 고정됩니다. 다른 사람에게 넘기려면 관리자가 CodeCommit 저장소의 `apphub:owner` 태그 값을 새 소유자 이메일로 바꿔야 합니다. 관리자도 기본적으로 남의 저장소에 push할 수 없습니다(필요하면 별도 권한 세트로 부여).

---

## 5. 사용자에게 전달할 안내 (PC 처음 설정)

1. **AWS CLI v2 설치** — https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html
2. AppHub 화면 → **Kiro 설정** → 내 OS용 zip 다운로드 후 압축 해제
3. PC당 **한 번만** 실행:
   - mac: `sh setup-aws-git.sh`
   - Windows: `powershell -ExecutionPolicy Bypass -File setup-aws-git.ps1` (기본 실행 정책 때문에 `.\setup-aws-git.ps1` 로는 차단됩니다)
4. 브라우저가 열리면 **회사 AWS 계정**(Identity Center)으로 로그인 → 완료
5. 이후 `git push` 는 그대로 동작합니다. **세션 시간이 지나면**(보통 하루 1번) 다시 로그인:
   `aws sso login --profile apphub` — 또는 Kiro에게 "AWS 로그인해줘"

설정 도구가 바꾸는 것:
- `~/.aws/config` 에 `apphub` 프로필 추가(다른 프로필은 건드리지 않음. 같은 이름이 다른 값으로 있으면 멈추고 알려 줌)
- Git 전역 설정 중 **CodeCommit 주소에 대한 로그인 방식만** 변경(GitHub 등 다른 저장소 설정은 그대로). 이 주소에 기존 방식(예: IAM Git 비밀번호)을 쓰던 PC는 바뀌기 전에 확인을 묻습니다.
- 되돌리기: mac `sh setup-aws-git.sh --uninstall` / Windows `powershell -ExecutionPolicy Bypass -File setup-aws-git.ps1 -Uninstall` (지우기 전 설정 파일 자동 백업)
- 옵션 표기는 OS마다 다릅니다: mac `--force` `--uninstall` `--no-login` / Windows `-Force` `-Uninstall` `-NoLogin`
- 확인 단계에서 멈추거나 거절하면 아무 설정도 바뀌지 않습니다(반쯤 바뀐 상태가 남지 않음). 브라우저 로그인만 실패한 경우에는 설정은 남고 다시 로그인하면 됩니다.

주의:
- 저장소 주소는 AppHub 화면에 표시되는 **HTTPS 주소**를 쓰세요. `codecommit::` 형식(git-remote-codecommit)은 쓰지 않습니다.

---

## 6. 문제 해결

| 증상 | 원인 | 조치 |
|---|---|---|
| `Unable to locate credentials`, `Token has expired` | 로그인 세션 만료 | `aws sso login --profile apphub` |
| push/pull 시 **403** | Identity Center 계정·그룹 없음, 두 곳 이메일 불일치, ABAC 속성 미설정, **사용자 이메일이 기본(primary) 미지정**, 저장소 소유 태그 없음(업그레이드 직후) | 관리자: 4장 운영 규칙·2.2 ABAC(기본 이메일 확인 포함)·3장 재설치(태그 채우기) 확인. 설정을 고친 뒤 사용자는 `aws sso logout --profile apphub` 후 다시 로그인 |
| 브라우저 로그인 화면이 안 열림 | 네트워크에서 `*.awsapps.com` 차단 | 1장 네트워크 요건 확인 |
| mac에서 옛 비밀번호로 계속 실패 | 키체인에 이전 CodeCommit 자격 저장 | `setup-aws-git.sh` 재실행(이 주소의 키체인 사용을 끔) 또는 키체인 접근에서 `git-codecommit` 항목 삭제 |
| `aws: command not found` | AWS CLI 미설치, 또는 설치 후 창을 새로 열지 않음 | 5장 1번 후 터미널/PowerShell 새로 열기 |
| 설정 도구가 "AWS CLI 2.9 이상이 필요해요"로 멈춤 | 오래된 AWS CLI | AWS CLI 업데이트 |
| Windows에서 "스크립트를 실행할 수 없습니다" | PowerShell 실행 정책 | 5장 3번의 `-ExecutionPolicy Bypass` 명령 사용 |
| `setup-aws-git` 이 "다른 설정이 있어요"로 멈춤 | PC에 같은 이름(`apphub`) 프로필이 다른 값으로 존재(예: 다른 회사 AppHub) | 내용 확인 후 mac `--force` / Windows `-Force` 로 교체(원본 자동 백업) |
