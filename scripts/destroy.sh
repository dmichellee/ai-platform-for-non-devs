#!/usr/bin/env bash
#
# AppHub 제거 스크립트 — 배포의 역순 삭제. 재실행 안전(멱등).
# 순서: 잔여 앱 스택(app-*-runtime → app-*-pipeline) → ALB 증설 스택(alb-*, D20) → platform → network.
#
# 사용:
#   ./scripts/destroy.sh --stage dev|prod [--region <region>] [--yes]
#
# 버그 A 수정: 예전엔 platform/network 를 `cdk destroy` 로 지웠는데, cdk destroy 는 먼저 synth 를 하므로
#  설치 시 넣었던 `-c domain=...` 이 없으면 synth 단계에서 실패했다. 이제 모든 스택을
#  `aws cloudformation delete-stack` + `wait stack-delete-complete` 로 직접 삭제한다(synth·CDK 불필요).
#  `*_FAILED`/`DELETE_FAILED`/`ROLLBACK_COMPLETE` 등 비정상 상태 스택도 삭제 대상에 포함한다.
#
# 주의:
#   - prod 는 데이터 유실 방지를 위해 대화형 확인을 강제한다(--yes 로만 우회).
#   - 앱(app-*) 스택은 원칙적으로 플랫폼의 앱 삭제 흐름으로 제거되지만, 남아 있으면 여기서 먼저 지운다.
#   - prod 의 RETAIN 리소스(DDB/UserPool/버킷)는 스택 삭제 후에도 남는다(수동 확인).
set -euo pipefail

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

# ── 사전 점검 (변경 전 검증) ─────────────────────────────────────────────────
command -v aws >/dev/null 2>&1 || { echo "오류: aws CLI 필요" >&2; exit 1; }
aws sts get-caller-identity >/dev/null 2>&1 || { echo "오류: AWS 자격 증명 없음" >&2; exit 1; }

# ── 확인 프롬프트 ────────────────────────────────────────────────────────────
if [[ "${ASSUME_YES}" != "true" ]]; then
  echo "경고: '${STAGE}' 스테이지(${REGION})의 모든 AppHub 리소스를 삭제합니다."
  if [[ "${STAGE}" == "prod" ]]; then
    read -r -p "정말 prod 를 삭제하려면 'apphub-prod' 를 입력하세요: " CONFIRM || true
    [[ "${CONFIRM}" == "apphub-prod" ]] || { echo "취소되었습니다."; exit 1; }
  else
    read -r -p "계속하려면 'yes' 입력: " CONFIRM || true
    [[ "${CONFIRM}" == "yes" ]] || { echo "취소되었습니다."; exit 1; }
  fi
fi

# 삭제 대상이 될 수 있는 모든 상태(DELETE_COMPLETE 제외). 진행 중 상태도 포함해 wait 로 수렴시킨다.
#  *_FAILED / DELETE_FAILED / ROLLBACK_COMPLETE 같은 비정상 상태 스택도 지워야 재설치가 깨지지 않는다.
LIVE_STATUSES=(
  CREATE_IN_PROGRESS CREATE_FAILED CREATE_COMPLETE
  ROLLBACK_IN_PROGRESS ROLLBACK_FAILED ROLLBACK_COMPLETE
  DELETE_IN_PROGRESS DELETE_FAILED
  UPDATE_IN_PROGRESS UPDATE_COMPLETE_CLEANUP_IN_PROGRESS UPDATE_COMPLETE
  UPDATE_FAILED UPDATE_ROLLBACK_IN_PROGRESS UPDATE_ROLLBACK_FAILED
  UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS UPDATE_ROLLBACK_COMPLETE
  REVIEW_IN_PROGRESS
  IMPORT_IN_PROGRESS IMPORT_COMPLETE IMPORT_ROLLBACK_IN_PROGRESS IMPORT_ROLLBACK_FAILED IMPORT_ROLLBACK_COMPLETE
)

# list_stacks <접두어> — 해당 접두어로 시작하는 살아있는 스택명(줄 단위).
list_stacks() {
  aws cloudformation list-stacks --region "${REGION}" \
    --stack-status-filter "${LIVE_STATUSES[@]}" \
    --query "StackSummaries[?starts_with(StackName, '$1')].StackName" \
    --output text 2>/dev/null | tr '\t' '\n' | sed '/^$/d' | sort -u
}

stack_status() {
  aws cloudformation describe-stacks --stack-name "$1" --region "${REGION}" \
    --query "Stacks[0].StackStatus" --output text 2>/dev/null || echo "GONE"
}

# delete_stacks <스택명...> — 모두 delete-stack 요청 후 완료까지 대기(같은 단계 스택은 병렬 삭제).
#  이미 없으면 통과(멱등). 대기 실패 시 실패 리소스를 보여주고 중단(다음 단계로 넘어가면 의존성 때문에 더 꼬인다).
#  bash 3.2(macOS 기본) 호환: mapfile·빈 배열 확장을 쓰지 않는다(스택명엔 공백이 없다).
delete_stacks() {
  local stk st failed=""
  [[ $# -eq 0 ]] && return 0
  for stk in "$@"; do
    st="$(stack_status "${stk}")"
    if [[ "${st}" == "GONE" ]]; then
      log "${stk}: 이미 없음 — 통과"
      continue
    fi
    log "삭제 요청: ${stk} (현재 ${st})"
    aws cloudformation delete-stack --stack-name "${stk}" --region "${REGION}"
  done
  for stk in "$@"; do
    [[ "$(stack_status "${stk}")" == "GONE" ]] && continue
    log "삭제 대기: ${stk}"
    if ! aws cloudformation wait stack-delete-complete --stack-name "${stk}" --region "${REGION}"; then
      failed="${failed} ${stk}"
      echo "오류: ${stk} 삭제 실패(현재 $(stack_status "${stk}")). 실패 리소스:" >&2
      aws cloudformation describe-stack-events --stack-name "${stk}" --region "${REGION}" \
        --query "StackEvents[?ResourceStatus=='DELETE_FAILED'].[LogicalResourceId,ResourceStatusReason]" \
        --output text 2>/dev/null | head -20 >&2 || true
    else
      log "삭제 완료: ${stk}"
    fi
  done
  if [[ -n "${failed}" ]]; then
    echo "오류: 삭제되지 않은 스택:${failed}" >&2
    echo "      원인을 해결한 뒤 이 스크립트를 다시 실행하세요(재실행 안전)." >&2
    exit 1
  fi
}

# ── 1. 잔여 app-* 스택 (runtime → pipeline) ─────────────────────────────────
step "1/4 잔여 앱 스택(app-*) 삭제"
APP_STACKS="$(list_stacks "${PREFIX}-app-")"
if [[ -z "${APP_STACKS}" ]]; then
  log "잔여 app-* 스택 없음"
else
  # runtime 먼저(트래픽/리스너 규칙/ECS 서비스), pipeline 나중(ECR emptyOnDelete).
  # shellcheck disable=SC2046 # 스택명 목록의 의도된 단어 분리
  delete_stacks $(echo "${APP_STACKS}" | grep -- '-runtime$' || true)
  # shellcheck disable=SC2046
  delete_stacks $(echo "${APP_STACKS}" | grep -- '-pipeline$' || true)
fi

# ── 2. ALB 증설 스택 (D20: apphub-{stage}-alb-{scheme}-{n}) ──────────────────
# 앱 리스너 규칙(runtime)이 먼저 지워져야 리스너/ALB 삭제가 깔끔하다 → app-* 다음.
step "2/4 ALB 증설 스택(alb-*) 삭제"
ALB_STACKS="$(list_stacks "${PREFIX}-alb-")"
if [[ -z "${ALB_STACKS}" ]]; then
  log "ALB 증설 스택 없음"
else
  # shellcheck disable=SC2086 # 스택명 목록의 의도된 단어 분리
  delete_stacks ${ALB_STACKS}
fi

# ── 3. platform 스택 ─────────────────────────────────────────────────────────
# private 모드(D19)의 콘솔 ALB·ECS·VPC 엔드포인트가 network VPC 안에 있으므로 network 보다 먼저.
step "3/4 platform 스택 삭제"
delete_stacks "${PLATFORM_STACK}"

# ── 4. network 스택 (마지막 — 공유 트래픽 인프라) ──────────────────────────────
step "4/4 network 스택 삭제"
delete_stacks "${NETWORK_STACK}"

echo
echo "AppHub(${STAGE}) 제거 완료."
echo "참고: prod 에서 RETAIN 정책 리소스(DDB/UserPool/버킷)는 수동 확인이 필요할 수 있습니다."
echo "      CDK bootstrap(CDKToolkit)과 그 자산 저장소는 다른 CDK 앱과 공유될 수 있어 지우지 않습니다."
