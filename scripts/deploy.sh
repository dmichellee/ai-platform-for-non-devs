#!/usr/bin/env bash
#
# AppHub 설치 스크립트 — 멱등(idempotent). 같은 명령을 몇 번 실행해도 결과가 같다.
# [P] PLATFORM-ENGINEERING.md 4장 동작 그대로.
#
# 사용:
#   ./scripts/deploy.sh --stage dev|prod [--region <region>] \
#       [--admin-email <email>] [--admin-name <name>] [--internal-cidrs "10.0.0.0/16,..."] [--skip-spa]
#
# 동작(몇 번을 실행해도 같은 결과):
#   1. 사전 점검(자격증명/리전/hosted zone/docker/node/cdk). 실패 시 아무것도 바꾸지 않고 종료.
#   2. cdk bootstrap (이미 되어 있으면 통과).
#   3. cdk deploy apphub-{stage}-network apphub-{stage}-platform (변경 없으면 no-op).
#   4. 최초 관리자 계정 생성(존재하면 통과), SPA(frontend/) 빌드 → config.json 생성 →
#      S3 sync → CloudFront invalidation.
#   5. 완료 출력(웹 URL, 다음 단계).
set -euo pipefail

# ── 경로 ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
INFRA_DIR="${ROOT_DIR}/infra"
FRONTEND_DIR="${ROOT_DIR}/frontend"

# ── 기본값 / 인자 파싱 ──────────────────────────────────────────────────────
STAGE=""
REGION="ap-northeast-2"
ADMIN_EMAIL=""
ADMIN_NAME=""
INTERNAL_CIDRS=""
SKIP_SPA="false"

usage() {
  cat <<'USAGE'
사용법: deploy.sh --stage <dev|prod> [옵션]
  --stage <dev|prod>          (필수) 배포 스테이지
  --region <region>           배포 리전 (기본: ap-northeast-2)
  --admin-email <email>       최초 관리자 이메일(존재하면 통과). 미지정 시 대화형 질문.
  --admin-name <name>         최초 관리자 표시 이름. 미지정 시 이메일 @ 앞부분을 사용.
  --internal-cidrs "a,b"      internal ALB ingress 허용 대역(콤마 구분). 미지정 시 VPC CIDR.
  --skip-spa                  SPA 빌드/업로드 생략(인프라만 갱신할 때)
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage)          STAGE="${2:-}"; shift 2 ;;
    --region)         REGION="${2:-}"; shift 2 ;;
    --admin-email)    ADMIN_EMAIL="${2:-}"; shift 2 ;;
    --admin-name)     ADMIN_NAME="${2:-}"; shift 2 ;;
    --internal-cidrs) INTERNAL_CIDRS="${2:-}"; shift 2 ;;
    --skip-spa)       SKIP_SPA="true"; shift ;;
    -h|--help)        usage; exit 0 ;;
    *) echo "알 수 없는 인자: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ "${STAGE}" != "dev" && "${STAGE}" != "prod" ]]; then
  echo "오류: --stage 는 dev 또는 prod 여야 합니다." >&2
  usage; exit 2
fi

PREFIX="apphub-${STAGE}"
NETWORK_STACK="${PREFIX}-network"
PLATFORM_STACK="${PREFIX}-platform"

log()  { echo "[deploy] $*"; }
step() { echo; echo "===== $* ====="; }

# CDK 컨텍스트 인자 조립(-c stage=..., 선택적으로 allowedIngressCidrs)
CDK_CTX=(-c "stage=${STAGE}")
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

# 스테이지별 도메인/hosted zone 조회 — config.ts를 단일 원본으로 신뢰(중복 리터럴 금지)
CONFIG_JSON="$(
  cd "${INFRA_DIR}" && pnpm exec node -e "
    const { loadConfig } = require('./lib/config');
    process.stdout.write(JSON.stringify(loadConfig('${STAGE}')));
  " 2>/dev/null || true
)"
if [[ -z "${CONFIG_JSON}" ]]; then
  # ts 소스인 경우 ts-node로 로드
  CONFIG_JSON="$(
    cd "${INFRA_DIR}" && pnpm exec ts-node -e "
      import { loadConfig } from './lib/config';
      process.stdout.write(JSON.stringify(loadConfig('${STAGE}')));
    " 2>/dev/null || true
  )"
fi
if [[ -z "${CONFIG_JSON}" ]]; then
  echo "오류: infra/lib/config.ts 에서 스테이지 설정을 로드하지 못했습니다." >&2; exit 1
fi
APPS_DOMAIN="$(echo "${CONFIG_JSON}" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).appsDomain')"
HOSTED_ZONE_ID="$(echo "${CONFIG_JSON}" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).hostedZoneId')"
log "앱 도메인 ${APPS_DOMAIN}, hosted zone ${HOSTED_ZONE_ID}"

# hosted zone 존재 확인 (전제조건 5.1) — 없으면 중단
if ! aws route53 get-hosted-zone --id "${HOSTED_ZONE_ID}" >/dev/null 2>&1; then
  echo "오류: Route53 hosted zone ${HOSTED_ZONE_ID} 를 찾을 수 없습니다." >&2
  echo "      와일드카드 인증서 DNS 검증에 필요합니다(PLATFORM-ENGINEERING.md 5.1)." >&2
  exit 1
fi
log "hosted zone 존재 확인 OK"

# ── 2. cdk bootstrap (이미 되어 있으면 통과) ─────────────────────────────────
step "2/5 cdk bootstrap"
if aws cloudformation describe-stacks --stack-name CDKToolkit --region "${REGION}" >/dev/null 2>&1; then
  log "CDKToolkit 이미 존재 — bootstrap 생략"
else
  log "CDKToolkit 없음 — bootstrap 실행"
  cdk_run bootstrap "aws://${ACCOUNT_ID}/${REGION}" "${CDK_CTX[@]}" \
    || { echo "오류: cdk bootstrap 실패. 중단합니다." >&2; exit 1; }
fi

# ── 2b. API Lambda 번들(backend build) — cdk deploy 전에 자산 산출물 보장 ────
# D-M3-01/02: backend/src가 진실. tsup이 infra/lambda/api/index.mjs 로 번들하고
#  platform-stack이 이 경로를 lambda.Code.fromAsset 로 참조한다. 재실행 안전(clean 후 재빌드).
step "2b/5 API Lambda 번들 (backend build)"
( cd "${ROOT_DIR}/backend" && pnpm install --frozen-lockfile && pnpm build ) \
  || { echo "오류: backend 빌드(pnpm install/build) 실패. 중단합니다." >&2; exit 1; }
if [[ ! -f "${INFRA_DIR}/lambda/api/index.mjs" ]]; then
  echo "오류: backend build 산출물(infra/lambda/api/index.mjs)이 없습니다." >&2
  echo "      'pnpm -C backend build' 가 정상 완료됐는지 확인하세요." >&2
  exit 1
fi
log "API Lambda 자산 번들 OK (infra/lambda/api/index.mjs)"

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

USER_POOL_ID="$(stack_output "${PLATFORM_STACK}" UserPoolId)"
USER_POOL_CLIENT_ID="$(stack_output "${PLATFORM_STACK}" UserPoolClientId)"
API_URL="$(stack_output "${PLATFORM_STACK}" ApiUrl)"
SPA_BUCKET="$(stack_output "${PLATFORM_STACK}" SpaBucketName)"
CF_DOMAIN="$(stack_output "${PLATFORM_STACK}" CloudFrontDomain)"
CF_DIST_ID="$(stack_output "${PLATFORM_STACK}" CloudFrontDistributionId)"
ASSETS_BUCKET="$(stack_output "${PLATFORM_STACK}" AssetsBucketName)"

# Cognito Hosted UI 도메인은 Output이 아니라 SSM(user-pool-domain)에 있다(단일 원본).
#  config.json의 cognitoDomain(옵션)에 넣어 프론트가 Hosted UI code grant를 쓸 수 있게 한다.
ssm_param() {
  aws ssm get-parameter --name "$1" --region "${REGION}" \
    --query "Parameter.Value" --output text 2>/dev/null || true
}
COGNITO_DOMAIN="$(ssm_param "/apphub/${STAGE}/platform/user-pool-domain")"

# ── 3b. provisioner 자산 업로드 (D-M4-05 미해결 자산 주입) ────────────────────
# 앱 파이프라인 CodeBuild가 요구하는 두 자산을 플랫폼 자산 버킷의 고정 키로 업로드한다:
#   - 검증기 번들:  s3://{assets}/validator/dockerfile-validator.mjs  (VALIDATOR_S3_URI)
#   - 플랫폼 CDK소스: s3://{assets}/cdk-source/cdk-src.tgz            (CDK_SOURCE_S3_URI)
# platform-stack의 provisioner 프로젝트 env가 이 고정 S3 URI를 가리키므로(deploy와 동일 키),
#  업로드만 하면 provisioner→app-pipeline 배포 시 검증기/CDK소스가 신뢰 경계 안에서 주입된다.
step "3b/5 provisioner 자산 업로드 (검증기 · CDK 소스)"
if [[ -z "${ASSETS_BUCKET}" ]]; then
  log "AssetsBucketName Output 없음 — 자산 업로드 건너뜀(platform-stack에 자산 버킷 추가 필요)."
else
  VALIDATOR_BUNDLE="${ROOT_DIR}/backend/dist/dockerfile-validator.mjs"
  if [[ ! -f "${VALIDATOR_BUNDLE}" ]]; then
    echo "오류: 검증기 번들이 없습니다(${VALIDATOR_BUNDLE}). 'pnpm -C backend build' 확인." >&2
    exit 1
  fi
  log "검증기 번들 업로드 → s3://${ASSETS_BUCKET}/validator/dockerfile-validator.mjs"
  aws s3 cp "${VALIDATOR_BUNDLE}" "s3://${ASSETS_BUCKET}/validator/dockerfile-validator.mjs" \
    --region "${REGION}"

  # CDK 소스 tarball — app-* construct 배포에 필요한 최소 소스(infra + backend + 루트 매니페스트).
  #  node_modules/dist/.git 등은 제외(provisioner가 pnpm install로 복원). 재현 가능하게 정렬.
  #  frontend는 tar 대상에 포함하지 않으므로(app 배포와 무관) 빌드 산출물이 tarball에 들어가지 않는다.
  #  소스는 infra/backend만 포함. `**/dist` 제외로 어떤 dist도 tarball에 들어가지 않음.
  log "CDK 소스 tarball 생성·업로드 → s3://${ASSETS_BUCKET}/cdk-source/cdk-src.tgz"
  CDK_TARBALL="$(mktemp -t apphub-cdk-src-XXXXXX.tgz)"
  tar -czf "${CDK_TARBALL}" -C "${ROOT_DIR}" \
    --exclude='**/node_modules' \
    --exclude='**/dist' \
    --exclude='.git' \
    --exclude='**/cdk.out' \
    infra backend package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json
  aws s3 cp "${CDK_TARBALL}" "s3://${ASSETS_BUCKET}/cdk-source/cdk-src.tgz" --region "${REGION}"
  rm -f "${CDK_TARBALL}"
  log "provisioner 자산 업로드 OK"
fi

# ── 4. 최초 관리자(존재하면 통과) + SPA 업로드 ───────────────────────────────
step "4/5 최초 관리자 + SPA 업로드"

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
if [[ "${SKIP_SPA}" == "true" ]]; then
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
    # config.json 생성 — frontend/src/lib/config.ts(RuntimeConfig) 스키마를 따른다.
    #  apiUrl/userPoolId/userPoolClientId가 모두 있으면 실서비스(mock=false), 아니면 목 모드로 둔다.
    log "config.json 생성 → ${SPA_DIST}/config.json"
    CONFIG_OUT="${SPA_DIST}/config.json" \
    CFG_API_URL="${API_URL}" \
    CFG_USER_POOL_ID="${USER_POOL_ID}" \
    CFG_USER_POOL_CLIENT_ID="${USER_POOL_CLIENT_ID}" \
    CFG_COGNITO_DOMAIN="${COGNITO_DOMAIN}" \
    CFG_REGION="${REGION}" \
    CFG_STAGE="${STAGE}" \
    node -e '
      const fs = require("fs");
      const s = (k) => (process.env[k] && process.env[k] !== "None") ? process.env[k] : "";
      const apiUrl = s("CFG_API_URL");
      const userPoolId = s("CFG_USER_POOL_ID");
      const userPoolClientId = s("CFG_USER_POOL_CLIENT_ID");
      const cognitoDomain = s("CFG_COGNITO_DOMAIN");
      const cfg = {
        apiUrl,
        userPoolId,
        userPoolClientId,
        region: s("CFG_REGION"),
        stage: s("CFG_STAGE"),
        mock: !(apiUrl && userPoolId && userPoolClientId),
      };
      if (cognitoDomain) cfg.cognitoDomain = cognitoDomain;
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
[[ -n "${CF_DOMAIN}" ]] && echo "  웹 URL          : https://${CF_DOMAIN}"
echo "  앱 도메인       : *.${APPS_DOMAIN}"
echo "  User Pool       : ${USER_POOL_ID:-<n/a>}"
[[ -n "${CF_DOMAIN}" ]] && echo "  Kiro 설정 다운로드 : https://${CF_DOMAIN}/kiro-config/kiro-config.zip (build-kiro-bundle.sh --upload 후)"
echo
echo "다음 단계:"
echo "  1) 관리자 화면에서 VPC 등록(서로 다른 AZ 서브넷 2개 + 이미지 pull 경로)."
echo "  2) 소스 provider(CodeCommit/GitHub/GitLab) 활성화."
echo "  3) 컴퓨팅 프리셋·권한 템플릿 정의."
