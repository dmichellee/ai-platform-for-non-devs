# AppHub — 비개발자용 앱 배포 플랫폼

비개발자가 Kiro로 만든 애플리케이션 코드를 **웹 화면 하나에서** 리포지토리 연결 → 배포 →
서비스 상태 확인까지 처리할 수 있는 사내 배포 플랫폼.

> 작업명(가칭) **AppHub** — 스택/리소스 접두어로 `apphub` 사용.

## 설계 원칙

1. **기술 옵션 최소화** — 사용자에게 AWS 용어를 노출하지 않는다. 선택지는 관리자가 사전에 정의한 프리셋과 비기술적 질문으로 좁힌다.
2. **모든 인프라는 코드로** — 플랫폼 자신과 사용자 앱 모두 CDK로 정의하고, 배포는 멱등(idempotent)하다.
3. **메인 서버 무부하** — 빌드·배포 작업은 전부 CodeBuild(임시 원격 환경)에서 수행한다. 플랫폼 API는 접수와 상태 조회만 한다.
4. **친절한 실패** — 빌드/배포 실패를 유형별로 분류해 비개발자가 이해할 수 있는 한국어 안내로 보여준다.

## 아키텍처

세 계층으로 구성된다.

- **컨트롤 플레인** — React SPA + API Gateway/Lambda(Python 3.13, boto3) + DynamoDB + Step Functions + Cognito.
  플랫폼 웹은 설치 시 `--frontend-mode`로 선택: **public**(CloudFront+S3, API Regional) 또는
  **private**(사내망 전용 — 플랫폼 전용 internal ALB + ECS nginx, Private API + VPC 엔드포인트).
  두 모드 모두 콘솔 주소는 `https://console.<appsDomain>`, 로그인은 SPA 자체 화면(Cognito API 직접 호출).
- **파이프라인 계층** — 앱별 CodePipeline + CodeBuild 2단계(검증·빌드 → 배포), ECR. 원격 실행.
- **앱 호스팅 계층** — 공개 범위별 공유 ALB(호스트 기반 라우팅, 규칙 한도 근접 시 자동 증설) + ECS Fargate(공유 클러스터)
  + Route53(`*.<appsDomain>`, 사내용 앱은 private zone, 외부 공개 앱은 public+private zone) + Secrets Manager

앱 하나 = CloudFormation 스택 2개(`pipeline` + `runtime`). 멱등성은 CloudFormation이 보장하고,
앱 삭제는 스택 2개 삭제로 끝나 리소스 누수가 없다.

### CDK 스택

| 스택 | 내용 | 배포 주체 |
|---|---|---|
| `apphub-{stage}-network` | 공유 ALB 2대(n=0), 공유 ECS 클러스터, 와일드카드 ACM, private hosted zone, 보안 그룹, Waker/복원/잠자기 Lambda + ALB별 Waker TG, SSM 공유값 | 관리자 (`deploy.sh`) |
| `apphub-{stage}-platform` | Cognito, DynamoDB, API GW+Lambda, Step Functions, provisioner CodeBuild + 플랫폼 웹(모드별 — public: CloudFront + us-east-1 인증서 / private: 콘솔 ALB + ECS nginx + VPC 엔드포인트 + Private API) | 관리자 (`deploy.sh --frontend-mode`) |
| `apphub-{stage}-alb-{internet\|internal}-{n}` (n≥1) | 증설 ALB 1대 + 리스너 + 전용 Waker TG + SSM 발행. 앱 생성 흐름이 규칙 여유 부족을 감지하면 자동 생성(앱 삭제와 무관한 플랫폼 소유) | 플랫폼 (provisioner) |
| `apphub-{stage}-app-{appId}-pipeline` | 앱별 CodePipeline, CodeBuild 2개, ECR | 플랫폼 (provisioner) |
| `apphub-{stage}-app-{appId}-runtime` | ECS 서비스/태스크, Target Group, 배정된 ALB의 리스너 규칙, Route53, 앱 IAM 역할, 가동 스케줄 | 앱 파이프라인 |

## 저장소 구조 (모노레포)

```
infra/          CDK 인프라 (TypeScript) — 모든 스택의 단일 코드베이스
backend/        컨트롤 플레인 백엔드 (Python 3.13, 순수 boto3) — Lambda 핸들러 + Dockerfile 검증기
frontend/       React SPA (TypeScript, Vite) — 사용자 대시보드·앱 생성 마법사·관리자 페이지
design-system/  디자인 토큰·컴포넌트 규격
e2e/            엔드투엔드 테스트 + 샘플 앱 픽스처
kiro-config/    Kiro steering 설정 (빌드 표준 강제)
scripts/        deploy.sh / destroy.sh (멱등 설치·제거) + Kiro 번들 빌드
docs/           설계 문서 (단일 진실 원본) — 로컬 전용, 버전관리 제외
```

## 요구 사항

- Node.js >= 22, pnpm 10.5.2
- Python >= 3.13 (백엔드 — 런타임 의존성 없음, dev 도구는 uv/pytest/ruff)
- AWS CLI 자격증명 + CDK, Docker (배포 시)

## 개발

```bash
pnpm install            # 워크스페이스 의존성 설치

pnpm build              # 전체 워크스페이스 빌드
pnpm test               # 전체 테스트
pnpm typecheck          # 타입 점검
pnpm synth              # CDK synth 검증 (infra)

pnpm -C frontend dev    # SPA 개발 서버 (Vite)
```

백엔드(Python):

```bash
cd backend
uv sync                 # dev 의존성 설치
uv run pytest           # 테스트
uv run ruff check .     # 린트
```

## 배포

`scripts/deploy.sh` 는 멱등하다 — 같은 명령을 몇 번 실행해도 결과가 같다.

```bash
./scripts/deploy.sh --stage dev|prod --domain <apps.example.com> \
    [--frontend-mode public|private] \
    [--hosted-zone-id <ZID>] [--region <region>] \
    [--admin-email <email>] [--admin-name <name>] \
    [--internal-cidrs "10.0.0.0/16,..."] \
    [--skip-spa] \
    [--sso-start-url <https://d-xxxx.awsapps.com/start> --sso-region <IC 리전> --sso-permission-set <AppHubGit>]
```

- `--domain`은 사용자 앱 apex 도메인(예: dev는 `apps-dev.example.com`)이며 Route53 public
  hosted zone이 있어야 한다. `--hosted-zone-id` 미지정 시 도메인(및 상위 라벨)로 자동 조회한다.
- `--frontend-mode`(기본 `public`): 플랫폼 웹 배포 모드. `private`는 콘솔·API·로그인이 모두 사내망(VPC) 안에서만
  열리므로 사내망-VPC 연결과 `<appsDomain>` DNS 포워딩이 필요하다. 다른 값으로 재실행하면 모드가 전환된다.
- `--internal-cidrs`: 사내용 ALB(및 private 모드 콘솔·VPC 엔드포인트)에 접속을 허용할 대역. 미지정 시 VPC 대역만.
- `--sso-start-url` / `--sso-region` / `--sso-permission-set`(D22, 선택): 코드 저장소(CodeCommit) 사용자 로그인을
  IAM Identity Center 로 한다. **3개 모두 주면 활성, 일부만 주면 사전 점검에서 중단**, 없으면 비활성(이전 동작).
  Identity Center(조직 인스턴스·그룹·권한 세트·`email` 접근 제어 속성)는 AppHub가 만들지 않으므로 먼저 준비한다
  — 고객 절차서: [`IDENTITY-CENTER-SETUP.md`](IDENTITY-CENTER-SETUP.md) (정책 JSON·사용자 운영·PC 설정·문제 해결). 활성이면 Kiro 설정 zip 에 PC 1회 설정기(`setup-aws-git.sh`/`.ps1`)와
  `apphub-aws.conf` 가 들어간다. 계정 ID·CodeCommit 리전(`--region`)은 자동. 값 형식: 시작 URL `https://…`,
  리전 `ap-northeast-2` 형식, 권한 세트 영숫자·`+=,.@-` 1~32자.

동작 순서(출력의 단계 번호와 동일):
`1/5` 사전 점검 → `2/5` `cdk bootstrap` → `2b/5` Lambda 자산 동기화 → `2c/5` (private만) SPA 빌드·Kiro zip을 콘솔 이미지 내용으로 준비
→ `3/5` `network` → `platform` 스택 배포 → `3b/5` provisioner 자산 업로드 → `3c/5` Kiro 설정 zip 업로드(public만)
→ `3d/5` 기본 권한 템플릿 시드 → `3e/5` CodeCommit 저장소 소유 태그 `apphub:owner` 백필(없는 것만, 실패 시 경고 후 계속) → `4/5` 최초 관리자 계정 생성 + (public만) SPA 빌드·`config.json`·S3 sync·CloudFront invalidation
→ `5/5` 완료 출력(콘솔 주소 `https://console.<appsDomain>`, 모드, User Pool, Kiro 설정 URL, Git 인증 활성/비활성).

ALB 증설 스택(`apphub-{stage}-alb-*`)은 deploy.sh가 아니라 플랫폼이 앱 생성 중 필요할 때 provisioner CodeBuild로 만든다.

제거:

```bash
./scripts/destroy.sh --stage dev|prod [--region <region>] [--yes]
```

CDK synth 없이 `aws cloudformation delete-stack`으로 `app-*-runtime → app-*-pipeline → alb-* → platform → network`
순서로 지운다(실패/롤백 상태 스택 포함, 재실행 안전). prod는 `apphub-prod` 입력 확인을 강제하며,
prod의 RETAIN 리소스(DynamoDB·User Pool·버킷)와 CDK bootstrap은 지우지 않는다.

## 설계 문서

설계 문서가 단일 진실 원본이며 `docs/` 에 있다(로컬 전용, 버전관리 제외).

- `docs/DESIGN.md` — 플랫폼 기능·아키텍처·설계 결정(D1–D21)
- `docs/PLATFORM-ENGINEERING.md` — 플랫폼 개발·설치 규칙
- `docs/TEST-STRATEGY.md` — 테스트 전략
- `docs/KIRO-STANDARDS.md` — Kiro 빌드 표준
