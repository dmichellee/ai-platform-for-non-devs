#!/usr/bin/env bash
#
# 설치 스크립트 멱등성 테스트.
#
# 검증:
#   (A) deploy.sh --stage dev 를 2회 연속 실행 → 2회차가 오류 없이 no-op 으로 종료
#       (CloudFormation 스택에 변경이 발생하지 않음).
#   (B) destroy.sh 후 재설치(deploy.sh) → 정상 동작.
#
# 실제 AWS(dev)와 시간이 든다. 이 스크립트는 스크립트 완성 + 문법(bash -n)만 목표로 하며,
# 실제 실행은 dev 배포 담당이 수행한다.
#
# 사용:
#   ./e2e/idempotency-test.sh --stage dev [--region ap-northeast-2] [--phase A|B|both] [--admin-email <e>]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEPLOY="${ROOT_DIR}/scripts/deploy.sh"
DESTROY="${ROOT_DIR}/scripts/destroy.sh"
INFRA_DIR="${ROOT_DIR}/infra"

STAGE=""
REGION="ap-northeast-2"
PHASE="both"
ADMIN_EMAIL=""

usage() {
  cat <<'USAGE'
사용법: idempotency-test.sh --stage <dev|prod> [옵션]
  --stage <dev|prod>    (필수)
  --region <region>     기본: ap-northeast-2
  --phase A|B|both      A=2회 no-op, B=destroy 후 재설치, both=둘 다(기본)
  --admin-email <e>     deploy.sh 로 전달(비대화형)
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage)       STAGE="${2:-}"; shift 2 ;;
    --region)      REGION="${2:-}"; shift 2 ;;
    --phase)       PHASE="${2:-}"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="${2:-}"; shift 2 ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "알 수 없는 인자: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ "${STAGE}" != "dev" && "${STAGE}" != "prod" ]]; then
  echo "오류: --stage 는 dev 또는 prod 여야 합니다." >&2; usage; exit 2
fi

PREFIX="apphub-${STAGE}"
NETWORK_STACK="${PREFIX}-network"
PLATFORM_STACK="${PREFIX}-platform"

log()  { echo "[idem] $*"; }
step() { echo; echo "===== $* ====="; }
fail() { echo "[idem][FAIL] $*" >&2; exit 1; }
ok()   { echo "[idem][PASS] $*"; }

for c in aws node pnpm; do
  command -v "$c" >/dev/null 2>&1 || fail "'$c' 명령이 필요합니다."
done
[[ -x "${DEPLOY}" ]] || fail "deploy.sh 실행 파일이 없습니다: ${DEPLOY}"

cdk_run() { ( cd "${INFRA_DIR}" && pnpm exec cdk "$@" ); }

# 스택의 LastUpdatedTime(없으면 CreationTime) 조회 — 변경 여부 판정용.
stack_last_change() {
  local stack="$1"
  aws cloudformation describe-stacks --stack-name "${stack}" --region "${REGION}" \
    --query 'Stacks[0].[LastUpdatedTime,CreationTime]' --output text 2>/dev/null \
    | awk '{ print ($1=="None" || $1=="") ? $2 : $1 }'
}

# deploy.sh 실행 래퍼(비대화형).
run_deploy() {
  local args=(--stage "${STAGE}" --region "${REGION}")
  [[ -n "${ADMIN_EMAIL}" ]] && args+=(--admin-email "${ADMIN_EMAIL}")
  # SPA/자산까지 포함한 전체 멱등성 검증. 필요 시 --skip-spa 로 축소 가능.
  "${DEPLOY}" "${args[@]}"
}

################################################################################
# Phase A — 2회 연속 실행 → 2회차 no-op
################################################################################
phase_a() {
  step "Phase A: deploy.sh 2회 연속 → 2회차 no-op 검증"

  log "1회차 deploy.sh 실행"
  run_deploy
  # 1회차 후 각 스택의 마지막 변경 시각 기록.
  local net_before plat_before
  net_before="$(stack_last_change "${NETWORK_STACK}")"
  plat_before="$(stack_last_change "${PLATFORM_STACK}")"
  log "1회차 후 변경시각: network=${net_before} platform=${plat_before}"

  # 2회차 전 cdk diff 로 변경 예상 여부 확인(변경 없어야 함).
  #  cdk diff 는 변경 없으면 종료코드 0, 변경 있으면 비0(--fail 없이도 텍스트로 판단).
  step "Phase A: 2회차 전 cdk diff (변경 없음 기대)"
  local diff_out
  set +e
  diff_out="$( cd "${INFRA_DIR}" && pnpm exec cdk diff "${NETWORK_STACK}" "${PLATFORM_STACK}" \
    -c "stage=${STAGE}" --region "${REGION}" 2>&1 )"
  set -e
  echo "${diff_out}" | sed 's/^/    [diff] /'
  # "There were no differences" (또는 각 스택별) 문구로 no-op 판정.
  if echo "${diff_out}" | grep -qiE "no differences|there were no"; then
    ok "cdk diff: 변경 없음(no-op 예상)"
  else
    # diff 에 리소스 변경(+/-/~)이 있으면 멱등성 실패 신호.
    if echo "${diff_out}" | grep -qE '^\s*[\[]?[+~-]'; then
      fail "cdk diff 에 리소스 변경이 감지됨 — 2회차가 no-op 이 아님(멱등성 위반)"
    else
      log "cdk diff 문구를 확정 파싱하지 못함 — 아래 2회차 실행/변경시각 비교로 최종 판정"
    fi
  fi

  log "2회차 deploy.sh 실행(오류 없이 종료해야 함)"
  run_deploy || fail "2회차 deploy.sh 가 오류로 종료(멱등성 위반)"

  # 2회차 후 변경 시각이 그대로여야 함(CloudFormation 이 no-op 이면 LastUpdatedTime 불변).
  local net_after plat_after
  net_after="$(stack_last_change "${NETWORK_STACK}")"
  plat_after="$(stack_last_change "${PLATFORM_STACK}")"
  log "2회차 후 변경시각: network=${net_after} platform=${plat_after}"

  if [[ "${net_before}" == "${net_after}" && "${plat_before}" == "${plat_after}" ]]; then
    ok "Phase A 통과 — 2회차가 스택을 바꾸지 않음(no-op)"
  else
    fail "Phase A 실패 — 2회차 실행이 스택 변경시각을 바꿈(network:${net_before}->${net_after}, platform:${plat_before}->${plat_after})"
  fi
}

################################################################################
# Phase B — destroy 후 재설치
################################################################################
phase_b() {
  step "Phase B: destroy.sh 후 재설치"
  [[ -x "${DESTROY}" ]] || fail "destroy.sh 실행 파일이 없습니다: ${DESTROY}"

  log "destroy.sh 실행(비대화형 --yes)"
  "${DESTROY}" --stage "${STAGE}" --region "${REGION}" --yes \
    || fail "destroy.sh 실패"

  # 스택이 실제로 사라졌는지 확인(dev 는 DESTROY 정책이라 삭제돼야 함, D-M2-07).
  for s in "${PLATFORM_STACK}" "${NETWORK_STACK}"; do
    if aws cloudformation describe-stacks --stack-name "${s}" --region "${REGION}" >/dev/null 2>&1; then
      log "주의: ${s} 이 아직 존재(prod RETAIN 이거나 삭제 진행 중일 수 있음)"
    else
      log "OK: ${s} 삭제 확인"
    fi
  done

  log "재설치 deploy.sh 실행"
  run_deploy || fail "재설치 deploy.sh 실패"

  # 재설치 후 필수 Output 이 다시 나오는지(정상 동작 확인).
  local api
  api="$(aws cloudformation describe-stacks --stack-name "${PLATFORM_STACK}" --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text 2>/dev/null || true)"
  if [[ -n "${api}" && "${api}" != "None" ]]; then
    ok "Phase B 통과 — 재설치 후 ApiUrl 정상(${api})"
  else
    fail "Phase B 실패 — 재설치 후 ApiUrl Output 없음"
  fi
}

################################################################################
step "멱등성 테스트 시작 (stage=${STAGE}, phase=${PHASE})"
case "${PHASE}" in
  A)    phase_a ;;
  B)    phase_b ;;
  both) phase_a; phase_b ;;
  *)    fail "알 수 없는 --phase: ${PHASE} (A|B|both)" ;;
esac

step "멱등성 테스트 완료"
ok "요청한 phase(${PHASE}) 전부 통과"
