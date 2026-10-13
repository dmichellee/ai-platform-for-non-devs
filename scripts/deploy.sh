#!/usr/bin/env bash
#
# AppHub 설치 스크립트 — 멱등(idempotent). 같은 명령을 몇 번 실행해도 결과가 같다.
# [P] PLATFORM-ENGINEERING.md 4장 동작 그대로.
#
# 사용:
#   ./scripts/deploy.sh --stage dev|prod --domain <apps.example.com> \
#       [--frontend-mode public|private] \
#       [--hosted-zone-id <ZID>] [--region <region>] \
#       [--admin-email <email>] [--admin-name <name>] [--internal-cidrs "10.0.0.0/16,..."] [--skip-spa] \
#       [--sso-start-url <url> --sso-region <region> --sso-permission-set <name>]
#
# 환경 값(도메인/hostedZone/계정/리전)은 하드코딩하지 않고 여기서 주입한다(퍼블릭 애셋 — 설치자마다 다름):
#   - --domain          (필수) 사용자 앱 apex 도메인. prod/dev 공통 명시 지정(dev는 apps-dev.example.com 등).
#                       CDK context `-c domain=...`로 전달(1순위 소스).
#   - --hosted-zone-id  (선택) 미지정 시 Route53에서 `--domain`(및 상위 라벨)로 자동 조회.
#   - 계정/리전         CDK 표준(CDK_DEFAULT_ACCOUNT/CDK_DEFAULT_REGION) — aws 자격증명·--region에서 자동.
#
# 동작(몇 번을 실행해도 같은 결과):
#   1. 사전 점검(자격증명/리전/hosted zone/docker/node/cdk). 실패 시 아무것도 바꾸지 않고 종료.
#   2. cdk bootstrap (이미 되어 있으면 통과).
#      2c. (private 모드, D19) SPA 빌드 + Kiro zip → infra/console/site/ 준비 — 콘솔 이미지
#          (DockerImageAsset) 내용이므로 cdk deploy **앞**에서 한다.
#   3. cdk deploy apphub-{stage}-network apphub-{stage}-platform (변경 없으면 no-op).
#      이어서 provisioner 자산(검증기·CDK소스)과 (public 모드) Kiro 설정 zip을 자산 버킷 고정 키로 업로드.
#      3e. (D22) 기존 CodeCommit 저장소에 소유 태그 apphub:owner 백필(없는 것만, 실패 시 경고 후 계속).
#   4. 최초 관리자 계정 생성(존재하면 통과). public 모드: SPA 빌드 → config.json 생성 →
#      S3 sync → CloudFront invalidation(/* — kiro-config 포함). private 모드: 콘솔 컨테이너가
#      시작 시 config.json을 만든다(업로드 단계 없음).
#   5. 완료 출력(콘솔 주소 ConsoleUrl, 다음 단계).
set -euo pipefail

# ── 경로 ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
INFRA_DIR="${ROOT_DIR}/infra"
FRONTEND_DIR="${ROOT_DIR}/frontend"

# ── 기본값 / 인자 파싱 ──────────────────────────────────────────────────────
STAGE=""
REGION="ap-northeast-2"
APPS_DOMAIN=""          # --domain (필수). CDK context domain=... 의 원본.
HOSTED_ZONE_ID=""       # --hosted-zone-id (선택). 미지정 시 Route53 자동 조회.
ADMIN_EMAIL=""
ADMIN_NAME=""
INTERNAL_CIDRS=""
SKIP_SPA="false"
FRONTEND_MODE="public"  # --frontend-mode (D19). public | private
# D22 Git 인증(Identity Center) — 3개 모두 주면 활성, 일부만 주면 사전 점검에서 중단, 없으면 비활성.
SSO_START_URL=""
SSO_REGION=""
SSO_PERMISSION_SET=""

usage() {
  cat <<'USAGE'
사용법: deploy.sh --stage <dev|prod> --domain <apps.example.com> [옵션]
  --stage <dev|prod>          (필수) 배포 스테이지
  --domain <apps.example.com> (필수) 사용자 앱 apex 도메인. prod/dev 공통 명시 지정
                              (dev는 apps-dev.example.com 처럼 스테이지 도메인을 직접 지정).
  --hosted-zone-id <ZID>      (선택) 도메인의 Route53 public hosted zone ID.
                              미지정 시 --domain(및 상위 라벨)로 자동 조회.
  --region <region>           배포 리전 (기본: ap-northeast-2)
  --admin-email <email>       최초 관리자 이메일(존재하면 통과). 미지정 시 대화형 질문.
  --admin-name <name>         최초 관리자 표시 이름. 미지정 시 이메일 @ 앞부분을 사용.
  --frontend-mode <mode>      플랫폼 웹 배포 모드(기본 public). 두 모드 모두 콘솔 주소는
                              https://console.<domain>.
                                public : CloudFront + S3, API Gateway Regional
                                private: 사내 전용 — internal ALB + 컨테이너(nginx), Private API(VPC 엔드포인트).
                                         사무실 PC 접속에는 사내망-VPC 연결과 DNS 포워딩이 필요합니다
                                         (PLATFORM-ENGINEERING.md 5.2).
                              다른 값으로 다시 실행하면 모드가 전환됩니다.
  --internal-cidrs "a,b"      internal ALB(및 private 모드 콘솔·VPC 엔드포인트) ingress 허용 대역
                              (콤마 구분). 미지정 시 VPC CIDR.
  --skip-spa                  SPA 빌드/업로드 생략(인프라만 갱신할 때). private 모드에서는 이전에
                              준비된 콘솔 이미지 내용(infra/console/site)을 그대로 사용한다.
  Git 인증 설정(D22, 선택 — 3개 모두 주면 활성, 일부만 주면 오류). Identity Center 는 미리 준비
  (PLATFORM-ENGINEERING.md 5.4, IDENTITY-CENTER-SETUP.md). 주면 Kiro 설정 zip 에 PC 1회 설정기
  (setup-aws-git)와 apphub-aws.conf 가 들어간다. 계정 ID·CodeCommit 리전(--region)은 자동.
  --sso-start-url <url>       Identity Center 시작 URL (https://d-xxxxxxxxxx.awsapps.com/start)
  --sso-region <region>       Identity Center 리전 (AppHub 리전과 다를 수 있음)
  --sso-permission-set <name> 권한 세트 이름 (예: AppHubGit)

예:
  ./scripts/deploy.sh --stage prod --domain apps.example.com --admin-email admin@example.com
  ./scripts/deploy.sh --stage dev  --domain apps-dev.example.com --region us-east-1
  ./scripts/deploy.sh --stage prod --domain apps.example.com --frontend-mode private \
      --internal-cidrs "10.0.0.0/8"
  ./scripts/deploy.sh --stage prod --domain apps.example.com \
      --sso-start-url https://d-1234567890.awsapps.com/start --sso-region ap-northeast-2 \
      --sso-permission-set AppHubGit
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage)          STAGE="${2:-}"; shift 2 ;;
    --domain)         APPS_DOMAIN="${2:-}"; shift 2 ;;
    --hosted-zone-id) HOSTED_ZONE_ID="${2:-}"; shift 2 ;;
    --region)         REGION="${2:-}"; shift 2 ;;
    --admin-email)    ADMIN_EMAIL="${2:-}"; shift 2 ;;
    --admin-name)     ADMIN_NAME="${2:-}"; shift 2 ;;
    --internal-cidrs) INTERNAL_CIDRS="${2:-}"; shift 2 ;;
    --frontend-mode)  FRONTEND_MODE="${2:-}"; shift 2 ;;
    --skip-spa)       SKIP_SPA="true"; shift ;;
    --sso-start-url)      SSO_START_URL="${2:-}"; shift 2 ;;
    --sso-region)         SSO_REGION="${2:-}"; shift 2 ;;
    --sso-permission-set) SSO_PERMISSION_SET="${2:-}"; shift 2 ;;
    -h|--help)        usage; exit 0 ;;
    *) echo "알 수 없는 인자: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ "${STAGE}" != "dev" && "${STAGE}" != "prod" ]]; then
  echo "오류: --stage 는 dev 또는 prod 여야 합니다." >&2
  usage; exit 2
fi

if [[ "${FRONTEND_MODE}" != "public" && "${FRONTEND_MODE}" != "private" ]]; then
  echo "오류: --frontend-mode 는 public 또는 private 여야 합니다." >&2
  usage; exit 2
fi

if [[ -z "${APPS_DOMAIN}" ]]; then
  echo "오류: --domain 인자로 사용자 앱 도메인을 지정하세요(예: --domain apps.example.com)." >&2
  echo "      환경 값은 하드코딩하지 않습니다 — 설치자마다 다릅니다." >&2
  usage; exit 2
fi

# D22 Git 인증(Identity Center) 인자 검증 — 전부/없음 + 형식. AWS 호출 전에 막는다(사전 점검,
#  변경 전 검증 원칙). build-kiro-bundle.sh 도 같은 검증을 하지만 그 단계(2c/3c)는 늦다.
GIT_AUTH="false"
SSO_GIVEN=0
for v in "${SSO_START_URL}" "${SSO_REGION}" "${SSO_PERMISSION_SET}"; do
  [[ -n "${v}" ]] && SSO_GIVEN=$((SSO_GIVEN + 1))
done
if [[ "${SSO_GIVEN}" -eq 3 ]]; then
  if [[ ! "${SSO_START_URL}" =~ ^https://[^[:space:]]+$ ]]; then
    echo "오류: --sso-start-url 은 https:// 로 시작해야 합니다(예: https://d-1234567890.awsapps.com/start): ${SSO_START_URL}" >&2; exit 2
  fi
  if [[ ! "${SSO_REGION}" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]]; then
    echo "오류: --sso-region 형식이 올바르지 않습니다(예: ap-northeast-2): ${SSO_REGION}" >&2; exit 2
  fi
  if [[ ! "${SSO_PERMISSION_SET}" =~ ^[A-Za-z0-9+=,.@-]{1,32}$ ]]; then
    echo "오류: --sso-permission-set 은 영숫자와 +=,.@- 로 1~32자여야 합니다: ${SSO_PERMISSION_SET}" >&2; exit 2
  fi
  GIT_AUTH="true"
elif [[ "${SSO_GIVEN}" -ne 0 ]]; then
  echo "오류: --sso-start-url / --sso-region / --sso-permission-set 은 3개를 모두 주거나 모두 생략하세요." >&2
  echo "      (Git 인증 설정은 세 값이 모두 있어야 동작합니다 — PLATFORM-ENGINEERING.md 5.4)" >&2
  usage; exit 2
fi

PREFIX="apphub-${STAGE}"
NETWORK_STACK="${PREFIX}-network"
PLATFORM_STACK="${PREFIX}-platform"
CONSOLE_SITE_DIR="${INFRA_DIR}/console/site"

log()  { echo "[deploy] $*"; }
step() { echo; echo "===== $* ====="; }

# CDK 컨텍스트 인자 조립.
#  환경 값의 원본은 이 스크립트의 인자다(config.ts 하드코딩 제거 → 역방향 의존 제거).
#   -c domain=...     : --domain (필수). config 로더의 appsDomain 원본(1순위).
#   -c region=...     : --region. CDK 표준 CDK_DEFAULT_REGION 대신 명시 주입(자격증명 리전에 안 휘둘림).
#   -c allowedIngressCidrs=... : --internal-cidrs (선택).
#   -c hostedZoneId=... / -c account=... : 사전 점검 뒤(자동 조회/자격증명 확인 후) 아래에서 추가.
CDK_CTX=(-c "stage=${STAGE}" -c "domain=${APPS_DOMAIN}" -c "region=${REGION}" -c "frontendMode=${FRONTEND_MODE}")
if [[ -n "${INTERNAL_CIDRS}" ]]; then
  CDK_CTX+=(-c "allowedIngressCidrs=${INTERNAL_CIDRS}")
fi

# cdk 실행 헬퍼(infra 디렉토리에서 로컬 cdk 사용).
#  실패(rollback 포함)를 반드시 호출부로 전파한다. 서브셸 exit 코드를 명시적으로 되돌려주고,
#  호출부는 `|| { ...; exit 1; }`로 방어한다 — set -e가 서브셸/함수 경계에서 삼켜지는 셸
#  구현 차이에 의존하지 않는다. cd 자체 실패도 놓치지 않도록 서브셸 안에서 검사한다.
cdk_run() {
  ( cd "${INFRA_DIR}" || exit 1; pnpm exec cdk "$@" )
  return $?
}

# ── 1. 사전 점검 (변경 전 검증 — 실패 시 아무것도 바꾸지 않음) ─────────────────
step "1/5 사전 점검"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "오류: '$1' 명령을 찾을 수 없습니다. 설치 후 다시 시도하세요." >&2; exit 1; }
}
require_cmd aws
require_cmd node
require_cmd pnpm
require_cmd docker
# backend/build.sh 가 Lambda 자산 동기화에 rsync 를 쓴다(D-M8, 순수 boto3 — pip install 불필요).
require_cmd rsync
# build-kiro-bundle.sh 가 Kiro 설정 zip 을 만드는 데 zip 이 필요하다(3c 단계).
require_cmd zip

# Node 버전(>=22)
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "${NODE_MAJOR}" -lt 22 ]]; then
  echo "오류: Node >= 22 필요(현재 $(node -v))." >&2; exit 1
fi
log "Node $(node -v) OK"

# Docker 데몬(자산 번들링에 필요할 수 있음)
if ! docker info >/dev/null 2>&1; then
  echo "오류: Docker 데몬이 실행 중이 아닙니다. Docker Desktop 등을 켜고 다시 시도하세요." >&2; exit 1
fi
log "Docker 데몬 OK"

# AWS 자격 증명 + 계정 확인
if ! CALLER="$(aws sts get-caller-identity --output json 2>/dev/null)"; then
  echo "오류: AWS 자격 증명이 없습니다. 'aws configure' 또는 프로파일/환경변수를 설정하세요." >&2; exit 1
fi
ACCOUNT_ID="$(echo "${CALLER}" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).Account')"
log "AWS 계정 ${ACCOUNT_ID}, 리전 ${REGION} 자격 증명 OK"

# 환경 값을 CDK로 주입한다(하드코딩 제거 — 인자·자격증명이 원본).
#  account: CDK 표준 env(CDK_DEFAULT_ACCOUNT)로 넘긴다(bin/apphub.ts가 이를 읽음). context로도 명시해
#           자격증명 리전/계정에 안 휘둘리게 이중 보강.
#  region : 이미 CDK_CTX -c region 으로 넣었고, 표준 env도 맞춘다.
export CDK_DEFAULT_ACCOUNT="${ACCOUNT_ID}"
export CDK_DEFAULT_REGION="${REGION}"
CDK_CTX+=(-c "account=${ACCOUNT_ID}")

# hostedZoneId 해석 — 미지정 시 Route53에서 자동 조회.
#  apex 도출이 애매하므로(예: apps-dev.example.com → example.com), --domain 자체와 상위 라벨을
#  차례로 list-hosted-zones-by-name 으로 시도해 가장 먼저 매칭되는 public zone을 채택한다.
#  (route53는 글로벌 서비스라 --region 불필요.)
if [[ -z "${HOSTED_ZONE_ID}" ]]; then
  log "hosted zone 미지정 — '${APPS_DOMAIN}' 및 상위 도메인으로 Route53 자동 조회"
  candidate="${APPS_DOMAIN}"
  while [[ -n "${candidate}" && "${candidate}" == *.* ]]; do
    # list-hosted-zones-by-name: dns-name 사전순 시작점부터 반환. 정확히 그 zone(및 public)만 채택.
    ZONE_LINE="$(aws route53 list-hosted-zones-by-name --dns-name "${candidate}." --max-items 1 \
      --query "HostedZones[?Name=='${candidate}.'] | [?Config.PrivateZone==\`false\`].Id | [0]" \
      --output text 2>/dev/null || true)"
    if [[ -n "${ZONE_LINE}" && "${ZONE_LINE}" != "None" ]]; then
      # Id 형식 "/hostedzone/ZXXXX" → 마지막 토큰만.
      HOSTED_ZONE_ID="${ZONE_LINE##*/}"
      log "자동 조회 성공: '${candidate}' → hosted zone ${HOSTED_ZONE_ID}"
      break
    fi
    # 최상위 라벨을 떼고 상위 도메인으로 재시도(apps-dev.example.com → example.com).
    candidate="${candidate#*.}"
  done
  if [[ -z "${HOSTED_ZONE_ID}" ]]; then
    echo "오류: '${APPS_DOMAIN}'(및 상위 도메인)에 해당하는 Route53 public hosted zone을 찾지 못했습니다." >&2
    echo "      --hosted-zone-id <ZID> 로 직접 지정하거나, 해당 도메인의 public hosted zone을 계정에 두세요" >&2
    echo "      (와일드카드 인증서 DNS 검증에 필요, PLATFORM-ENGINEERING.md 5.1)." >&2
    exit 1
  fi
fi
CDK_CTX+=(-c "hostedZoneId=${HOSTED_ZONE_ID}")
log "앱 도메인 ${APPS_DOMAIN}, hosted zone ${HOSTED_ZONE_ID}"

# hosted zone 존재 확인 (전제조건 5.1) — 없으면 중단
if ! aws route53 get-hosted-zone --id "${HOSTED_ZONE_ID}" >/dev/null 2>&1; then
  echo "오류: Route53 hosted zone ${HOSTED_ZONE_ID} 를 찾을 수 없습니다." >&2
  echo "      와일드카드 인증서 DNS 검증에 필요합니다(PLATFORM-ENGINEERING.md 5.1)." >&2
  exit 1
fi
log "hosted zone 존재 확인 OK"

# 플랫폼 웹 배포 모드(D19) 사전 점검.
log "플랫폼 웹 배포 모드: ${FRONTEND_MODE} (콘솔 주소 https://console.${APPS_DOMAIN})"
if [[ "${FRONTEND_MODE}" == "private" ]]; then
  if [[ "${SKIP_SPA}" == "true" && ! -f "${CONSOLE_SITE_DIR}/index.html" ]]; then
    echo "오류: private 모드에서 --skip-spa 를 쓰려면 이전에 준비된 콘솔 내용(${CONSOLE_SITE_DIR}/index.html)이 있어야 합니다." >&2
    echo "      --skip-spa 없이 다시 실행하세요." >&2
    exit 1
  fi
  if [[ ! -d "${FRONTEND_DIR}" && "${SKIP_SPA}" != "true" ]]; then
    echo "오류: private 모드는 콘솔 이미지에 SPA를 담아야 하는데 frontend/ 디렉토리가 없습니다." >&2
    exit 1
  fi
  if [[ -z "${INTERNAL_CIDRS}" ]]; then
    log "참고: --internal-cidrs 미지정 — 콘솔·VPC 엔드포인트는 VPC 대역에서만 접근됩니다(사무실 대역을 지정하세요)."
  fi
fi

# D22 Git 인증 — 번들 인자 조립(계정 ID 확인 뒤). 인자 검증은 위(인자 파싱 직후)에서 끝났다.
GIT_AUTH_HINT=""
KIRO_SSO_ARGS=()
if [[ "${GIT_AUTH}" == "true" ]]; then
  KIRO_SSO_ARGS=(--sso-start-url "${SSO_START_URL}" --sso-region "${SSO_REGION}"
                 --sso-permission-set "${SSO_PERMISSION_SET}"
                 --account-id "${ACCOUNT_ID}" --codecommit-region "${REGION}")
  # 수동 재실행 안내용(3c 실패 시).
  GIT_AUTH_HINT=" --sso-start-url ${SSO_START_URL} --sso-region ${SSO_REGION} --sso-permission-set ${SSO_PERMISSION_SET} --account-id ${ACCOUNT_ID} --codecommit-region ${REGION}"
  log "Git 인증 설정: Identity Center 활성 (시작 URL ${SSO_START_URL}, IC 리전 ${SSO_REGION}, 권한 세트 ${SSO_PERMISSION_SET}, CodeCommit ${REGION})"
else
  log "Git 인증 설정: 비활성(--sso-* 미지정 — Kiro 번들에 코드 저장소 로그인 설정 미포함)"
fi

# ── 2. cdk bootstrap (이미 되어 있으면 통과) ─────────────────────────────────
step "2/5 cdk bootstrap"
if aws cloudformation describe-stacks --stack-name CDKToolkit --region "${REGION}" >/dev/null 2>&1; then
  log "CDKToolkit 이미 존재 — bootstrap 생략"
else
  log "CDKToolkit 없음 — bootstrap 실행"
  cdk_run bootstrap "aws://${ACCOUNT_ID}/${REGION}" "${CDK_CTX[@]}" \
    || { echo "오류: cdk bootstrap 실패. 중단합니다." >&2; exit 1; }
fi

# ── 2b. Lambda 자산 동기화(backend build) — cdk deploy 전에 자산 산출물 보장 ──
# D-M8: backend(Python)가 진실. backend/build.sh 가 app/ 를 각 Lambda 자산 디렉토리로 동기화하고
#  자산 루트에 handler.py shim(handler.handler)을 둔다. platform/network 스택이 이 경로를
#  lambda.Code.fromAsset + runtime=PYTHON_3_13 로 참조한다. 또한 검증기 2파일을 dist/validator/ 로
#  산출한다(3b 업로드). 순수 boto3(pip install 불필요) — 대상 디렉토리를 비우고 다시 채워 멱등.
step "2b/5 Lambda 자산 동기화 (backend build.sh)"
bash "${ROOT_DIR}/backend/build.sh" \
  || { echo "오류: backend 자산 동기화(build.sh) 실패. 중단합니다." >&2; exit 1; }
# API + task/wake/deploy-notify 6종 = 자산 7개 모두 handler.py(shim) + app/ 를 갖춰야 한다.
MISSING_ASSET=""
for name in api provision-task delete-task waker wake-restore sleep-transition deploy-notify; do
  if [[ ! -f "${INFRA_DIR}/lambda/${name}/handler.py" || ! -d "${INFRA_DIR}/lambda/${name}/app" ]]; then
    MISSING_ASSET="${MISSING_ASSET} ${name}"
  fi
done
if [[ -n "${MISSING_ASSET}" ]]; then
  echo "오류: backend build.sh 산출물 누락(handler.py + app/):${MISSING_ASSET}" >&2
  echo "      'bash backend/build.sh' 가 정상 완료됐는지 확인하세요." >&2
  exit 1
fi
log "Lambda 자산 7종 동기화 OK (api + provision-task/delete-task + waker/wake-restore/sleep-transition + deploy-notify)"

# ── 2c. (private 모드) 콘솔 이미지 내용 준비 — cdk deploy 앞 (D19) ─────────────
# private 모드의 콘솔은 CDK DockerImageAsset(infra/console/)으로 cdk deploy 중 빌드·push된다.
#  이미지에 SPA 정적 빌드 + Kiro zip을 담으므로 cdk deploy **전에** infra/console/site/ 를 채운다.
#  config.json은 이미지에 넣지 않는다(컨테이너 시작 시 env로 생성 — 스택 출력과의 순환 방지).
#  멱등: 내용이 같으면 자산 해시가 같아 이미지 재빌드·ECS 재배포가 일어나지 않는다.
#   - SPA: rsync --delete --checksum(내용 기준).
#   - Kiro zip: zip은 파일 시각을 담아 매번 바이트가 달라지므로, 항목 목록+내용이 같으면 기존 zip을 유지.
step "2c/5 콘솔 이미지 내용 준비 (frontend-mode=${FRONTEND_MODE})"
same_zip_content() {
  [[ -f "$1" && -f "$2" ]] || return 1
  [[ "$(unzip -Z1 "$1" | LC_ALL=C sort; unzip -p "$1" | shasum -a 256)" == \
     "$(unzip -Z1 "$2" | LC_ALL=C sort; unzip -p "$2" | shasum -a 256)" ]]
}
if [[ "${FRONTEND_MODE}" != "private" ]]; then
  log "public 모드 — 콘솔 이미지 없음(SPA는 4단계에서 S3 업로드)"
elif [[ "${SKIP_SPA}" == "true" ]]; then
  log "--skip-spa — 기존 콘솔 내용(${CONSOLE_SITE_DIR}) 그대로 사용"
else
  log "SPA 빌드 (frontend/)"
  ( cd "${FRONTEND_DIR}" && pnpm install --frozen-lockfile && pnpm build ) \
    || { echo "오류: SPA 빌드 실패. 중단합니다." >&2; exit 1; }
  if [[ ! -f "${FRONTEND_DIR}/dist/index.html" ]]; then
    echo "오류: SPA 빌드 산출물(frontend/dist/index.html)이 없습니다." >&2; exit 1
  fi
  mkdir -p "${CONSOLE_SITE_DIR}"
  rsync -a --delete --checksum \
    --exclude '.gitkeep' --exclude 'config.json' --exclude 'kiro-config/' \
    "${FRONTEND_DIR}/dist/" "${CONSOLE_SITE_DIR}/"
  log "SPA → ${CONSOLE_SITE_DIR} 동기화 OK"

  KIRO_TMP="$(mktemp -d -t apphub-kiro-XXXXXX)"
  if bash "${ROOT_DIR}/scripts/build-kiro-bundle.sh" --out-dir "${KIRO_TMP}" --region "${REGION}" \
       ${KIRO_SSO_ARGS[@]+"${KIRO_SSO_ARGS[@]}"} >/dev/null; then
    mkdir -p "${CONSOLE_SITE_DIR}/kiro-config"
    for z in kiro-config-mac.zip kiro-config-windows.zip; do
      if same_zip_content "${KIRO_TMP}/${z}" "${CONSOLE_SITE_DIR}/kiro-config/${z}"; then
        log "Kiro ${z} 변경 없음 — 기존 파일 유지"
      else
        cp "${KIRO_TMP}/${z}" "${CONSOLE_SITE_DIR}/kiro-config/${z}"
        log "Kiro ${z} 갱신"
      fi
    done
  else
    log "경고: Kiro 설정 zip 생성 실패 — 콘솔의 'Kiro 설정 다운로드'가 동작하지 않을 수 있습니다(배포는 계속)."
  fi
  rm -rf "${KIRO_TMP}"
fi

# ── 3. cdk deploy (network → platform, CFN이 멱등 보장) ──────────────────────
# 실패(스택 rollback 포함)는 반드시 스크립트 전체 non-zero exit로 전파한다.
#  --require-approval never 로 무인 진행하되, cdk가 non-zero로 끝나면(롤백/검증 실패 등)
#  `|| { ...; exit 1; }`로 즉시 중단 — 이후 관리자 생성/SPA 업로드 단계를 절대 밟지 않는다.
#  (과거: cdk 실패 후에도 스크립트가 exit 0으로 끝나던 버그. 명시 가드로 방어.)
step "3/5 스택 배포 (network → platform)"
cdk_run deploy "${NETWORK_STACK}" "${PLATFORM_STACK}" \
  "${CDK_CTX[@]}" \
  --require-approval never \
  --region "${REGION}" \
  || { echo "오류: cdk deploy 실패(스택 롤백 가능성). 이후 단계를 중단합니다." >&2; exit 1; }

# 배포 후 Outputs 조회 헬퍼
stack_output() {
  local stack="$1" key="$2"
  aws cloudformation describe-stacks --stack-name "${stack}" --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue" --output text 2>/dev/null
}

# Output이 없으면 aws CLI가 "None"을 출력한다 → 빈 문자열로 정규화.
out_or_empty() { local v; v="$(stack_output "$1" "$2")"; [[ "${v}" == "None" ]] && v=""; echo "${v}"; }
USER_POOL_ID="$(out_or_empty "${PLATFORM_STACK}" UserPoolId)"
USER_POOL_CLIENT_ID="$(out_or_empty "${PLATFORM_STACK}" UserPoolClientId)"
# D19: ApiUrl/CognitoIdpEndpoint는 모드별 실제 호출 주소(private = VPC 엔드포인트 전용 호스트명).
API_URL="$(out_or_empty "${PLATFORM_STACK}" ApiUrl)"
COGNITO_IDP_ENDPOINT="$(out_or_empty "${PLATFORM_STACK}" CognitoIdpEndpoint)"
CONSOLE_URL="$(out_or_empty "${PLATFORM_STACK}" ConsoleUrl)"
[[ -z "${CONSOLE_URL}" ]] && CONSOLE_URL="https://console.${APPS_DOMAIN}"
# SPA 버킷은 두 모드 공통(QA M-1 — private 모드에선 비어 있고 sync 생략). CloudFront는 public 모드만.
SPA_BUCKET="$(out_or_empty "${PLATFORM_STACK}" SpaBucketName)"
CF_DOMAIN="$(out_or_empty "${PLATFORM_STACK}" CloudFrontDomain)"
CF_DIST_ID="$(out_or_empty "${PLATFORM_STACK}" CloudFrontDistributionId)"
ASSETS_BUCKET="$(out_or_empty "${PLATFORM_STACK}" AssetsBucketName)"

# ── 3b. provisioner 자산 업로드 (D-M4-05 미해결 자산 주입) ────────────────────
# 앱 파이프라인 CodeBuild가 요구하는 자산을 플랫폼 자산 버킷의 고정 키로 업로드한다:
#   - 검증기(Python 2파일): s3://{assets}/validator/dockerfile_validator.py
#                           s3://{assets}/validator/dockerfile.py         (VALIDATOR_S3_URI=prefix)
#   - 플랫폼 CDK소스:        s3://{assets}/cdk-source/cdk-src.tgz          (CDK_SOURCE_S3_URI)
# platform-stack의 provisioner 프로젝트 env가 이 고정 S3 URI를 가리키므로(deploy와 동일 키),
#  업로드만 하면 provisioner→app-pipeline 배포 시 검증기/CDK소스가 신뢰 경계 안에서 주입된다.
step "3b/5 provisioner 자산 업로드 (검증기 · CDK 소스)"
if [[ -z "${ASSETS_BUCKET}" ]]; then
  log "AssetsBucketName Output 없음 — 자산 업로드 건너뜀(platform-stack에 자산 버킷 추가 필요)."
else
  # D-M8: 검증기는 backend/build.sh 가 산출한 dist/validator/ 의 2파일(자립 스크립트).
  VALIDATOR_DIR="${ROOT_DIR}/backend/dist/validator"
  if [[ ! -f "${VALIDATOR_DIR}/dockerfile_validator.py" || ! -f "${VALIDATOR_DIR}/dockerfile.py" ]]; then
    echo "오류: 검증기 자산이 불완전합니다(${VALIDATOR_DIR}/{dockerfile_validator.py,dockerfile.py})." >&2
    echo "      'bash backend/build.sh' 가 정상 완료됐는지 확인하세요." >&2
    exit 1
  fi
  log "검증기 자산 업로드 → s3://${ASSETS_BUCKET}/validator/ (dockerfile_validator.py, dockerfile.py)"
  aws s3 cp "${VALIDATOR_DIR}/dockerfile_validator.py" \
    "s3://${ASSETS_BUCKET}/validator/dockerfile_validator.py" --region "${REGION}"
  aws s3 cp "${VALIDATOR_DIR}/dockerfile.py" \
    "s3://${ASSETS_BUCKET}/validator/dockerfile.py" --region "${REGION}"

  # CDK 소스 tarball — app-* construct 배포에 필요한 최소 소스(infra + backend + 루트 매니페스트).
  #  provisioner/deploy 빌드는 이 tarball을 풀고 `pnpm install`(CDK 툴체인) 후 `cdk deploy app-*` 한다.
  #  app-pipeline/app-runtime construct는 buildspec 자산(infra/buildspec/*.yml)만 참조하고
  #  플랫폼 Lambda 자산(infra/lambda/*, Python)은 참조하지 않으므로 tarball에 없어도 무방하다.
  #  node_modules/dist/.git 등은 제외(provisioner가 pnpm install로 복원). 재현 가능하게 정렬.
  #  frontend는 tar 대상에 포함하지 않으므로(app 배포와 무관) 빌드 산출물이 tarball에 들어가지 않는다.
  #  backend(Python)는 pyproject.toml/app/이 들어가나 dist/는 `**/dist` 제외로 빠진다(무해).
  log "CDK 소스 tarball 생성·업로드 → s3://${ASSETS_BUCKET}/cdk-source/cdk-src.tgz"
  CDK_TARBALL="$(mktemp -t apphub-cdk-src-XXXXXX.tgz)"
  tar -czf "${CDK_TARBALL}" -C "${ROOT_DIR}" \
    --exclude='**/node_modules' \
    --exclude='**/dist' \
    --exclude='.git' \
    --exclude='**/cdk.out' \
    --exclude='infra/console/site' \
    infra backend package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json
  aws s3 cp "${CDK_TARBALL}" "s3://${ASSETS_BUCKET}/cdk-source/cdk-src.tgz" --region "${REGION}"
  rm -f "${CDK_TARBALL}"
  log "provisioner 자산 업로드 OK"
fi

# ── 3c. Kiro 설정 zip 자동 빌드·업로드 (P-M7-01) ─────────────────────────────
# 프론트 "Kiro 설정 다운로드"가 서빙하는 OS별 정적 zip 2개를 자산 버킷 고정 키로 올린다:
#   s3://{AssetsBucketName}/kiro-config/kiro-config-mac.zip
#   s3://{AssetsBucketName}/kiro-config/kiro-config-windows.zip
# CloudFront `/kiro-config/*` behavior(P-M7-01, 와일드카드)가 두 오브젝트를 모두 서빙한다. 과거에는 수동
#  (build-kiro-bundle.sh --upload)이라 새 환경 배포 시 zip이 없어 다운로드가 깨졌다 → 자동화.
# 멱등: build-kiro-bundle.sh 는 두 zip을 결정적으로 재생성하고 동일 고정 키를 덮어쓴다(재실행 안전).
# 실패 방침(경고+계속): kiro zip 업로드 실패는 "Kiro 설정 다운로드" 페이지만 깨뜨릴 뿐
#  플랫폼 자체 기동에는 영향이 없으므로 전체 배포를 중단하지 않는다. 대신 명확히 경고하고
#  사용자에게 수동 재실행 방법을 안내한다(배포 exit 코드는 성공 유지).
step "3c/5 Kiro 설정 zip 자동 업로드 (build-kiro-bundle.sh --upload)"
KIRO_UPLOAD_OK="false"
if [[ "${FRONTEND_MODE}" == "private" ]]; then
  # private 모드: zip은 콘솔 이미지(nginx /kiro-config/*)에 이미 담겼다(2c). CloudFront가 없어 업로드 불필요.
  [[ -f "${CONSOLE_SITE_DIR}/kiro-config/kiro-config-mac.zip" ]] && KIRO_UPLOAD_OK="true"
  log "private 모드 — Kiro zip은 콘솔 이미지에 포함(업로드 생략)"
elif [[ -z "${ASSETS_BUCKET}" ]]; then
  log "경고: AssetsBucketName Output 없음 — Kiro 설정 zip 업로드 건너뜀."
elif bash "${ROOT_DIR}/scripts/build-kiro-bundle.sh" --upload --stage "${STAGE}" --region "${REGION}" --assets-bucket "${ASSETS_BUCKET}" \
       ${KIRO_SSO_ARGS[@]+"${KIRO_SSO_ARGS[@]}"}; then
  KIRO_UPLOAD_OK="true"
  log "Kiro 설정 zip 업로드 OK → s3://${ASSETS_BUCKET}/kiro-config/{kiro-config-mac.zip, kiro-config-windows.zip}"
else
  log "경고: Kiro 설정 zip 업로드 실패 — 배포는 계속합니다."
  log "      다운로드 페이지가 깨질 수 있으니 아래를 수동 실행하세요:"
  log "      bash scripts/build-kiro-bundle.sh --upload --stage ${STAGE} --region ${REGION}${GIT_AUTH_HINT}"
fi

# ── 3d. 기본 권한 템플릿 시드 (DESIGN D7 "기본 = 권한 없음") ─────────────────
# 마법사 "앱 유형"의 첫 선택지 '기본'이 어디서도 시드되지 않아 목록이 비는 문제 방지.
# 멱등: attribute_not_exists 조건부 생성만 — 관리자가 이미 수정/삭제했다면 존중(덮어쓰기 금지).
# 빈 Statement 정책은 app-runtime construct가 "정책 attach 생략"으로 처리(permissionPolicy 비었으면 skip).
step "3d/5 기본 권한 템플릿 시드 (없을 때만)"
TABLE_NAME="apphub-${STAGE}-main"
if aws dynamodb put-item \
    --table-name "${TABLE_NAME}" --region "${REGION}" \
    --item '{
      "PK": {"S": "CONFIG"}, "SK": {"S": "PERM#default"},
      "entityType": {"S": "PermissionTemplate"},
      "permId": {"S": "default"},
      "displayName": {"S": "기본 (추가 권한 없음)"},
      "policyDocument": {"M": {"Version": {"S": "2012-10-17"}, "Statement": {"L": []}}}
    }' \
    --condition-expression "attribute_not_exists(PK)" >/dev/null 2>&1; then
  log "기본 권한 템플릿(PERM#default) 시드 완료"
else
  log "기본 권한 템플릿 이미 존재(또는 조건 불충족) — 생성 생략"
fi

# ── 3e. CodeCommit 저장소 소유 태그 백필 (D22) ──────────────────────────────
# D22 이전에 AppHub로 만든 저장소에는 소유 태그 apphub:owner 가 없어 Identity Center 권한 세트의
#  ABAC 조건(ResourceTag/apphub:owner == PrincipalTag/email)에 걸려 git 접근이 거부된다.
#  DDB 소유권(CCREPO#) → Cognito email(소문자) 로 **없는 것만** 채운다(멱등, 있으면 건드리지 않음).
#  Git 인증 활성 여부와 무관하게 매 실행 수행(태그는 무해, 나중에 활성화해도 바로 쓰이도록).
#  실패 방침(경고+계속): 태그 누락은 해당 저장소의 git 접근만 막을 뿐 플랫폼 기동과 무관.
step "3e/5 CodeCommit 저장소 소유 태그 백필 (없는 것만)"
if [[ -z "${USER_POOL_ID}" ]]; then
  log "경고: UserPoolId Output 없음 — 소유 태그 백필 건너뜀."
elif bash "${ROOT_DIR}/scripts/backfill-repo-owner-tags.sh" \
       --table "${TABLE_NAME}" --user-pool-id "${USER_POOL_ID}" --region "${REGION}" --account-id "${ACCOUNT_ID}"; then
  log "소유 태그 백필 OK"
else
  log "경고: 소유 태그 백필 실패 — 설치는 계속합니다. 다시 실행하려면:"
  log "      bash scripts/backfill-repo-owner-tags.sh --table ${TABLE_NAME} --user-pool-id ${USER_POOL_ID} --region ${REGION}"
fi

# ── 4. 최초 관리자(존재하면 통과) + SPA 업로드 ───────────────────────────────
step "4/5 최초 관리자 + SPA 업로드(public 모드)"

# 4a. 최초 관리자 — admin-get-user로 존재 확인 후 없을 때만 생성 (멱등)
if [[ -z "${ADMIN_EMAIL}" ]]; then
  # 대화형(비대화형 CI에서는 건너뜀)
  if [[ -t 0 ]]; then
    read -r -p "최초 관리자 이메일(엔터 시 건너뜀): " ADMIN_EMAIL || true
  fi
fi

if [[ -n "${ADMIN_EMAIL}" && -n "${USER_POOL_ID}" ]]; then
  if aws cognito-idp admin-get-user \
      --user-pool-id "${USER_POOL_ID}" --username "${ADMIN_EMAIL}" \
      --region "${REGION}" >/dev/null 2>&1; then
    log "관리자 ${ADMIN_EMAIL} 이미 존재 — 생성 생략"
  else
    log "관리자 ${ADMIN_EMAIL} 생성(임시 비밀번호 이메일 발송)"
    # 표시 이름(name): --admin-name 지정 시 그 값, 미지정 시 이메일 @ 앞부분.
    #  idToken name 클레임으로 이름 표시가 되게 하려면 최초 생성 시부터 name 속성이 있어야 한다.
    ADMIN_DISPLAY_NAME="${ADMIN_NAME}"
    if [[ -z "${ADMIN_DISPLAY_NAME}" ]]; then
      ADMIN_DISPLAY_NAME="${ADMIN_EMAIL%%@*}"
    fi
    aws cognito-idp admin-create-user \
      --user-pool-id "${USER_POOL_ID}" \
      --username "${ADMIN_EMAIL}" \
      --user-attributes "Name=email,Value=${ADMIN_EMAIL}" "Name=email_verified,Value=true" "Name=name,Value=${ADMIN_DISPLAY_NAME}" \
      --desired-delivery-mediums EMAIL \
      --region "${REGION}" >/dev/null
    # admin 그룹에 추가(멱등: 이미 속해 있으면 no-op)
    aws cognito-idp admin-add-user-to-group \
      --user-pool-id "${USER_POOL_ID}" \
      --username "${ADMIN_EMAIL}" \
      --group-name admin \
      --region "${REGION}" >/dev/null
    log "관리자 ${ADMIN_EMAIL} 를 admin 그룹에 추가"
  fi
else
  log "관리자 이메일 미지정 — 관리자 생성 건너뜀(나중에 --admin-email 로 재실행 가능)"
fi

# 4b. SPA 업로드 (frontend/ — M6 SPA). aws s3 sync --delete 는 자체 멱등.
#  프론트는 런타임 config.json으로 Cognito/API 값을 주입받는다(D-M6-03). 그래서 빌드 산출물
#  (frontend/dist)에 stack-outputs로 만든 config.json을 함께 넣고 통째로 sync 한다.
if [[ "${FRONTEND_MODE}" == "private" ]]; then
  log "private 모드 — SPA는 콘솔 컨테이너 이미지로 배포됨(S3 업로드 없음, config.json은 컨테이너가 생성)"
elif [[ "${SKIP_SPA}" == "true" ]]; then
  log "--skip-spa — SPA 업로드 건너뜀"
elif [[ -z "${SPA_BUCKET}" ]]; then
  log "SPA 버킷 출력 없음 — SPA 업로드 건너뜀"
elif [[ ! -d "${FRONTEND_DIR}" ]]; then
  log "frontend/ 디렉토리 없음 — SPA 업로드 건너뜀"
else
  log "SPA 빌드 (frontend/)"
  ( cd "${FRONTEND_DIR}" && pnpm install --frozen-lockfile && pnpm build )
  SPA_DIST="${FRONTEND_DIR}/dist"
  if [[ -d "${SPA_DIST}" ]]; then
    # config.json 생성 — frontend/src/lib/config.ts(RuntimeConfig) 스키마(계약 delta §9.1)를 따른다.
    #  apiUrl/userPoolId/userPoolClientId가 모두 있으면 실서비스(mock=false), 아니면 목 모드로 둔다.
    #  D21: 로그인은 cognito-idp 직접 호출 → cognitoIdpEndpoint. cognitoDomain(Hosted UI)은 더 이상 넣지 않는다.
    #  private 모드 콘솔 컨테이너(infra/console/40-apphub-config.sh)가 만드는 형식과 동일하다.
    log "config.json 생성 → ${SPA_DIST}/config.json"
    CONFIG_OUT="${SPA_DIST}/config.json" \
    CFG_API_URL="${API_URL}" \
    CFG_USER_POOL_ID="${USER_POOL_ID}" \
    CFG_USER_POOL_CLIENT_ID="${USER_POOL_CLIENT_ID}" \
    CFG_COGNITO_IDP_ENDPOINT="${COGNITO_IDP_ENDPOINT}" \
    CFG_REGION="${REGION}" \
    CFG_STAGE="${STAGE}" \
    CFG_APPS_DOMAIN="${APPS_DOMAIN}" \
    CFG_FRONTEND_MODE="${FRONTEND_MODE}" \
    node -e '
      const fs = require("fs");
      const s = (k) => (process.env[k] && process.env[k] !== "None") ? process.env[k] : "";
      const apiUrl = s("CFG_API_URL");
      const userPoolId = s("CFG_USER_POOL_ID");
      const userPoolClientId = s("CFG_USER_POOL_CLIENT_ID");
      const region = s("CFG_REGION");
      const cfg = {
        apiUrl,
        userPoolId,
        userPoolClientId,
        region,
        cognitoIdpEndpoint: s("CFG_COGNITO_IDP_ENDPOINT") || `https://cognito-idp.${region}.amazonaws.com/`,
        appsDomain: s("CFG_APPS_DOMAIN"),
        stage: s("CFG_STAGE"),
        // D16: 플랫폼 웹 배포 모드 — private이면 프론트가 로그인 보호 토글을 비활성(백엔드도 거부).
        frontendMode: s("CFG_FRONTEND_MODE") === "private" ? "private" : "public",
        mock: !(apiUrl && userPoolId && userPoolClientId),
      };
      fs.writeFileSync(process.env.CONFIG_OUT, JSON.stringify(cfg, null, 2) + "\n");
    '
    if [[ -z "${API_URL}" || -z "${USER_POOL_ID}" || -z "${USER_POOL_CLIENT_ID}" ]]; then
      log "경고: ApiUrl/UserPoolId/UserPoolClientId 중 일부가 비어 config.json이 목 모드(mock=true)로 생성됨."
    fi
    log "S3 sync → s3://${SPA_BUCKET}"
    aws s3 sync "${SPA_DIST}" "s3://${SPA_BUCKET}" --delete --region "${REGION}"
    if [[ -n "${CF_DIST_ID}" ]]; then
      log "CloudFront invalidation"
      aws cloudfront create-invalidation --distribution-id "${CF_DIST_ID}" \
        --paths "/*" >/dev/null
    fi
  else
    log "frontend/dist 없음 — 빌드 산출물이 없어 업로드 건너뜀"
  fi
fi

# ── 5. 완료 출력 ────────────────────────────────────────────────────────────
step "5/5 완료"
echo
echo "AppHub(${STAGE}) 설치 완료."
echo "  콘솔 주소       : ${CONSOLE_URL}"
echo "  웹 배포 모드    : ${FRONTEND_MODE}"
echo "  앱 도메인       : *.${APPS_DOMAIN}"
echo "  User Pool       : ${USER_POOL_ID:-<n/a>}"
if [[ "${KIRO_UPLOAD_OK}" == "true" ]]; then
  echo "  Kiro 설정(Mac)     : ${CONSOLE_URL}/kiro-config/kiro-config-mac.zip"
  echo "  Kiro 설정(Windows) : ${CONSOLE_URL}/kiro-config/kiro-config-windows.zip"
else
  echo "  Kiro 설정(Mac)     : ${CONSOLE_URL}/kiro-config/kiro-config-mac.zip"
  echo "  Kiro 설정(Windows) : ${CONSOLE_URL}/kiro-config/kiro-config-windows.zip"
  if [[ "${FRONTEND_MODE}" == "private" ]]; then
    echo "                       (경고: Kiro zip이 콘솔 이미지에 없습니다 — deploy.sh를 --skip-spa 없이 다시 실행하세요)"
  else
    echo "                       (경고: 자동 업로드 실패 — 'bash scripts/build-kiro-bundle.sh --upload --stage ${STAGE} --region ${REGION}${GIT_AUTH_HINT}' 수동 실행 필요)"
  fi
fi
if [[ "${GIT_AUTH}" == "true" ]]; then
  echo "  Git 인증        : Identity Center(권한 세트 ${SSO_PERMISSION_SET}) 활성"
else
  echo "  Git 인증        : 비활성"
fi
if [[ "${FRONTEND_MODE}" == "public" ]]; then
  echo "  (참고) 콘솔 인증서 발급·DNS 전파에 수 분이 걸릴 수 있습니다."
else
  echo "  (참고) private 모드 콘솔은 사내망에서만 열립니다 — 사내망-VPC 연결과 '${APPS_DOMAIN}' DNS 포워딩이"
  echo "         필요합니다(PLATFORM-ENGINEERING.md 5.2). 앱 '로그인한 사람만 접근'은 공용 로그인 도메인을 경유합니다."
fi
echo
echo "다음 단계:"
echo "  1) 콘솔에 관리자 계정으로 로그인 → 소스 provider(CodeCommit/GitHub/GitLab) 활성화."
echo "  2) 컴퓨팅 프리셋·권한 템플릿 정의."
