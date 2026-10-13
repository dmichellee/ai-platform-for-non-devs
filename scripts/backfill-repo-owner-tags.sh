#!/usr/bin/env bash
#
# CodeCommit 저장소 소유 태그 백필 (D22 — 계약 delta-2026-10-12-d22 §1).
#
# AppHub로 만든 저장소(DDB PK=USER#{sub}, SK=CCREPO#{repoName})에 소유 태그
#   apphub:owner = {저장소 생성자 Cognito email, 소문자}
# 가 없으면 붙인다. 이미 있으면(값이 무엇이든) 건드리지 않는다 → 몇 번 실행해도 결과가 같다.
#
# 이 태그는 Identity Center 권한 세트(AppHubGit)의 ABAC 조건
#   aws:ResourceTag/apphub:owner == ${aws:PrincipalTag/email}  (StringEqualsIgnoreCase)
# 에 쓰인다(D22). D22 이전에 만든 저장소는 태그가 없어 git push/clone이 거부되므로 백필한다.
#
# 사용:
#   ./scripts/backfill-repo-owner-tags.sh --table <apphub-{stage}-main> --user-pool-id <id> \
#       [--region <region>] [--account-id <12자리>]
#
# 실패 방침: 항목 하나의 실패(저장소 없음·사용자 없음·태그 실패)는 경고 후 다음 항목으로 계속.
#  DDB 조회 자체가 실패하면 non-zero 로 끝난다(deploy.sh 3e는 이를 경고로만 처리하고 설치를 계속).
# 의존성: aws CLI + node (deploy.sh 사전 점검과 동일).
set -euo pipefail

TABLE=""
USER_POOL_ID=""
REGION="${AWS_REGION:-ap-northeast-2}"
ACCOUNT_ID=""
OWNER_TAG_KEY="apphub:owner"

usage() {
  cat <<'USAGE'
사용법: backfill-repo-owner-tags.sh --table <name> --user-pool-id <id> [--region <region>] [--account-id <id>]
  --table <name>          AppHub DynamoDB 테이블(apphub-{stage}-main)
  --user-pool-id <id>     AppHub Cognito User Pool ID
  --region <region>       플랫폼(=CodeCommit) 리전 (기본: ap-northeast-2)
  --account-id <id>       (선택) 표시용 계정 ID. 저장소 ARN 은 get-repository 결과를 쓴다.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --table)        TABLE="${2:-}"; shift 2 ;;
    --user-pool-id) USER_POOL_ID="${2:-}"; shift 2 ;;
    --region)       REGION="${2:-}"; shift 2 ;;
    --account-id)   ACCOUNT_ID="${2:-}"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "알 수 없는 인자: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "${TABLE}" || -z "${USER_POOL_ID}" ]]; then
  echo "오류: --table 과 --user-pool-id 는 필수입니다." >&2
  usage; exit 2
fi

log()  { echo "[backfill-owner-tag] $*"; }
warn() { echo "[backfill-owner-tag] 경고: $*" >&2; }

command -v aws  >/dev/null 2>&1 || { echo "오류: aws CLI 가 필요합니다." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "오류: node 가 필요합니다." >&2; exit 1; }

# 1) 소유권 아이템 전부 — SK begins_with CCREPO#. scan 은 aws CLI 가 자동 페이지네이션한다.
#    출력: 한 줄에 "{sub}\t{repoName}" (node 로 JSON 파싱 — jq 의존성 없음).
if ! SCAN_JSON="$(aws dynamodb scan --table-name "${TABLE}" --region "${REGION}" \
      --filter-expression "begins_with(SK, :p) AND begins_with(PK, :u)" \
      --expression-attribute-values '{":p":{"S":"CCREPO#"},":u":{"S":"USER#"}}' \
      --projection-expression "PK, SK" --output json)"; then
  echo "오류: ${TABLE} 조회(scan) 실패." >&2
  exit 1
fi
PAIRS="$(printf '%s' "${SCAN_JSON}" | node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8") || "{}");
  for (const it of d.Items || []) {
    const pk = (it.PK && it.PK.S) || "", sk = (it.SK && it.SK.S) || "";
    if (!pk.startsWith("USER#") || !sk.startsWith("CCREPO#")) continue;
    const sub = pk.slice(5), repo = sk.slice(7);
    if (sub && repo && !/[\t\n]/.test(sub + repo)) console.log(sub + "\t" + repo);
  }')"

TOTAL=0; TAGGED=0; SKIPPED=0; WARNED=0
if [[ -z "${PAIRS}" ]]; then
  log "AppHub로 만든 CodeCommit 저장소 기록이 없습니다 — 할 일 없음."
  exit 0
fi

# sub → email 조회(같은 사용자를 여러 번 묻지 않도록 마지막 결과만 캐시 — 정렬 후 순회).
LAST_SUB=""; LAST_EMAIL=""
while IFS=$'\t' read -r SUB REPO; do
  [[ -n "${SUB}" && -n "${REPO}" ]] || continue
  TOTAL=$((TOTAL + 1))

  # 2) 저장소 존재 + ARN
  if ! ARN="$(aws codecommit get-repository --repository-name "${REPO}" --region "${REGION}" \
        --query 'repositoryMetadata.Arn' --output text 2>/dev/null)" || [[ -z "${ARN}" || "${ARN}" == "None" ]]; then
    warn "저장소 '${REPO}' 를 찾을 수 없습니다(삭제됐을 수 있음) — 건너뜀."
    WARNED=$((WARNED + 1)); continue
  fi

  # 3) 이미 소유 태그가 있으면 건드리지 않는다(값 무관 — 사람이 바꾼 값도 존중).
  if ! EXISTING="$(aws codecommit list-tags-for-resource --resource-arn "${ARN}" --region "${REGION}" \
        --output json 2>/dev/null | node -e '
          const d = JSON.parse(require("fs").readFileSync(0, "utf8") || "{}");
          const v = (d.tags || {})[process.argv[1]];
          process.stdout.write(v === undefined ? "" : "present");' "${OWNER_TAG_KEY}")"; then
    warn "저장소 '${REPO}' 태그 조회 실패 — 건너뜀."
    WARNED=$((WARNED + 1)); continue
  fi
  if [[ "${EXISTING}" == "present" ]]; then
    SKIPPED=$((SKIPPED + 1)); continue
  fi

  # 4) sub → Cognito email(소문자)
  if [[ "${SUB}" != "${LAST_SUB}" ]]; then
    LAST_SUB="${SUB}"
    LAST_EMAIL="$(aws cognito-idp list-users --user-pool-id "${USER_POOL_ID}" --region "${REGION}" \
      --filter "sub = \"${SUB}\"" \
      --query 'Users[0].Attributes[?Name==`email`].Value | [0]' --output text 2>/dev/null || true)"
    [[ "${LAST_EMAIL}" == "None" ]] && LAST_EMAIL=""
    LAST_EMAIL="$(printf '%s' "${LAST_EMAIL}" | tr '[:upper:]' '[:lower:]')"
  fi
  if [[ -z "${LAST_EMAIL}" ]]; then
    warn "저장소 '${REPO}' 의 생성자(sub ${SUB})를 AppHub 사용자에서 찾지 못했습니다 — 건너뜀."
    WARNED=$((WARNED + 1)); continue
  fi

  # 5) 태그 부착
  if aws codecommit tag-resource --resource-arn "${ARN}" --region "${REGION}" \
       --tags "${OWNER_TAG_KEY}=${LAST_EMAIL}" >/dev/null; then
    log "저장소 '${REPO}' 에 ${OWNER_TAG_KEY}=${LAST_EMAIL} 부착"
    TAGGED=$((TAGGED + 1))
  else
    warn "저장소 '${REPO}' 태그 부착 실패 — 건너뜀."
    WARNED=$((WARNED + 1))
  fi
done < <(printf '%s\n' "${PAIRS}" | LC_ALL=C sort)

log "완료: 대상 ${TOTAL}개 — 새로 부착 ${TAGGED}, 이미 있음 ${SKIPPED}, 경고 ${WARNED}${ACCOUNT_ID:+ (계정 ${ACCOUNT_ID})}"
exit 0
