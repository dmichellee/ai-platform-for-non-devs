#!/usr/bin/env bash
#
# scripts/backfill-repo-owner-tags.sh 테스트 — 가짜 aws(실제 AWS 호출 없음).
#  - DDB 소유권 4건: 태그 없음(부착 대상) / 이미 태그 있음(불변) / 사용자 없음(경고) / 저장소 없음(경고)
#  - 이메일 소문자화, 1회째 부착 → 2회째 변경 없음(멱등), 항목 실패에도 exit 0, scan 실패는 non-zero.
#
# 사용: bash scripts/test-backfill-repo-owner-tags.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${SCRIPT_DIR}/backfill-repo-owner-tags.sh"

PASS=0; FAIL=0
check() { local d="$1"; shift; if "$@"; then PASS=$((PASS + 1)); echo "  ok   - $d"; else FAIL=$((FAIL + 1)); echo "  FAIL - $d"; fi; }

WORK="$(mktemp -d -t apphub-backfill-XXXXXX)"
trap 'rm -rf "${WORK}"' EXIT
FAKEBIN="${WORK}/bin"; STATE="${WORK}/state"
mkdir -p "${FAKEBIN}" "${STATE}/tags"

# 존재하는 저장소 + 기존 태그
touch "${STATE}/repo-alpha" "${STATE}/repo-beta" "${STATE}/repo-gamma"
echo "someone@other.com" > "${STATE}/tags/repo-beta"

cat > "${FAKEBIN}/aws" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "${FAKE_LOG}"
svc="$1"; op="$2"; shift 2
arg() { local k="$1"; shift; while [[ $# -gt 0 ]]; do [[ "$1" == "$k" ]] && { echo "$2"; return; }; shift; done; }
case "${svc} ${op}" in
  "dynamodb scan")
    [[ "${FAKE_SCAN_FAIL:-0}" == 1 ]] && { echo "AccessDenied" >&2; exit 255; }
    cat <<'JSON'
{"Items":[
 {"PK":{"S":"USER#sub-1"},"SK":{"S":"CCREPO#repo-alpha"}},
 {"PK":{"S":"USER#sub-1"},"SK":{"S":"CCREPO#repo-beta"}},
 {"PK":{"S":"USER#sub-ghost"},"SK":{"S":"CCREPO#repo-gamma"}},
 {"PK":{"S":"USER#sub-1"},"SK":{"S":"CCREPO#repo-deleted"}}
],"Count":4}
JSON
    ;;
  "codecommit get-repository")
    r="$(arg --repository-name "$@")"
    [[ -f "${FAKE_STATE}/${r}" ]] || { echo "RepositoryDoesNotExistException" >&2; exit 254; }
    echo "arn:aws:codecommit:ap-northeast-2:123456789012:${r}"
    ;;
  "codecommit list-tags-for-resource")
    r="$(arg --resource-arn "$@")"; r="${r##*:}"
    if [[ -f "${FAKE_STATE}/tags/${r}" ]]; then printf '{"tags":{"apphub:owner":"%s"}}\n' "$(cat "${FAKE_STATE}/tags/${r}")"
    else echo '{"tags":{"other":"x"}}'; fi
    ;;
  "cognito-idp list-users")
    f="$(arg --filter "$@")"
    if [[ "${f}" == 'sub = "sub-1"' ]]; then echo "Alice.Kim@Example.COM"; else echo "None"; fi
    ;;
  "codecommit tag-resource")
    r="$(arg --resource-arn "$@")"; r="${r##*:}"
    t="$(arg --tags "$@")"
    echo "${t#apphub:owner=}" > "${FAKE_STATE}/tags/${r}"
    ;;
  *) echo "unexpected: ${svc} ${op}" >&2; exit 99 ;;
esac
FAKE
chmod +x "${FAKEBIN}/aws"

run() {
  env PATH="${FAKEBIN}:${PATH}" FAKE_LOG="${WORK}/log" FAKE_STATE="${STATE}" FAKE_SCAN_FAIL="${FAKE_SCAN_FAIL:-0}" \
    bash "${TARGET}" --table apphub-dev-main --user-pool-id pool-1 --region ap-northeast-2 >"${WORK}/out" 2>&1
}

echo "# backfill-repo-owner-tags.sh"
check "bash -n" bash -n "${TARGET}"

: > "${WORK}/log"
run; rc=$?
check "1회째 exit 0(항목 경고가 있어도)" test "${rc}" -eq 0
check "태그 없던 저장소에 소문자 email 부착" test "$(cat "${STATE}/tags/repo-alpha" 2>/dev/null)" = "alice.kim@example.com"
check "이미 있던 태그는 불변" test "$(cat "${STATE}/tags/repo-beta")" = "someone@other.com"
check "사용자 없는 저장소는 태그 안 붙음" test ! -f "${STATE}/tags/repo-gamma"
check "사용자 없음 경고" grep -q "repo-gamma.*찾지 못했습니다" "${WORK}/out"
check "저장소 없음 경고" grep -q "repo-deleted.*찾을 수 없습니다" "${WORK}/out"
check "tag-resource 는 1번만" test "$(grep -c '^codecommit tag-resource' "${WORK}/log")" -eq 1
check "요약 집계" grep -q "새로 부착 1, 이미 있음 1, 경고 2" "${WORK}/out"
check "같은 사용자 email 조회 캐시(list-users ≤ 2회)" test "$(grep -c '^cognito-idp list-users' "${WORK}/log")" -le 2

: > "${WORK}/log"
run; rc=$?
check "2회째 exit 0" test "${rc}" -eq 0
check "2회째 tag-resource 없음(멱등)" test "$(grep -c '^codecommit tag-resource' "${WORK}/log")" -eq 0
check "2회째 요약" grep -q "새로 부착 0, 이미 있음 2, 경고 2" "${WORK}/out"

FAKE_SCAN_FAIL=1 run; rc=$?
check "scan 실패 → non-zero" test "${rc}" -ne 0

env PATH="${FAKEBIN}:${PATH}" bash "${TARGET}" --table t >/dev/null 2>&1; rc=$?
check "필수 인자 누락 → exit 2" test "${rc}" -eq 2

echo
echo "결과: ${PASS} 통과, ${FAIL} 실패"
[[ "${FAIL}" -eq 0 ]]
