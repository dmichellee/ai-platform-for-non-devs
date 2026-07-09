# AppHub 라이브 E2E (TEST-STRATEGY L4)

릴리스 게이트. 배포된 dev 스테이지에 대해 골든 샘플 앱의 실제 배포 여정을 검증한다.
**실제 AWS 비용(소액)과 시간(~30분)이 든다.** 퍼블릭 애셋 사용자가 설치 후 검증용으로도 쓸 수 있게
self-contained 로 만들어져 있다.

## 구성
```
e2e/
├── run-e2e.sh            # 메인 E2E (시나리오 1~5)
├── idempotency-test.sh   # 설치 스크립트 멱등성(deploy 2회 no-op + destroy 후 재설치)
├── lib/common.sh         # 공용 헬퍼(로그인/API/폴링/누수검사)
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

# 멱등성만
./e2e/idempotency-test.sh --stage dev
```

## 시나리오 (TEST-STRATEGY §L4)
1. **정상 배포 여정** — sample-ok 앱 생성 → 파이프라인 완주 → 발급 URL HTTPS 200 →
   sample-streaming 스트리밍 확인 → 삭제 → **리소스 누수 검사**(app-* 스택/ECR/Route53/리스너 규칙).
2. **실패 유형 검증** — 실패 픽스처 4종 → 기대 failureCategory(DOCKERFILE_MISSING / DOCKERFILE_INVALID /
   BUILD_FAILED / HEALTHCHECK_FAILED) 확인.
3. **자동 배포** — sample-ok 새 커밋 push → 파이프라인 자동 트리거(배포 이력 증가) 확인.
4. **가동 스케줄 + wake** — "1분 뒤 중지" 스케줄 → SLEEPING(task 0 + 리스너 Waker 전환) →
   URL 접속 → 대기 페이지 200 → WAKING → RUNNING 복원 → 앱 응답 복원.
5. **웹 UI (Playwright)** — 로그인 → 마법사 앱 생성 → 대시보드 상태 → 로그 뷰어 → 삭제.
   관리자: 프리셋 생성 → 사용자 화면 반영.

## 라이브 실행 선행조건 (dev 배포 담당용)

이 스크립트들은 **AWS 리소스를 만들지 않는다**. 아래가 먼저 갖춰져야 한다:

1. **플랫폼 배포**: `./scripts/deploy.sh --stage dev` 완료(network + platform 스택, SPA).
2. **관리자 초기 설정**(관리자 화면 또는 admin API):
   - VPC 등록(서로 다른 AZ 서브넷 2개)
   - provider 활성화: `codecommit`(기본) — 시나리오는 CodeCommit 리포에 픽스처를 push한다.
   - 컴퓨팅 프리셋 ≥ 1, 권한 템플릿 ≥ 1
   - 허용 베이스 이미지 설정(예: `public.ecr.aws/docker/library/node:22-slim`) — 없으면 검증기가 경고만.
3. **테스트 사용자**(확정 비밀번호, 임시 비번 상태 아님):
   - user 그룹 1명, admin 그룹 1명
   - 앱 클라이언트에 `ADMIN_USER_PASSWORD_AUTH` 흐름 허용(로그인 스크립트가 사용).
4. **환경변수 주입**(자격 증명은 스크립트에 하드코딩하지 않는다):
   ```bash
   export E2E_USERNAME=... E2E_PASSWORD=...
   export E2E_ADMIN_USERNAME=... E2E_ADMIN_PASSWORD=...   # 시나리오 5 관리자
   # 선택(미지정 시 목록 첫 항목 자동 선택):
   export E2E_PRESET_ID=... E2E_PERM_ID=... E2E_VPC_ID=...
   export E2E_WEB_URL=https://<cloudfront-domain>          # 시나리오 5
   ```
5. **CodeCommit push 경로**: `git-remote-codecommit`(권장) 설치 또는 CodeCommit HTTPS 자격 도우미.
   스크립트는 `codecommit::{region}://{repo}` 원격을 쓴다.
6. **네트워크 접근**: 기본 시나리오는 `scheme=internal` 앱을 만든다. 발급 URL(`{sub}.{appsDomain}`)에
   HTTPS 접속하려면 **VPC 내부(또는 VPN/베스천)**에서 실행해야 할 수 있다. internet-facing 로 검증하려면
   앱 생성 파라미터를 조정한다(관리자가 internet-facing 허용 시).
7. **Playwright**: `cd e2e/web && npm install && npx playwright install --with-deps chromium`.

## 안전장치
- 각 시나리오는 자기가 만든 앱을 종료 시 삭제한다(`--keep` 로 보존 가능).
- 앱 이름/서브도메인에 `e2e-` 접두어를 붙여 야간 정리 스크립트가 걸러낼 수 있다.
- 실패해도 trap 으로 생성 리소스 삭제를 시도한다.

## 로컬 문법/유효성 검증(AWS 불필요)
```bash
bash -n e2e/run-e2e.sh e2e/idempotency-test.sh e2e/lib/common.sh
for f in e2e/fixtures/sample-*/server.js; do node --check "$f"; done
# 검증기로 픽스처 카테고리 확인은 e2e/fixtures/README.md 참조.
```
