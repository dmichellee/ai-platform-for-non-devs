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

- **컨트롤 플레인** — React SPA(CloudFront+S3) + API Gateway/Lambda(Python 3.13, boto3) + DynamoDB + Step Functions + Cognito
- **파이프라인 계층** — 앱별 CodePipeline + CodeBuild 2단계(검증·빌드 → 배포), ECR. 원격 실행.
- **앱 호스팅 계층** — VPC별 공유 ALB(호스트 기반 라우팅) + ECS Fargate + Route53(`*.apps.<도메인>`) + Secrets Manager

앱 하나 = CloudFormation 스택 2개(`pipeline` + `runtime`). 멱등성은 CloudFormation이 보장하고,
앱 삭제는 스택 2개 삭제로 끝나 리소스 누수가 없다.

### CDK 스택

| 스택 | 내용 | 배포 주체 |
|---|---|---|
| `apphub-{stage}-network` | 공유 ALB, 공유 ECS 클러스터, 와일드카드 ACM, Route53, 보안 그룹, Waker | 관리자 (`deploy.sh`) |
| `apphub-{stage}-platform` | Cognito, DynamoDB, API GW+Lambda, Step Functions, SPA 호스팅, provisioner CodeBuild | 관리자 (`deploy.sh`) |
| `apphub-{stage}-app-{appId}-pipeline` | 앱별 CodePipeline, CodeBuild 2개, ECR | 플랫폼 (provisioner) |
| `apphub-{stage}-app-{appId}-runtime` | ECS 서비스/태스크, Target Group, 리스너 규칙, Route53, 앱 IAM 역할, 가동 스케줄 | 앱 파이프라인 |

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
    [--hosted-zone-id <ZID>] [--region <region>] \
    [--admin-email <email>] [--admin-name <name>] \
    [--internal-cidrs "10.0.0.0/16,..."] \
    [--skip-spa]
```

`--domain`은 사용자 앱 apex 도메인(예: dev는 `apps-dev.example.com`)이며 Route53 public
hosted zone이 있어야 한다. `--hosted-zone-id` 미지정 시 도메인(및 상위 라벨)로 자동 조회한다.

동작 순서: 사전 점검 → `cdk bootstrap` → `network`·`platform` 스택 배포 → provisioner 자산·Kiro 설정 업로드
→ 최초 관리자 계정 생성 → SPA 빌드·S3 sync·CloudFront invalidation.

제거:

```bash
./scripts/destroy.sh --stage dev|prod
```

## 설계 문서

설계 문서가 단일 진실 원본이며 `docs/` 에 있다(로컬 전용, 버전관리 제외).

- `docs/DESIGN.md` — 플랫폼 기능·아키텍처·설계 결정(D1–D18)
- `docs/PLATFORM-ENGINEERING.md` — 플랫폼 개발·설치 규칙
- `docs/TEST-STRATEGY.md` — 테스트 전략
- `docs/KIRO-STANDARDS.md` — Kiro 빌드 표준
