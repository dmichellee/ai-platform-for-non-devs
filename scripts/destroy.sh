#!/usr/bin/env bash
#
# AppHub 제거 스크립트 — 앱 스택부터 역순 삭제(PLATFORM-ENGINEERING.md 4장).
# 배포의 역순: (앱 스택들) → platform → network.
#
# 사용:
#   ./scripts/destroy.sh --stage dev|prod [--region <region>] [--yes]
#
# 주의:
#   - prod 는 데이터 유실 방지를 위해 대화형 확인을 강제한다(--yes 로만 우회).
#   - 앱(app-*) 스택은 원칙적으로 플랫폼에서 앱 삭제 흐름으로 제거되지만,
#     여기서는 잔여 app-* 스택이 있으면 platform/network 보다 먼저 삭제한다.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
INFRA_DIR="${ROOT_DIR}/infra"

STAGE=""
REGION="ap-northeast-2"
ASSUME_YES="false"

usage() {
  cat <<'USAGE'
사용법: destroy.sh --stage <dev|prod> [옵션]
  --stage <dev|prod>   (필수) 대상 스테이지
  --region <region>    리전 (기본: ap-northeast-2)
  --yes                확인 프롬프트 없이 진행
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage)  STAGE="${2:-}"; shift 2 ;;
    --region) REGION="${2:-}"; shift 2 ;;
    --yes)    ASSUME_YES="true"; shift ;;
    -h|--help) usage; exit 0 ;;
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

log()  { echo "[destroy] $*"; }
step() { echo; echo "===== $* ====="; }

cdk_run() { ( cd "${INFRA_DIR}" && pnpm exec cdk "$@" ); }

# ── 사전 점검 ────────────────────────────────────────────────────────────────
command -v aws >/dev/null 2>&1 || { echo "오류: aws CLI 필요" >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "오류: pnpm 필요" >&2; exit 1; }
aws sts get-caller-identity >/dev/null 2>&1 || { echo "오류: AWS 자격 증명 없음" >&2; exit 1; }

# ── 확인 프롬프트 ────────────────────────────────────────────────────────────
if [[ "${ASSUME_YES}" != "true" ]]; then
  echo "경고: '${STAGE}' 스테이지의 모든 AppHub 리소스를 삭제합니다."
  if [[ "${STAGE}" == "prod" ]]; then
    read -r -p "정말 prod 를 삭제하려면 'apphub-prod' 를 입력하세요: " CONFIRM || true
    [[ "${CONFIRM}" == "apphub-prod" ]] || { echo "취소되었습니다."; exit 1; }
  else
    read -r -p "계속하려면 'yes' 입력: " CONFIRM || true
    [[ "${CONFIRM}" == "yes" ]] || { echo "취소되었습니다."; exit 1; }
  fi
fi

# ── 1. 잔여 app-* 스택 삭제 (역순의 시작) ─────────────────────────────────────
step "1/3 잔여 앱 스택(app-*) 삭제"
# 앱 = runtime + pipeline 2개. runtime 먼저(트래픽/런타임), pipeline 나중.
APP_STACKS="$(
  aws cloudformation list-stacks --region "${REGION}" \
    --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE UPDATE_ROLLBACK_COMPLETE \
    --query "StackSummaries[?starts_with(StackName, '${PREFIX}-app-')].StackName" \
    --output text 2>/dev/null || true
)"
if [[ -n "${APP_STACKS}" ]]; then
  # runtime → pipeline 순서 보장을 위해 정렬(runtime 이 pipeline 보다 뒤 알파벳이므로 역정렬)
  for STK in $(echo "${APP_STACKS}" | tr '\t' '\n' | grep -- '-runtime$' || true); do
    log "삭제: ${STK}"
    cdk_run destroy "${STK}" -c "stage=${STAGE}" --region "${REGION}" --force || \
      aws cloudformation delete-stack --stack-name "${STK}" --region "${REGION}"
  done
  for STK in $(echo "${APP_STACKS}" | tr '\t' '\n' | grep -- '-pipeline$' || true); do
    log "삭제: ${STK}"
    cdk_run destroy "${STK}" -c "stage=${STAGE}" --region "${REGION}" --force || \
      aws cloudformation delete-stack --stack-name "${STK}" --region "${REGION}"
  done
else
  log "잔여 app-* 스택 없음"
fi

# ── 2. platform 스택 삭제 ────────────────────────────────────────────────────
step "2/3 platform 스택 삭제"
cdk_run destroy "${PLATFORM_STACK}" -c "stage=${STAGE}" --region "${REGION}" --force

# ── 3. network 스택 삭제 (마지막 — 공유 트래픽 인프라) ─────────────────────────
step "3/3 network 스택 삭제"
cdk_run destroy "${NETWORK_STACK}" -c "stage=${STAGE}" --region "${REGION}" --force

echo
echo "AppHub(${STAGE}) 제거 완료."
echo "참고: prod 에서 RETAIN 정책 리소스(DDB/UserPool/SPA 버킷)는 수동 확인이 필요할 수 있습니다."
