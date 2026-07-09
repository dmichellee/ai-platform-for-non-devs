#!/usr/bin/env bash
#
# AppHub 라이브 E2E (TEST-STRATEGY.md L4 — 릴리스 게이트).
#
# 실제 AWS(dev 스테이지)에 대해 골든 샘플 앱의 배포 전 여정을 검증한다.
# 실제 비용(소액)과 시간(~30분)이 든다. self-contained — 퍼블릭 애셋 사용자가
# 플랫폼 설치 후 검증용으로도 쓸 수 있다.
#
# 사용:
#   ./e2e/run-e2e.sh --stage dev [--region ap-northeast-2] [--scenario 1,2,3,4,5] [--keep]
#
# 선행조건(라이브 실행 시 — 이 스크립트는 만들지 않는다):
#   1. deploy.sh --stage dev 로 플랫폼(network+platform)이 배포돼 있을 것.
#   2. 관리자 화면(또는 API)에서: VPC 등록 / provider 활성화(codecommit) /
#      컴퓨팅 프리셋 1개 이상 / 권한 템플릿 1개 이상 / 허용 베이스 이미지 설정.
#   3. 테스트 사용자 2명(user/admin)이 확정 비밀번호로 존재. 앱 클라이언트에
#      ADMIN_USER_PASSWORD_AUTH(또는 USER_PASSWORD_AUTH) 흐름 허용.
#      자격 증명은 환경변수로 주입: E2E_USERNAME/E2E_PASSWORD,
#      E2E_ADMIN_USERNAME/E2E_ADMIN_PASSWORD.
#   4. Playwright 시나리오(5)는 web/ SPA URL 필요: 환경변수 E2E_WEB_URL
#      (미지정 시 CloudFront 도메인에서 유추). `npx playwright install` 완료.
#   5. 소스 리포 준비 방식: 기본은 CodeCommit(provider=codecommit) 리포를 앱별로
#      만들고 픽스처를 push한다. github/gitlab로 하려면 환경변수 E2E_PROVIDER 등 조정.
#
# 안전장치: 각 시나리오는 자기가 만든 앱을 finally 에서 삭제한다(--keep 지정 시 보존).
#           앱 이름/서브도메인에 'e2e-' 접두어를 붙여 야간 정리 스크립트가 걸러낼 수 있게 한다.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
FIXTURES_DIR="${SCRIPT_DIR}/fixtures"

# ── 인자 파싱 ────────────────────────────────────────────────────────────────
STAGE=""
REGION="ap-northeast-2"
SCENARIOS="1,2,3,4,5"
KEEP="false"

usage() {
  cat <<'USAGE'
사용법: run-e2e.sh --stage <dev|prod> [옵션]
  --stage <dev|prod>     (필수) 대상 스테이지
  --region <region>      기본: ap-northeast-2
  --scenario "1,2,..."   실행할 시나리오 번호(콤마). 기본: 1,2,3,4,5
  --keep                 생성한 앱을 삭제하지 않고 보존(디버깅용)
환경변수:
  E2E_USERNAME/E2E_PASSWORD              user 그룹 테스트 자격
  E2E_ADMIN_USERNAME/E2E_ADMIN_PASSWORD  admin 그룹 테스트 자격
  E2E_PRESET_ID / E2E_PERM_ID / E2E_VPC_ID  앱 생성에 쓸 프리셋/권한/VPC (미지정 시 목록 첫 항목)
  E2E_WEB_URL                            SPA URL(시나리오 5, Playwright)
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage)    STAGE="${2:-}"; shift 2 ;;
    --region)   REGION="${2:-}"; shift 2 ;;
    --scenario) SCENARIOS="${2:-}"; shift 2 ;;
    --keep)     KEEP="true"; shift ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "알 수 없는 인자: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ "${STAGE}" != "dev" && "${STAGE}" != "prod" ]]; then
  echo "오류: --stage 는 dev 또는 prod 여야 합니다." >&2; usage; exit 2
fi

# 공용 헬퍼 로드(전역 STAGE/REGION 사용).
export STAGE REGION
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

# ── 사전 점검 ────────────────────────────────────────────────────────────────
e2e::step "0. 사전 점검"
for c in aws node curl git; do
  command -v "$c" >/dev/null 2>&1 || { e2e::fail "'$c' 명령이 필요합니다."; exit 1; }
done
aws sts get-caller-identity >/dev/null 2>&1 || { e2e::fail "AWS 자격 증명이 없습니다."; exit 1; }
e2e::load_outputs
e2e::cognito_login "${E2E_USERNAME:-}" "${E2E_PASSWORD:-}"

# 앱 생성에 필요한 프리셋/권한/VPC 결정(미지정 시 목록 첫 항목).
resolve_ids() {
  if [[ -z "${E2E_PRESET_ID:-}" ]]; then
    local presets; presets="$(e2e::api GET /admin/presets 2>/dev/null || true)"
    E2E_PRESET_ID="$(e2e::json "${presets}" 'data.items.0.presetId' 2>/dev/null || true)"
  fi
  if [[ -z "${E2E_PERM_ID:-}" ]]; then
    local perms; perms="$(e2e::api GET /admin/permission-templates 2>/dev/null || true)"
    E2E_PERM_ID="$(e2e::json "${perms}" 'data.items.0.permId' 2>/dev/null || true)"
  fi
  if [[ -z "${E2E_VPC_ID:-}" ]]; then
    local settings; settings="$(e2e::api GET /admin/settings 2>/dev/null || true)"
    E2E_VPC_ID="$(e2e::json "${settings}" 'data.registeredVpcs.0.vpcId' 2>/dev/null || true)"
  fi
  e2e::log "preset=${E2E_PRESET_ID:-<none>} perm=${E2E_PERM_ID:-<none>} vpc=${E2E_VPC_ID:-<none>}"
  if [[ -z "${E2E_PRESET_ID:-}" || -z "${E2E_PERM_ID:-}" || -z "${E2E_VPC_ID:-}" ]]; then
    e2e::fail "프리셋/권한/VPC가 준비되지 않았습니다. 관리자 설정을 먼저 완료하세요(선행조건 2)."
    exit 1
  fi
}

# 고유 서브도메인 생성(전역 중복 회피 + 'e2e-' 접두어로 정리 대상 표시).
uniq_sub() { echo "e2e-$1-$(date +%s)-$RANDOM" | tr '[:upper:]' '[:lower:]' | cut -c1-40; }

# ── 소스 리포 준비: 픽스처를 CodeCommit 리포로 push ──────────────────────────
# 계약: provider=codecommit 이면 repoUrl 은 CodeCommit HTTPS URL.
#  이 함수는 리포를 만들고(없으면) 픽스처 내용을 push, repoUrl 을 echo 한다.
prepare_codecommit_repo() {
  local fixture="$1" reponame="$2"
  # 리포 생성(존재하면 통과).
  if ! aws codecommit get-repository --repository-name "${reponame}" --region "${REGION}" >/dev/null 2>&1; then
    aws codecommit create-repository --repository-name "${reponame}" --region "${REGION}" >/dev/null
  fi
  local cloneUrl
  cloneUrl="$(aws codecommit get-repository --repository-name "${reponame}" --region "${REGION}" \
    --query 'repositoryMetadata.cloneUrlHttp' --output text)"

  # 픽스처를 임시 워크트리에 복사하고 push (git-remote-codecommit 또는 자격 도우미 필요).
  local work; work="$(mktemp -d)"
  cp -R "${FIXTURES_DIR}/${fixture}/." "${work}/"
  (
    cd "${work}"
    git init -q
    git checkout -q -b main
    git add -A
    git -c user.email="e2e@apphub.local" -c user.name="apphub-e2e" commit -q -m "e2e fixture: ${fixture}"
    # push — CodeCommit HTTPS(git-remote-codecommit: codecommit::{region}://{repo}) 권장.
    git remote add origin "codecommit::${REGION}://${reponame}" 2>/dev/null \
      || git remote set-url origin "codecommit::${REGION}://${reponame}"
    git push -q -u origin main --force
  )
  rm -rf "${work}"
  echo "${cloneUrl}"
}

# 픽스처에 새 커밋을 얹어 push(자동 배포 트리거용).
push_new_commit() {
  local reponame="$1" fixture="$2"
  local work; work="$(mktemp -d)"
  git clone -q "codecommit::${REGION}://${reponame}" "${work}" 2>/dev/null || {
    e2e::fail "리포 clone 실패(${reponame}) — git-remote-codecommit 설정 확인"; rm -rf "${work}"; return 1;
  }
  (
    cd "${work}"
    echo "// e2e redeploy $(date +%s)" >> server.js
    git add -A
    git -c user.email="e2e@apphub.local" -c user.name="apphub-e2e" commit -q -m "e2e: trigger auto deploy"
    git push -q origin HEAD:main
  )
  rm -rf "${work}"
}

# 앱 생성 API 호출 → appId echo. 인자: <name> <subdomain> <repoUrl> <sleepMode> [scheduleJson]
create_app() {
  local name="$1" sub="$2" repoUrl="$3" sleepMode="$4" schedule="${5:-}"
  local body
  body="$(node -e '
    const [name, sub, repoUrl, presetId, permId, vpcId, sleepMode, schedule] = process.argv.slice(1);
    const b = {
      name, subdomain: sub, provider: "codecommit", repoUrl, branch: "main",
      presetId, permissionTemplateId: permId, scheme: "internal", vpcId,
      autoDeployEnabled: true, sleepMode, envVars: {}, cognitoProtect: false,
    };
    if (sleepMode === "schedule" && schedule) b.schedule = JSON.parse(schedule);
    process.stdout.write(JSON.stringify(b));
  ' "${name}" "${sub}" "${repoUrl}" "${E2E_PRESET_ID}" "${E2E_PERM_ID}" "${E2E_VPC_ID}" "${sleepMode}" "${schedule}")"
  local resp; resp="$(e2e::api POST /apps "${body}" 201)"
  e2e::json "${resp}" 'data.appId'
}

# 앱 삭제(멱등, --keep 이면 생략).
cleanup_app() {
  local appId="$1"
  [[ "${KEEP}" == "true" ]] && { e2e::log "--keep — 앱 ${appId} 보존"; return 0; }
  [[ -z "${appId}" ]] && return 0
  e2e::log "정리: 앱 ${appId} 삭제 접수"
  e2e::api DELETE "/apps/${appId}" "" "" >/dev/null 2>&1 || true
}

# 조건 함수(폴링): 앱 status 가 목표값인지.
app_status_is() {
  local appId="$1" want="$2"
  local resp; resp="$(e2e::api GET "/apps/${appId}" 2>/dev/null || true)"
  local st; st="$(e2e::json "${resp}" 'data.status' 2>/dev/null || true)"
  [[ "${st}" == "${want}" ]]
}
# 앱 status 가 CREATING 을 벗어났는지(ACTIVE 또는 FAILED).
app_settled() {
  local appId="$1"
  local resp; resp="$(e2e::api GET "/apps/${appId}" 2>/dev/null || true)"
  local st; st="$(e2e::json "${resp}" 'data.status' 2>/dev/null || true)"
  [[ "${st}" == "ACTIVE" || "${st}" == "FAILED" ]]
}
# 최신 배포의 failureCategory 가 기대값인지.
latest_deploy_failure_is() {
  local appId="$1" want="$2"
  local resp; resp="$(e2e::api GET "/apps/${appId}/deployments?limit=1" 2>/dev/null || true)"
  local fc; fc="$(e2e::json "${resp}" 'data.items.0.failureCategory' 2>/dev/null || true)"
  [[ "${fc}" == "${want}" ]]
}
# runtimeState 가 목표값인지.
app_runtime_is() {
  local appId="$1" want="$2"
  local resp; resp="$(e2e::api GET "/apps/${appId}" 2>/dev/null || true)"
  local rs; rs="$(e2e::json "${resp}" 'data.runtimeState' 2>/dev/null || true)"
  [[ "${rs}" == "${want}" ]]
}
# 앱이 소멸(404)했는지.
app_gone() {
  local appId="$1"
  local code; code="$(e2e::api_status GET "/apps/${appId}")"
  [[ "${code}" == "404" ]]
}

################################################################################
# 시나리오 1 — 정상 배포 여정 + 스트리밍 + 리소스 누수 검사
################################################################################
scenario_1() {
  e2e::step "시나리오 1: 정상 배포 여정 (sample-ok + sample-streaming)"
  resolve_ids

  local sub_ok; sub_ok="$(uniq_sub ok)"
  local repo_ok="apphub-e2e-ok-${sub_ok}"
  e2e::log "sample-ok 리포 준비 → ${repo_ok}"
  local url_ok; url_ok="$(prepare_codecommit_repo sample-ok "${repo_ok}")"

  local appId_ok=""
  # trap 으로 정리 보장
  cleanup_1() { cleanup_app "${appId_ok:-}"; }
  trap cleanup_1 RETURN

  appId_ok="$(create_app "e2e-ok" "${sub_ok}" "${url_ok}" "always-on")"
  e2e::log "앱 생성됨: ${appId_ok} (subdomain=${sub_ok})"

  # 파이프라인 완주 대기(빌드+배포). 상한 20분.
  e2e::wait_for "sample-ok 배포 완주(status settle)" 1200 20 app_settled "${appId_ok}" \
    || { e2e::fail "배포 완주 실패"; return 1; }
  e2e::assert_fn "sample-ok status=ACTIVE" app_status_is "${appId_ok}" ACTIVE

  # 발급 URL HTTPS 200 (internal 앱이면 VPC 내부 접근 필요 — dev 환경에서 접근 가능하다고 가정).
  local host_ok="${sub_ok}.${APPS_DOMAIN}"
  e2e::log "발급 URL: https://${host_ok}/health"
  http_health_ok() { [[ "$(e2e::http_status "https://${host_ok}/health")" == "200" ]]; }
  e2e::wait_for "sample-ok /health HTTPS 200" 300 10 http_health_ok \
    || e2e::fail "발급 URL 200 실패(internal 앱은 VPC 내부에서 실행해야 할 수 있음 — 선행조건 확인)"

  # ── 스트리밍 앱 ──
  local sub_st; sub_st="$(uniq_sub stream)"
  local repo_st="apphub-e2e-stream-${sub_st}"
  local url_st; url_st="$(prepare_codecommit_repo sample-streaming "${repo_st}")"
  local appId_st; appId_st="$(create_app "e2e-stream" "${sub_st}" "${url_st}" "always-on")"
  cleanup_1b() { cleanup_app "${appId_st:-}"; }
  trap 'cleanup_1; cleanup_1b' RETURN
  e2e::wait_for "sample-streaming 배포 완주" 1200 20 app_settled "${appId_st}" || return 1

  local host_st="${sub_st}.${APPS_DOMAIN}"
  # 스트리밍 검증: /stream 응답의 청크가 시간차로 도착하는지(버퍼링 없이).
  e2e::log "스트리밍 검증: https://${host_st}/stream"
  local stream_out
  stream_out="$(curl -s -k -N --max-time 30 "https://${host_st}/stream" 2>/dev/null || true)"
  if echo "${stream_out}" | grep -q "chunk-1" && echo "${stream_out}" | grep -q "\[DONE\]"; then
    e2e::ok "스트리밍 응답 수신(chunk + [DONE])"
  else
    e2e::fail "스트리밍 응답 확인 실패. 받은 내용: ${stream_out:0:200}"
  fi

  # ── 삭제 + 리소스 누수 검사 ──
  e2e::log "삭제 접수: ${appId_ok}, ${appId_st}"
  e2e::api DELETE "/apps/${appId_ok}" "" "" >/dev/null
  e2e::wait_for "sample-ok 삭제 완료(404)" 1200 20 app_gone "${appId_ok}" || return 1
  e2e::assert_no_leak "${appId_ok}" "${sub_ok}" || return 1

  e2e::api DELETE "/apps/${appId_st}" "" "" >/dev/null
  e2e::wait_for "sample-streaming 삭제 완료(404)" 1200 20 app_gone "${appId_st}" || return 1
  e2e::assert_no_leak "${appId_st}" "${sub_st}" || return 1

  # 삭제 완료됐으니 trap 정리는 no-op.
  appId_ok=""; appId_st=""
  e2e::ok "시나리오 1 통과"
}

################################################################################
# 시나리오 2 — 실패 유형 검증 (4종 → 기대 failureCategory)
################################################################################
scenario_2() {
  e2e::step "시나리오 2: 실패 유형 검증"
  resolve_ids

  # 픽스처 → 기대 failureCategory
  local specs=(
    "sample-no-dockerfile:DOCKERFILE_MISSING"
    "sample-wrong-port:DOCKERFILE_INVALID"
    "sample-build-error:BUILD_FAILED"
    "sample-no-health:HEALTHCHECK_FAILED"
  )
  local created_ids=()
  cleanup_2() { for id in "${created_ids[@]:-}"; do cleanup_app "${id}"; done; }
  trap cleanup_2 RETURN

  local pass=0
  for spec in "${specs[@]}"; do
    local fixture="${spec%%:*}" want="${spec##*:}"
    local sub; sub="$(uniq_sub fail)"
    local reponame="apphub-e2e-${fixture}-${sub}"
    e2e::log "--- ${fixture} (기대 ${want}) ---"
    local url; url="$(prepare_codecommit_repo "${fixture}" "${reponame}")"
    local appId; appId="$(create_app "e2e-${fixture}" "${sub}" "${url}" "always-on")"
    created_ids+=("${appId}")

    # 실패 픽스처는 status=FAILED 로 settle 되어야 하고, 최신 배포 failureCategory 가 기대값.
    e2e::wait_for "${fixture} settle" 900 15 app_settled "${appId}" || { e2e::fail "${fixture} settle 실패"; continue; }
    if app_status_is "${appId}" FAILED; then
      if latest_deploy_failure_is "${appId}" "${want}"; then
        e2e::ok "${fixture} → ${want} 확인"
        pass=$(( pass + 1 ))
      else
        local resp; resp="$(e2e::api GET "/apps/${appId}/deployments?limit=1")"
        e2e::fail "${fixture}: failureCategory 불일치. 기대=${want} 실제=$(e2e::json "${resp}" 'data.items.0.failureCategory')"
      fi
    else
      e2e::fail "${fixture}: status 가 FAILED 가 아님(성공 픽스처가 아님에도)"
    fi
  done

  if [[ "${pass}" -eq 4 ]]; then e2e::ok "실패 유형 4종 전부 기대 카테고리(4/4)"; else e2e::fail "실패 유형 검증(${pass}/4)"; return 1; fi
  e2e::ok "시나리오 2 통과"
}

################################################################################
# 시나리오 3 — 자동 배포 (커밋 push → 파이프라인 자동 트리거)
################################################################################
scenario_3() {
  e2e::step "시나리오 3: 자동 배포"
  resolve_ids

  local sub; sub="$(uniq_sub auto)"
  local reponame="apphub-e2e-auto-${sub}"
  local url; url="$(prepare_codecommit_repo sample-ok "${reponame}")"
  local appId; appId="$(create_app "e2e-auto" "${sub}" "${url}" "always-on")"
  cleanup_3() { cleanup_app "${appId:-}"; }
  trap cleanup_3 RETURN

  e2e::wait_for "초기 배포 완주" 1200 20 app_settled "${appId}" || return 1
  e2e::assert_fn "초기 status=ACTIVE" app_status_is "${appId}" ACTIVE

  # 현재 배포 개수 기록.
  local before; before="$(e2e::api GET "/apps/${appId}/deployments?limit=50")"
  local count_before; count_before="$(echo "${before}" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).data.items.length')"
  e2e::log "자동 배포 전 배포 이력 개수: ${count_before}"

  # 새 커밋 push → autoDeployEnabled=true 이므로 새 파이프라인 실행 발생해야 함.
  e2e::log "새 커밋 push"
  push_new_commit "${reponame}" sample-ok || return 1

  # 배포 이력이 늘어나는지 폴링.
  deploy_count_increased() {
    local resp; resp="$(e2e::api GET "/apps/${appId}/deployments?limit=50" 2>/dev/null || true)"
    local n; n="$(echo "${resp}" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).data.items.length' 2>/dev/null || echo 0)"
    [[ "${n}" -gt "${count_before}" ]]
  }
  e2e::wait_for "커밋 push 후 새 배포 발생" 600 15 deploy_count_increased "${appId}" \
    || { e2e::fail "자동 배포 트리거 실패"; return 1; }

  e2e::ok "시나리오 3 통과 (자동 배포 트리거 확인)"
}

################################################################################
# 시나리오 4 — 가동 스케줄 + wake-on-request
################################################################################
scenario_4() {
  e2e::step "시나리오 4: 가동 스케줄 + 자동 기동(wake)"
  resolve_ids

  local sub; sub="$(uniq_sub wake)"
  local reponame="apphub-e2e-wake-${sub}"
  local url; url="$(prepare_codecommit_repo sample-ok "${reponame}")"

  # 스케줄: "1분 뒤 중지" — 현재 시각 + 1분을 stopTime 으로.
  #  timezone 은 앱 도메인/리전에 맞춰(예: Asia/Seoul). 계약: {startTime,stopTime,days,timezone}
  local schedule
  schedule="$(node -e '
    const tz = process.env.E2E_TZ || "Asia/Seoul";
    const now = new Date(Date.now() + 60*1000);
    // HH:MM (로컬 표기는 단순화 — 실제로는 tz 반영 필요. dev 검증용 근사).
    const hh = String(now.getUTCHours()).padStart(2,"0");
    const mm = String(now.getUTCMinutes()).padStart(2,"0");
    process.stdout.write(JSON.stringify({ startTime: "00:00", stopTime: hh+":"+mm, days: [0,1,2,3,4,5,6], timezone: "UTC" }));
  ')"
  e2e::log "스케줄(1분 뒤 중지 근사): ${schedule}"

  local appId; appId="$(create_app "e2e-wake" "${sub}" "${url}" "schedule" "${schedule}")"
  cleanup_4() { cleanup_app "${appId:-}"; }
  trap cleanup_4 RETURN

  e2e::wait_for "wake 앱 배포 완주" 1200 20 app_settled "${appId}" || return 1
  e2e::assert_fn "status=ACTIVE" app_status_is "${appId}" ACTIVE

  # 스케줄 중지 시각 이후 runtimeState → SLEEPING 전환 대기(task 0 + 리스너 규칙 Waker 전환).
  e2e::wait_for "스케줄 중지 → SLEEPING 전환" 300 15 app_runtime_is "${appId}" SLEEPING \
    || { e2e::fail "스케줄 중지가 SLEEPING 으로 반영되지 않음"; return 1; }
  e2e::ok "SLEEPING 전환 확인(잠자기)"

  # 앱 URL 접속 → Waker 가 대기 페이지(200) 반환 + 기동 시작.
  local host="${sub}.${APPS_DOMAIN}"
  local code; code="$(e2e::http_status "https://${host}/")"
  if [[ "${code}" == "200" ]]; then e2e::ok "잠자는 앱 접속 시 대기 페이지 200(Waker)"; else e2e::fail "잠자는 앱 접속 응답 ${code}(200 대기페이지 기대)"; fi

  # runtimeState → WAKING → RUNNING 복원.
  e2e::wait_for "wake 후 RUNNING 복원" 300 10 app_runtime_is "${appId}" RUNNING \
    || { e2e::fail "wake 후 RUNNING 복원 실패"; return 1; }

  # 복원 후 앱 실제 응답(/health 200) 확인.
  http_health_wake() { [[ "$(e2e::http_status "https://${host}/health")" == "200" ]]; }
  e2e::wait_for "복원 후 앱 /health 200" 120 10 http_health_wake \
    || e2e::fail "복원 후 앱 응답 실패"

  e2e::log "유휴 15분 재중지는 알람 히스토리로 검증(대기 생략) — 관측만 로깅"
  e2e::ok "시나리오 4 통과 (스케줄 중지 → wake → 복원)"
}

################################################################################
# 시나리오 5 — 웹 UI (Playwright)
################################################################################
scenario_5() {
  e2e::step "시나리오 5: 웹 UI (Playwright)"
  local webUrl="${E2E_WEB_URL:-}"
  if [[ -z "${webUrl}" ]]; then
    # CloudFront 도메인에서 유추.
    local cf; cf="$(e2e::_stack_output "apphub-${STAGE}-platform" CloudFrontDomain)"
    [[ -n "${cf}" && "${cf}" != "None" ]] && webUrl="https://${cf}"
  fi
  if [[ -z "${webUrl}" ]]; then
    e2e::fail "SPA URL을 알 수 없습니다. E2E_WEB_URL 을 설정하세요."
    return 1
  fi
  e2e::log "SPA URL=${webUrl}"

  if ! command -v npx >/dev/null 2>&1; then
    e2e::fail "npx 가 없어 Playwright 실행 불가. Node/npm 설치 확인."
    return 1
  fi

  # Playwright spec 실행(e2e/web). BASE_URL/자격은 환경변수로 전달.
  e2e::log "Playwright 실행: e2e/web"
  (
    cd "${SCRIPT_DIR}/web"
    E2E_WEB_URL="${webUrl}" \
    E2E_ADMIN_USERNAME="${E2E_ADMIN_USERNAME:-}" \
    E2E_ADMIN_PASSWORD="${E2E_ADMIN_PASSWORD:-}" \
      npx playwright test
  ) || { e2e::fail "Playwright 시나리오 실패"; return 1; }

  e2e::ok "시나리오 5 통과 (웹 UI)"
}

################################################################################
# 실행 디스패치
################################################################################
FAILED=0
run_one() {
  local n="$1"
  case "${n}" in
    1) scenario_1 || FAILED=1 ;;
    2) scenario_2 || FAILED=1 ;;
    3) scenario_3 || FAILED=1 ;;
    4) scenario_4 || FAILED=1 ;;
    5) scenario_5 || FAILED=1 ;;
    *) e2e::fail "알 수 없는 시나리오 번호: ${n}"; FAILED=1 ;;
  esac
}

e2e::step "라이브 E2E 시작 (stage=${STAGE}, scenarios=${SCENARIOS})"
IFS=',' read -ra NUMS <<< "${SCENARIOS}"
for n in "${NUMS[@]}"; do
  run_one "$(echo "${n}" | tr -d ' ')"
done

e2e::step "결과 요약"
if [[ "${FAILED}" -eq 0 ]]; then
  e2e::ok "전체 E2E 통과"
  exit 0
else
  e2e::fail "일부 E2E 실패 — 위 로그 확인"
  exit 1
fi
