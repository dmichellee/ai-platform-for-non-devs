# AppHub 라이브 E2E

릴리스 게이트. 배포된 dev 스테이지에 대해 골든 샘플 앱의 실제 배포 여정을 검증한다.
**실제 AWS 비용(소액)과 시간(~30분)이 든다.** 퍼블릭 애셋 사용자가 설치 후 검증용으로도 쓸 수 있게
self-contained 로 만들어져 있다.

## 구성
```
e2e/
├── run-e2e.sh            # 메인 E2E (시나리오 1~5 기본, 6은 명시 실행)
├── idempotency-test.sh   # 설치 스크립트 멱등성(deploy 2회 no-op + destroy 후 재설치)
├── lib/common.sh         # 공용 헬퍼(로그인/API/폴링/누수검사/DDB CONFIG 조작/앱 URL curl)
├── lib/tunnel.sh         # internal 앱 접속용 SSM 포트 포워딩 터널(E2E_INTERNAL_TUNNEL=1)
├── fixtures/             # 골든 샘플 앱 6종 (README 참조)
└── web/                  # Playwright 웹 UI 시나리오
    ├── playwright.config.ts
    └── specs/*.spec.ts
```

## 실행
```bash
# 전체 시나리오
./e2e/run-e2e.sh --stage dev

# 특정 시나리오만(예: 실패 유형 검증 + wake)
./e2e/run-e2e.sh --stage dev --scenario 2,4

# 노트북에서 internal 앱 URL 까지 확인(SSM 포트 포워딩 터널, pyenv 사용 시 버전 지정)
E2E_INTERNAL_TUNNEL=1 PYENV_VERSION=3.10.14 ./e2e/run-e2e.sh --stage dev --scenario 1,2,3,4,5

# 멱등성만
./e2e/idempotency-test.sh --stage dev

# ALB 증설(시나리오 6) — dev 전용, 기본 목록에 없음. 명시해야만 실행된다.
./e2e/run-e2e.sh --stage dev --scenario 6                   # 증설 스택은 남겨 둠
./e2e/run-e2e.sh --stage dev --scenario 6 --cleanup-shard   # 증설 스택·레지스트리 항목까지 삭제
#  ↑ 이전 실행이 남긴 증설 흔적이 있으면 같은 명령이 "정리만" 수행하고 끝난다(앱 생성/ruleCount 조작 없음).
```

## 시나리오
1. **정상 배포 여정** — sample-ok 앱 생성 → 파이프라인 완주 → 발급 URL HTTPS 200 →
   sample-streaming 스트리밍 확인 → 삭제 → **리소스 누수 검사**(app-* 스택/ECR/Route53/리스너 규칙).
2. **실패 유형 검증** — 실패 픽스처 4종 → 기대 failureCategory(DOCKERFILE_MISSING / DOCKERFILE_INVALID /
   BUILD_FAILED / HEALTHCHECK_FAILED) 확인.
3. **자동 배포** — sample-ok 새 커밋 push → 파이프라인 자동 트리거(배포 이력 증가) 확인.
4. **가동 스케줄 + wake** — "1분 뒤 중지" 스케줄 → SLEEPING(task 0 + 리스너 Waker 전환) →
   URL 접속 → 대기 페이지 200 → WAKING → RUNNING 복원 → 앱 응답 복원.
5. **웹 UI (Playwright)** — 로그인 → 마법사 앱 생성 → 대시보드 상태 → 로그 뷰어 → 삭제.
   관리자: 프리셋 생성 → 사용자 화면 반영.
   - 접속 주소: `E2E_WEB_URL` > platform Output `ConsoleUrl`(`https://console.{appsDomain}`, D19) >
     `CloudFrontDomain`(구버전 폴백).
   - 로그인(D21): 실서비스 모드는 콘솔 로그인 화면에서 **회사 이메일 / 비밀번호 입력 → "로그인" 버튼**
     (외부 로그인 페이지로 이동하지 않음). 자격은 `E2E_USERNAME/E2E_PASSWORD`(사용자),
     `E2E_ADMIN_USERNAME/E2E_ADMIN_PASSWORD`(관리자). 미지정 시 해당 케이스 skip.
     목 모드(config.json 없음)는 "사용자로/관리자로 둘러보기" 우회 버튼 사용.
6. **ALB 증설 (D20, 레지스트리 조작)** — **dev 전용 · `--scenario 6` 명시 실행만**.
   1. internal n=0 ALB 레지스트리(`CONFIG / ALB#{arn}`) `ruleCount` 원래 값 백업(항목이 없으면 lazy seed 와 같은 shape 로 시드).
   2. `ruleCount`→80 + internal 앱 A 생성 → `ALBPENDING#internal#1` 생성 · provisioner(`APP_STACK_KIND=alb`) 빌드 시작 확인 →
      `apphub-dev-alb-internal-1` `CREATE_COMPLETE` 대기 → `ALB#`(index=1, ACTIVE) 등록 + SSM `alb/internal/1/alb-arn` 일치 확인.
   3. n=0 `ruleCount`→90 + 앱 B 생성 → `App.albIndex=1` 배정 → (n=0 즉시 복원) → 배포 완주 → 증설 ALB 리스너에 host 규칙 존재 →
      HTTPS 200(`/health`, 또는 잠든 경우 Waker 대기 페이지 `/`).
   4. 정리(trap — 실패·Ctrl-C 에도): n=0 `ruleCount` 복원 → 앱 A/B 삭제(404 대기) →
      `--cleanup-shard` 면 index=1 `ruleCount=0` 확인 후 `ALB#` 항목 조건부 삭제 + 증설 스택 삭제.
   - DDB 조작은 `aws dynamodb update-item/delete-item` + 조건식(낙관적 잠금: 올릴 때 `ruleCount = 읽은 값`,
     복원은 **올린 양(delta)만큼 차감** — 테스트 앱 생성/삭제나 동시 배정이 있어도 카운터가 틀어지지 않음).
   - 사전 점검: 기존 internal 증설 흔적(ALB# index≥1 / PENDING / 증설 스택)이 있으면 중단
     (`--cleanup-shard` 를 주면 정리만 수행). n=0 `ruleCount` 가 이미 80 이상이어도 중단.
   - 소요: 증설 스택 생성 ~10–20분 + 앱 배포 2회. 실행 중에는 n=0 이 80~90 으로 보여 **다른 dev 사용자의 internal 앱이
     증설 ALB 로 배정될 수 있다**(공용 dev 에서는 공지 후 실행).
   - 필요 권한(실행 주체): `dynamodb:GetItem/Query/UpdateItem/DeleteItem`(플랫폼 테이블), `codebuild:BatchGetBuilds`,
     `cloudformation:DescribeStacks/DeleteStack`, `elasticloadbalancing:DescribeRules`, `ssm:GetParameter`.
     `--cleanup-shard` 의 스택 삭제는 해당 스택 리소스 삭제 권한도 필요.

## 라이브 실행 선행조건 (dev 배포 담당용)

이 스크립트들은 **AWS 리소스를 만들지 않는다**. 아래가 먼저 갖춰져야 한다:

1. **플랫폼 배포**: `./scripts/deploy.sh --stage dev --domain <apps-dev.example.com>` 완료(network + platform 스택, SPA).
2. **관리자 초기 설정**(관리자 화면 또는 admin API):
   - provider 활성화: `codecommit`(기본) — 시나리오는 CodeCommit 리포에 픽스처를 push한다.
   - 컴퓨팅 프리셋 ≥ 1, 권한 템플릿 ≥ 1
   - (앱 배치 네트워크는 플랫폼 VPC 자동 — 별도 등록 없음)
3. **테스트 사용자**(확정 비밀번호, 임시 비번 상태 아님):
   - user 그룹 1명, admin 그룹 1명
   - 인증 방식(D21): 스크립트는 SPA 와 같은 `aws cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH`
     (공개 API — IAM 관리자 권한 불필요)로 ID 토큰을 얻는다. SPA 앱 클라이언트 기본 설정(`userPassword` + refresh)
     그대로면 되고 `ADMIN_USER_PASSWORD_AUTH` 는 쓰지 않는다(비활성).
   - 임시 비밀번호 상태면 콘솔 로그인 화면에서 한 번 로그인해 새 비밀번호를 정해 두면 된다.
   - 선택: `E2E_COGNITO_IDP_ENDPOINT` 로 로그인 API 엔드포인트를 바꿀 수 있다(`--endpoint-url`).
4. **환경변수 주입**(자격 증명은 스크립트에 하드코딩하지 않는다):
   ```bash
   export E2E_USERNAME=... E2E_PASSWORD=...
   export E2E_ADMIN_USERNAME=... E2E_ADMIN_PASSWORD=...   # 시나리오 5 관리자
   # 선택(미지정 시 목록 첫 항목 자동 선택):
   export E2E_PRESET_ID=... E2E_PERM_ID=...
   export E2E_WEB_URL=https://console.<appsDomain>         # 시나리오 5(미지정 시 ConsoleUrl Output)
   ```
5. **CodeCommit push 경로**: `git-remote-codecommit` 필수(`pip install git-remote-codecommit`).
   스크립트는 `codecommit::{region}://{repo}` 원격을 쓴다. 사전 점검(시나리오 0)이 `command -v git-remote-codecommit`
   으로 확인하고, pyenv shim 이면 **현재 버전에 실제 설치됐는지**(`pyenv which`)까지 본다. 다른 버전에만 있으면
   `PYENV_VERSION=<버전>` 을 지정하라고 안내하고 종료한다. 픽스처 push/clone 이 실패하면 해당 시나리오는
   앱을 만들지 않고 즉시 실패한다.
6. **네트워크 접근**: 기본 시나리오는 `scheme=internal` 앱을 만든다. internal ALB 는 VPC 안에서만 닿는다
   (SG 443 = VPC CIDR). 노트북에서 실행할 때는 아래 **internal 앱 터널**(`E2E_INTERNAL_TUNNEL=1`)을 켜거나,
   VPC 내부(사내망/VPN/베스천)에서 실행한다.
7. **Playwright**: `cd e2e/web && npm install && npx playwright install --with-deps chromium`.
8. **플랫폼 웹 모드(D19)**: `load_outputs` 가 `FrontendMode` 를 읽는다.
   - `public`: `ApiUrl`(공개 API) · `ConsoleUrl`(CloudFront) 모두 인터넷에서 접근 가능.
   - `private`: `ApiUrl` 은 **Private API**(execute-api VPC 엔드포인트 경유), 콘솔은 internal ALB —
     **사내망/VPN/베스천 등 플랫폼 VPC 에 닿는 위치에서 실행해야 한다**(스크립트가 경고 로그 출력).
     로그인(`initiate-auth`)은 기본 공개 엔드포인트로 호출되며, 막혀 있으면 `E2E_COGNITO_IDP_ENDPOINT` 에
     `CognitoIdpEndpoint` Output 값을 넣는다.

## internal 앱 터널 (`E2E_INTERNAL_TUNNEL=1`)

노트북 → internal ALB 경로를 SSM Session Manager 포트 포워딩으로 만든다. 인바운드 포트를 여는 것이 없다.

```
curl --connect-to {sub}.{appsDomain}:443:127.0.0.1:8443 https://{sub}.{appsDomain}/health
  └─ 127.0.0.1:8443 ─(session-manager-plugin)─ SSM ─ 임시 EC2(사설 서브넷) ─ internal ALB:443
```

- 준비(시나리오 0, 멱등): IAM 역할·인스턴스 프로파일 `apphub-{stage}-e2e-tunnel-role`(EC2 신뢰 +
  `AmazonSSMManagedInstanceCore`) → SG `apphub-{stage}-e2e-tunnel-sg`(**인그레스 없음**, 기본 아웃바운드) →
  EC2 `t4g.nano`(AL2023 arm64, `private-subnet-id-0`, 퍼블릭 IP 없음, IMDSv2 필수, 태그 `Name=apphub-{stage}-e2e-tunnel`,
  `apphub:purpose=e2e-tunnel`; 같은 태그 running 인스턴스는 재사용) → SSM Online 대기(최대 5분) →
  `AWS-StartPortForwardingSessionToRemoteHost`(host = SSM `alb/internal/0/alb-dns`, 443 → `127.0.0.1:${E2E_TUNNEL_PORT:-8443}`).
- 검증: 터널로 `https://e2e-tunnel-probe.{appsDomain}/` 요청 → internal ALB 기본 응답 404 "No app for this host".
- 앱 URL 확인(시나리오 1·4·6의 200/스트리밍/Waker 대기 페이지/깨어남)은 전부 `e2e::app_curl` 을 거친다.
  호스트가 `*.{appsDomain}` 이고 터널이 열려 있으면 `--connect-to` 만 추가 — **Host·SNI·인증서 검증은 실제 그대로**
  (와일드카드 인증서). 인증서 검증을 끄려면 `E2E_CURL_INSECURE=1`. 콘솔·API 호출은 터널을 타지 않는다.
- 시나리오 6의 앱 B 는 증설 ALB(index=1)에 있으므로 `alb/internal/1/alb-dns` 로 두 번째 포워딩(포트 +1)을 연다.
- 유휴 타임아웃(Session Manager 기본 20분) 대비: 4분마다 터널로 probe 요청(`E2E_TUNNEL_KEEPALIVE` 초),
  세션이 끊겨 있으면 앱 호출 직전에 자동 재연결.
- 옵션: `E2E_TUNNEL_PORT`(기본 8443), `E2E_TUNNEL_KEEP=1`(종료 시 아무것도 안 지움),
  `E2E_TUNNEL_DELETE_ROLE=1`(역할·프로파일까지 삭제 — 기본은 유지해 다음 실행의 IAM 전파 지연을 피함).
- 비용: t4g.nano 온디맨드(서울 기준 시간당 약 $0.005 내외) × 실행 시간 + EBS 8GB(실행 시간만큼) + NAT 데이터 처리량
  (요청 수준이라 미미). SSM 세션 자체는 무료. IAM 역할 유지는 무료.
- 필요 권한(실행 주체):
  - IAM: `iam:GetRole`, `iam:CreateRole`, `iam:AttachRolePolicy`, `iam:GetInstanceProfile`,
    `iam:CreateInstanceProfile`, `iam:AddRoleToInstanceProfile`, `iam:PassRole`(대상 역할) —
    `E2E_TUNNEL_DELETE_ROLE=1` 이면 `iam:RemoveRoleFromInstanceProfile/DeleteInstanceProfile/DetachRolePolicy/DeleteRole`.
  - EC2: `ec2:RunInstances`, `ec2:CreateTags`, `ec2:TerminateInstances`, `ec2:CreateSecurityGroup`,
    `ec2:DeleteSecurityGroup`, `ec2:Describe*`(Instances/SecurityGroups 등).
  - SSM: `ssm:StartSession`(인스턴스 + `AWS-StartPortForwardingSessionToRemoteHost` 문서), `ssm:TerminateSession`,
    `ssm:DescribeInstanceInformation`, `ssm:GetParameter`(`/apphub/{stage}/network/*`, `/aws/service/ami-amazon-linux-latest/*`).
- 로컬 요구: `session-manager-plugin`(PATH), bash `/dev/tcp`(포트 확인).
- 정리 보장: `run-e2e.sh` 의 EXIT/INT/TERM trap 이 항상 `e2e::tunnel_down` 을 호출 —
  세션 프로세스 종료 → 같은 태그의 인스턴스 전부 terminate + terminated 대기 → SG 삭제(ENI 해제 재시도) →
  (옵션) 역할 삭제. 실패·Ctrl-C·터널 준비 중 실패에도 동작한다. 정리 단계에서 Ctrl-C 를 한 번 더 누르면 중단되므로
  그때는 남은 리소스를 아래로 확인:
  ```bash
  aws ec2 describe-instances --filters Name=tag:apphub:purpose,Values=e2e-tunnel \
    --query 'Reservations[].Instances[].[InstanceId,State.Name]'
  aws ec2 describe-security-groups --filters Name=group-name,Values=apphub-dev-e2e-tunnel-sg
  ```
  (다음 실행의 `tunnel_down` 도 같은 태그 인스턴스를 회수한다.)
- 주의: 같은 스테이지에서 터널 E2E 를 **동시에 두 개 돌리지 말 것** — 인스턴스를 재사용·공유하므로 먼저 끝난 쪽이
  다른 쪽의 터널 인스턴스를 terminate 한다.

## 안전장치
- 생성한 앱은 전역 목록(`E2E_TRACKED_APPS`)에 기록된다. 시나리오가 끝나면(실패 포함) 남은 앱 삭제를 접수하고,
  `assert` 의 exit·Ctrl-C 로 끝나도 EXIT trap 이 다시 시도한다(`--keep` 로 보존 가능).
  - DELETE 는 ACTIVE|FAILED 만 접수 → CREATING 이면 settle 까지 재시도(시나리오 종료 시 `E2E_CLEANUP_SETTLE_TIMEOUT`
    기본 600s, EXIT trap 은 `E2E_EXIT_SETTLE_TIMEOUT` 기본 120s). 끝내 접수 못 한 appId 는 로그로 안내한다.
  - EXIT trap 정리는 토큰을 조용히 재발급한 뒤 진행한다(1시간 토큰 만료 대비).
- 시나리오 6의 ruleCount 복원·앱 A/B 정리도 같은 EXIT trap 에서(터널 정리 전에) 실행된다.
- 앱 이름/서브도메인에 `e2e-` 접두어를 붙여 야간 정리 스크립트가 걸러낼 수 있다.

## 로컬 문법/유효성 검증(AWS 불필요)
```bash
bash -n e2e/run-e2e.sh e2e/idempotency-test.sh e2e/lib/common.sh e2e/lib/tunnel.sh
(cd e2e/web && npm install && npx tsc --noEmit -p .)
for f in e2e/fixtures/sample-*/server.js; do node --check "$f"; done
# 검증기로 픽스처 카테고리 확인은 e2e/fixtures/README.md 참조.
```
