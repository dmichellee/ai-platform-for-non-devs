#!/usr/bin/env bash
#
# AppHub 라이브 E2E (릴리스 게이트).
#
# 실제 AWS(dev 스테이지)에 대해 골든 샘플 앱의 배포 전 여정을 검증한다.
# 실제 비용(소액)과 시간(~30분)이 든다. self-contained — 퍼블릭 애셋 사용자가
# 플랫폼 설치 후 검증용으로도 쓸 수 있다.
#
# 사용:
#   ./e2e/run-e2e.sh --stage dev [--region ap-northeast-2] [--scenario 1,2,3,4,5] [--keep]
#   ./e2e/run-e2e.sh --stage dev --scenario 6 [--cleanup-shard]   # ALB 증설(dev 전용, 명시 실행만)
#   E2E_INTERNAL_TUNNEL=1 ./e2e/run-e2e.sh --stage dev            # 노트북에서 internal 앱 URL 확인(SSM 터널)
#
# 선행조건(라이브 실행 시 — 이 스크립트는 만들지 않는다):
#   1. deploy.sh --stage dev 로 플랫폼(network+platform)이 배포돼 있을 것.
#   2. 관리자 화면(또는 API)에서: provider 활성화(codecommit) /
#      컴퓨팅 프리셋 1개 이상 / 권한 템플릿 1개 이상.
#      (앱 배치 네트워크는 플랫폼 VPC 자동 — VPC 등록 없음)
#   3. 테스트 사용자 2명(user/admin)이 확정 비밀번호로 존재. 로그인은 SPA 와 같은
#      InitiateAuth(USER_PASSWORD_AUTH) — SPA 앱 클라이언트 기본 설정 그대로(관리자 권한 API 불필요).
#      자격 증명은 환경변수로 주입: E2E_USERNAME/E2E_PASSWORD,
#      E2E_ADMIN_USERNAME/E2E_ADMIN_PASSWORD.
#   4. Playwright 시나리오(5)는 SPA URL 필요: E2E_WEB_URL > ConsoleUrl Output
#      (https://console.{appsDomain}) > CloudFrontDomain 순. `npx playwright install` 완료.
#   4-1. FrontendMode=private 이면 ApiUrl(Private API)·콘솔(internal ALB)이 VPC 안에서만 닿는다 —
#      사내망/VPN/베스천에서 실행할 것.
#   5. 소스 리포 준비 방식: 기본은 CodeCommit(provider=codecommit) 리포를 앱별로
#      만들고 픽스처를 push한다. github/gitlab로 하려면 환경변수 E2E_PROVIDER 등 조정.
#
# 안전장치: 생성한 앱은 전역 목록에 기록되어 시나리오 종료 시, 그리고 스크립트 EXIT/INT/TERM trap 에서
#           삭제를 시도한다(--keep 지정 시 보존). 터널(E2E_INTERNAL_TUNNEL=1) 리소스도 EXIT trap 에서 정리.
#           앱 이름/서브도메인에 'e2e-' 접두어를 붙여 야간 정리 스크립트가 걸러낼 수 있게 한다.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
FIXTURES_DIR="${SCRIPT_DIR}/fixtures"

# ── 인자 파싱 ────────────────────────────────────────────────────────────────
STAGE=""
REGION="ap-northeast-2"
SCENARIOS="1,2,3,4,5"   # 6(ALB 증설)은 기본에 넣지 않는다 — --scenario 6 으로만 실행.
KEEP="false"
CLEANUP_SHARD="false"

usage() {
  cat <<'USAGE'
사용법: run-e2e.sh --stage <dev|prod> [옵션]
  --stage <dev|prod>     (필수) 대상 스테이지
  --region <region>      기본: ap-northeast-2
  --scenario "1,2,..."   실행할 시나리오 번호(콤마). 기본: 1,2,3,4,5
  --keep                 생성한 앱을 삭제하지 않고 보존(디버깅용)
  --cleanup-shard        (시나리오 6) 증설 ALB 스택 apphub-{stage}-alb-internal-1 과
                         레지스트리 항목까지 삭제. 미지정 시 증설 스택은 남겨 둔다.
시나리오 6(ALB 증설, dev 전용)은 기본 목록에 없다: --scenario 6 으로만 실행.
환경변수:
  E2E_USERNAME/E2E_PASSWORD              user 그룹 테스트 자격
  E2E_ADMIN_USERNAME/E2E_ADMIN_PASSWORD  admin 그룹 테스트 자격
  E2E_PRESET_ID / E2E_PERM_ID            앱 생성에 쓸 프리셋/권한 (미지정 시 목록 첫 항목)
  E2E_WEB_URL                            SPA URL(시나리오 5). 미지정 시 ConsoleUrl → CloudFrontDomain
  E2E_COGNITO_IDP_ENDPOINT               (선택) 로그인 API 엔드포인트 재지정(--endpoint-url)
  E2E_INTERNAL_TUNNEL=1                  internal 앱 URL 확인을 SSM 포트 포워딩 터널로(임시 EC2 t4g.nano)
  E2E_TUNNEL_PORT                        터널 로컬 포트(기본 8443, 증설 ALB n 은 +n)
  E2E_TUNNEL_KEEP=1                      종료 시 터널 리소스 보존 / E2E_TUNNEL_DELETE_ROLE=1 역할까지 삭제
  E2E_CURL_INSECURE=1                    앱 URL 확인 시 인증서 검증 끔(-k)
  E2E_CLEANUP_SETTLE_TIMEOUT             시나리오 종료 정리 시 CREATING 앱 settle 대기 상한(기본 600s)
  E2E_EXIT_SETTLE_TIMEOUT                EXIT trap 정리 시 settle 대기 상한(기본 120s)
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stage)    STAGE="${2:-}"; shift 2 ;;
    --region)   REGION="${2:-}"; shift 2 ;;
    --scenario) SCENARIOS="${2:-}"; shift 2 ;;
    --keep)     KEEP="true"; shift ;;
    --cleanup-shard) CLEANUP_SHARD="true"; shift ;;
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

# ── 생성 앱 추적 + 종료 정리(EXIT/INT/TERM) ──────────────────────────────────
# 시나리오 안의 assert(exit)·Ctrl-C 로 끝나도 생성한 앱/터널이 남지 않게 한다.
E2E_TRACKED_APPS=()
E2E_EXIT_DONE="false"
S6_ACTIVE="false"

track_app() { [[ -n "${1:-}" ]] && E2E_TRACKED_APPS+=("$1"); return 0; }
# 이번 실행이 만든 CodeCommit 리포(종료 시 삭제 — 앱 삭제는 리포를 지우지 않는다).
#  리포 생성은 `$(prepare_codecommit_repo ...)` 서브셸 안에서 일어나므로 배열 대신 파일에 기록한다.
E2E_REPO_LOG="$(mktemp -t apphub-e2e-repos.XXXXXX)"
track_repo() { [[ -n "${1:-}" ]] && echo "$1" >> "${E2E_REPO_LOG}"; return 0; }
cleanup_created_repos() {
  [[ "${KEEP}" == "true" || ! -s "${E2E_REPO_LOG}" ]] && { rm -f "${E2E_REPO_LOG}"; return 0; }
  local r
  for r in $(sort -u "${E2E_REPO_LOG}"); do
    case "${r}" in apphub-e2e-*) ;; *) continue ;; esac   # 안전장치: e2e 접두어만 삭제
    aws codecommit delete-repository --repository-name "${r}" --region "${REGION}" >/dev/null 2>&1 \
      && e2e::log "정리: 리포 ${r} 삭제" || e2e::log "정리: 리포 ${r} 삭제 실패(수동 확인)"
  done
  rm -f "${E2E_REPO_LOG}"
}
untrack_app() {
  local target="$1" id
  local keep=()
  for id in ${E2E_TRACKED_APPS[@]+"${E2E_TRACKED_APPS[@]}"}; do
    [[ "${id}" != "${target}" ]] && keep+=("${id}")
  done
  E2E_TRACKED_APPS=(${keep[@]+"${keep[@]}"})
}

on_exit() {
  local rc=$?
  [[ "${E2E_EXIT_DONE}" == "true" ]] && return 0
  E2E_EXIT_DONE="true"
  set +e
  trap - INT TERM
  # 정리 함수 내부의 exit(로그인 실패 등)가 나머지 정리를 막지 않도록 서브셸에서 실행.
  if [[ "${S6_ACTIVE}" == "true" ]] && declare -F s6_cleanup >/dev/null; then
    ( s6_cleanup ) || true
  fi
  if [[ ${#E2E_TRACKED_APPS[@]} -gt 0 ]] && declare -F cleanup_tracked_apps >/dev/null; then
    ( cleanup_tracked_apps "${E2E_EXIT_SETTLE_TIMEOUT:-120}" exit ) || true
  fi
  ( cleanup_created_repos ) || true
  e2e::tunnel_down
  exit "${rc}"
}
trap on_exit EXIT
trap 'e2e::fail "중단 신호(INT) — 정리 후 종료"; exit 130' INT
trap 'e2e::fail "중단 신호(TERM) — 정리 후 종료"; exit 143' TERM

# ── 사전 점검 ────────────────────────────────────────────────────────────────
e2e::step "0. 사전 점검"
for c in aws node curl git; do
  command -v "$c" >/dev/null 2>&1 || { e2e::fail "'$c' 명령이 필요합니다."; exit 1; }
done
aws sts get-caller-identity >/dev/null 2>&1 || { e2e::fail "AWS 자격 증명이 없습니다."; exit 1; }

# CodeCommit push 경로(시나리오 1~4, 6) — git-remote-codecommit(codecommit:: 원격) 필요.
if [[ ",${SCENARIOS// /}," =~ ,(1|2|3|4|6), ]]; then
  grc="$(command -v git-remote-codecommit 2>/dev/null || true)"
  if [[ -z "${grc}" ]]; then
    e2e::fail "'git-remote-codecommit' 이 PATH 에 없습니다(픽스처 push 에 필요)."
    e2e::fail "  설치: pip install git-remote-codecommit  (설치한 Python 의 bin 이 PATH 에 있어야 함)"
    if command -v pyenv >/dev/null 2>&1; then
      e2e::fail "  pyenv 사용 중이면 설치된 버전을 지정하세요: PYENV_VERSION=<버전> ./e2e/run-e2e.sh ..."
      e2e::fail "  (설치된 버전 확인: pyenv whence git-remote-codecommit)"
    fi
    exit 1
  fi
  # pyenv shim 은 다른 버전에만 설치돼 있어도 command -v 에 잡힌다 → 현재 버전에서 실제 실행 가능한지 확인.
  if [[ "${grc}" == *"/.pyenv/shims/"* ]] && command -v pyenv >/dev/null 2>&1; then
    if ! pyenv which git-remote-codecommit >/dev/null 2>&1; then
      e2e::fail "git-remote-codecommit 이 현재 pyenv 버전($(pyenv version-name 2>/dev/null || echo '?'))에 없습니다."
      e2e::fail "  설치된 버전: $(pyenv whence git-remote-codecommit 2>/dev/null | tr '\n' ' ')"
      e2e::fail "  예: PYENV_VERSION=<위 버전> ./e2e/run-e2e.sh ...  또는 현재 버전에 pip install git-remote-codecommit"
      exit 1
    fi
  fi
  e2e::log "git-remote-codecommit=${grc}"
fi

e2e::load_outputs
e2e::cognito_login "${E2E_USERNAME:-}" "${E2E_PASSWORD:-}"

# internal 앱 접속 경로: 터널(옵션) 준비 + 동작 검증(internal ALB 기본 응답 404 "No app for this host").
if e2e::tunnel_enabled; then
  e2e::tunnel_up || { e2e::fail "터널 준비 실패 — EXIT trap 이 만든 리소스를 정리합니다"; exit 1; }
  probe_url="https://e2e-tunnel-probe.${APPS_DOMAIN}/"
  probe_out="$(e2e::app_curl "${probe_url}" -s --connect-timeout 10 --max-time 20 -w '\n%{http_code}' 2>/dev/null || true)"
  probe_code="${probe_out##*$'\n'}"
  if [[ "${probe_code}" == "404" && "${probe_out}" == *"No app for this host"* ]]; then
    e2e::ok "터널 동작 확인: internal ALB 기본 응답 404 \"No app for this host\" (TLS 검증 통과)"
  elif [[ -n "${probe_code}" && "${probe_code}" != "000" ]]; then
    e2e::log "[WARN] 터널 응답 HTTP ${probe_code}(기대 404 기본 응답) — 연결은 됨, 계속 진행"
  else
    e2e::fail "터널 경유 internal ALB 응답 없음(HTTP 000). 인증서 문제면 E2E_CURL_INSECURE=1 로 재확인."
    exit 1
  fi
else
  e2e::log "[INFO] E2E_INTERNAL_TUNNEL 미설정 — internal 앱 URL 확인은 VPC 안(사내망/VPN/베스천)에서만 성공합니다."
fi

# 앱 생성에 필요한 프리셋/권한 결정(미지정 시 목록 첫 항목). 일반 사용자 토큰이므로
# 관리자 API(/admin/*)가 아닌 마법사 카탈로그(/presets, /permission-templates)를 쓴다.
# 앱 배치 네트워크는 플랫폼 VPC 자동 — vpcId 는 계약에서 제거됨(2차 로드맵).
resolve_ids() {
  if [[ -z "${E2E_PRESET_ID:-}" ]]; then
    local presets; presets="$(e2e::api GET /presets 2>/dev/null || true)"
    E2E_PRESET_ID="$(e2e::json "${presets}" 'data.items.0.presetId' 2>/dev/null || true)"
  fi
  if [[ -z "${E2E_PERM_ID:-}" ]]; then
    local perms; perms="$(e2e::api GET /permission-templates 2>/dev/null || true)"
    E2E_PERM_ID="$(e2e::json "${perms}" 'data.items.0.permId' 2>/dev/null || true)"
  fi
  e2e::log "preset=${E2E_PRESET_ID:-<none>} perm=${E2E_PERM_ID:-<none>}"
  if [[ -z "${E2E_PRESET_ID:-}" || -z "${E2E_PERM_ID:-}" ]]; then
    e2e::fail "프리셋/권한 템플릿이 준비되지 않았습니다. 관리자 설정을 먼저 완료하세요(선행조건 2)."
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
    aws codecommit create-repository --repository-name "${reponame}" --region "${REGION}" >/dev/null \
      || { e2e::fail "CodeCommit 리포 생성 실패(${reponame})"; return 1; }
    track_repo "${reponame}"
  fi
  local cloneUrl
  cloneUrl="$(aws codecommit get-repository --repository-name "${reponame}" --region "${REGION}" \
    --query 'repositoryMetadata.cloneUrlHttp' --output text)" \
    || { e2e::fail "CodeCommit 리포 조회 실패(${reponame})"; return 1; }

  # 픽스처를 임시 워크트리에 복사하고 push (git-remote-codecommit 또는 자격 도우미 필요).
  # 호출부가 `|| ...` 문맥이라 set -e 가 꺼져 있다 → 단계마다 명시적으로 실패 처리.
  local work; work="$(mktemp -d)"
  cp -R "${FIXTURES_DIR}/${fixture}/." "${work}/" || { rm -rf "${work}"; e2e::fail "픽스처 복사 실패(${fixture})"; return 1; }
  if ! (
    cd "${work}" || exit 1
    git init -q || exit 1
    git checkout -q -b main || exit 1
    git add -A || exit 1
    git -c user.email="e2e@apphub.local" -c user.name="apphub-e2e" commit -q -m "e2e fixture: ${fixture}" || exit 1
    # push — CodeCommit HTTPS(git-remote-codecommit: codecommit::{region}://{repo}) 권장.
    git remote add origin "codecommit::${REGION}://${reponame}" 2>/dev/null \
      || git remote set-url origin "codecommit::${REGION}://${reponame}" || exit 1
    git push -q -u origin main --force || exit 1
  ) >&2; then
    rm -rf "${work}"
    e2e::fail "픽스처 push 실패(${fixture} → ${reponame}) — git-remote-codecommit/PYENV_VERSION/자격 증명 확인. 시나리오 중단."
    return 1
  fi
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
  if ! (
    cd "${work}" || exit 1
    echo "// e2e redeploy $(date +%s)" >> server.js || exit 1
    git add -A || exit 1
    git -c user.email="e2e@apphub.local" -c user.name="apphub-e2e" commit -q -m "e2e: trigger auto deploy" || exit 1
    git push -q origin HEAD:main || exit 1
  ); then
    rm -rf "${work}"
    e2e::fail "새 커밋 push 실패(${reponame}) — git-remote-codecommit/자격 증명 확인. 시나리오 중단."
    return 1
  fi
  rm -rf "${work}"
}

# 앱 생성 API 호출 → appId echo. 인자: <name> <subdomain> <repoUrl> <sleepMode> [scheduleJson]
create_app() {
  local name="$1" sub="$2" repoUrl="$3" sleepMode="$4" schedule="${5:-}"
  local body
  body="$(node -e '
    const [name, sub, repoUrl, presetId, permId, sleepMode, schedule] = process.argv.slice(1);
    const b = {
      name, subdomain: sub, provider: "codecommit", repoUrl, branch: "main",
      presetId, permissionTemplateId: permId, scheme: "internal",
      autoDeployEnabled: true, sleepMode, envVars: {}, cognitoProtect: false,
    };
    if (sleepMode === "schedule" && schedule) b.schedule = JSON.parse(schedule);
    process.stdout.write(JSON.stringify(b));
  ' "${name}" "${sub}" "${repoUrl}" "${E2E_PRESET_ID}" "${E2E_PERM_ID}" "${sleepMode}" "${schedule}")"
  local resp; resp="$(e2e::api POST /apps "${body}" 201)"
  e2e::json "${resp}" 'data.appId'
}

# 앱 삭제 접수(멱등, --keep 이면 생략). 0=접수/이미 없음/삭제 중, 1=접수 못함.
#  DELETE 는 ACTIVE|FAILED 만 접수한다 → CREATING 이면 settle 까지 최대 <settle_timeout>s 재시도.
cleanup_app() {
  local appId="$1" settle_timeout="${2:-${E2E_CLEANUP_SETTLE_TIMEOUT:-600}}"
  [[ -z "${appId}" ]] && return 0
  [[ "${KEEP}" == "true" ]] && { e2e::log "--keep — 앱 ${appId} 보존"; return 0; }
  local code waited=0
  while true; do
    code="$(e2e::api_status DELETE "/apps/${appId}" 2>/dev/null || true)"
    case "${code}" in
      2??) e2e::log "정리: 앱 ${appId} 삭제 접수(HTTP ${code})"; untrack_app "${appId}"; return 0 ;;
      404) untrack_app "${appId}"; return 0 ;;
    esac
    if app_status_is "${appId}" DELETING; then
      e2e::log "정리: 앱 ${appId} 이미 삭제 중"; untrack_app "${appId}"; return 0
    fi
    if [[ "${waited}" -ge "${settle_timeout}" ]]; then
      e2e::fail "정리: 앱 ${appId} 삭제 접수 실패(HTTP ${code:-?}, ${waited}s 대기)"
      return 1
    fi
    e2e::log "정리: 앱 ${appId} 삭제 불가(HTTP ${code:-?}, CREATING?) — settle 대기 후 재시도"
    sleep 15; waited=$(( waited + 15 ))
  done
}

# 추적 중인 앱 전부 삭제 시도. 사용: cleanup_tracked_apps <settle_timeout> [exit]
#  exit 모드(EXIT trap)면 토큰을 조용히 재발급하고, 남은 appId 를 로그로 안내한다.
cleanup_tracked_apps() {
  local settle_timeout="$1" mode="${2:-}"
  [[ ${#E2E_TRACKED_APPS[@]} -eq 0 ]] && return 0
  if [[ "${KEEP}" == "true" ]]; then
    e2e::log "--keep — 생성 앱 보존: ${E2E_TRACKED_APPS[*]}"
    return 0
  fi
  [[ "${mode}" == "exit" ]] && e2e::step "종료 정리: 생성 앱 ${#E2E_TRACKED_APPS[@]}개 삭제 시도"
  # 시나리오가 길면 ID 토큰(1시간)이 만료돼 DELETE 가 401 이 된다 — 정리 전에 항상 조용히 재발급.
  local tok
  tok="$(e2e::cognito_login "${E2E_USERNAME:-}" "${E2E_PASSWORD:-}" >/dev/null 2>&1; echo "${JWT_TOKEN:-}")"
  [[ -n "${tok}" ]] && JWT_TOKEN="${tok}"
  local id
  for id in ${E2E_TRACKED_APPS[@]+"${E2E_TRACKED_APPS[@]}"}; do
    cleanup_app "${id}" "${settle_timeout}" || true
  done
  if [[ ${#E2E_TRACKED_APPS[@]} -gt 0 ]]; then
    e2e::fail "정리되지 않은 앱: ${E2E_TRACKED_APPS[*]} — 콘솔 또는 'DELETE /apps/{appId}' 로 수동 삭제하세요."
    return 1
  fi
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
  local url_ok; url_ok="$(prepare_codecommit_repo sample-ok "${repo_ok}")" || return 1

  # 정리: 생성 앱은 track_app 으로 전역 목록에 → 시나리오 종료/EXIT trap 에서 삭제.
  local appId_ok
  appId_ok="$(create_app "e2e-ok" "${sub_ok}" "${url_ok}" "always-on")" || return 1
  track_app "${appId_ok}"
  e2e::log "앱 생성됨: ${appId_ok} (subdomain=${sub_ok})"

  # 파이프라인 완주 대기(빌드+배포). 상한 20분.
  e2e::wait_for "sample-ok 배포 완주(status settle)" 1200 20 app_settled "${appId_ok}" \
    || { e2e::fail "배포 완주 실패"; return 1; }
  e2e::assert_fn "sample-ok status=ACTIVE" app_status_is "${appId_ok}" ACTIVE

  # 발급 URL HTTPS 200 (internal 앱 — VPC 내부 또는 E2E_INTERNAL_TUNNEL=1 터널 경유).
  local host_ok="${sub_ok}.${APPS_DOMAIN}"
  e2e::log "발급 URL: https://${host_ok}/health"
  http_health_ok() { [[ "$(e2e::app_http_status "https://${host_ok}/health")" == "200" ]]; }
  e2e::wait_for "sample-ok /health HTTPS 200" 300 10 http_health_ok \
    || e2e::fail "발급 URL 200 실패(internal 앱 — VPC 내부에서 실행하거나 E2E_INTERNAL_TUNNEL=1 사용)"

  # ── 스트리밍 앱 ──
  local sub_st; sub_st="$(uniq_sub stream)"
  local repo_st="apphub-e2e-stream-${sub_st}"
  local url_st; url_st="$(prepare_codecommit_repo sample-streaming "${repo_st}")" || return 1
  local appId_st; appId_st="$(create_app "e2e-stream" "${sub_st}" "${url_st}" "always-on")" || return 1
  track_app "${appId_st}"
  e2e::wait_for "sample-streaming 배포 완주" 1200 20 app_settled "${appId_st}" || return 1

  local host_st="${sub_st}.${APPS_DOMAIN}"
  # 스트리밍 검증: /stream 응답의 청크가 시간차로 도착하는지(버퍼링 없이).
  e2e::log "스트리밍 검증: https://${host_st}/stream"
  local stream_out
  stream_out="$(e2e::app_curl "https://${host_st}/stream" -s -N --connect-timeout 10 --max-time 30 2>/dev/null || true)"
  if echo "${stream_out}" | grep -q "chunk-1" && echo "${stream_out}" | grep -q "\[DONE\]"; then
    e2e::ok "스트리밍 응답 수신(chunk + [DONE])"
  else
    e2e::fail "스트리밍 응답 확인 실패. 받은 내용: ${stream_out:0:200}"
  fi

  # ── 삭제 + 리소스 누수 검사 ──
  e2e::log "삭제 접수: ${appId_ok}, ${appId_st}"
  e2e::api DELETE "/apps/${appId_ok}" "" "" >/dev/null
  e2e::wait_for "sample-ok 삭제 완료(404)" 1200 20 app_gone "${appId_ok}" || return 1
  untrack_app "${appId_ok}"
  e2e::assert_no_leak "${appId_ok}" "${sub_ok}" || return 1

  e2e::api DELETE "/apps/${appId_st}" "" "" >/dev/null
  e2e::wait_for "sample-streaming 삭제 완료(404)" 1200 20 app_gone "${appId_st}" || return 1
  untrack_app "${appId_st}"
  e2e::assert_no_leak "${appId_st}" "${sub_st}" || return 1

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
  local pass=0
  for spec in "${specs[@]}"; do
    local fixture="${spec%%:*}" want="${spec##*:}"
    local sub; sub="$(uniq_sub fail)"
    local reponame="apphub-e2e-${fixture}-${sub}"
    e2e::log "--- ${fixture} (기대 ${want}) ---"
    local url; url="$(prepare_codecommit_repo "${fixture}" "${reponame}")" || return 1
    local appId; appId="$(create_app "e2e-${fixture}" "${sub}" "${url}" "always-on")" || return 1
    track_app "${appId}"

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
  local url; url="$(prepare_codecommit_repo sample-ok "${reponame}")" || return 1
  local appId; appId="$(create_app "e2e-auto" "${sub}" "${url}" "always-on")" || return 1
  track_app "${appId}"

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
  local url; url="$(prepare_codecommit_repo sample-ok "${reponame}")" || return 1

  # 스케줄: 첫 배포(검증·빌드·배포 약 8~10분)가 끝난 뒤 중지되도록 현재 + E2E_SCHEDULE_STOP_MIN(기본 14)분.
  #  (중지 시각이 배포 완료 전이면 오늘 실행이 지나가 다음 날까지 SLEEPING 이 오지 않는다.)
  #  timezone 은 앱 도메인/리전에 맞춰(예: Asia/Seoul). 계약: {startTime,stopTime,days,timezone}
  local schedule
  schedule="$(node -e '
    const tz = process.env.E2E_TZ || "Asia/Seoul";
    const now = new Date(Date.now() + (Number(process.env.E2E_SCHEDULE_STOP_MIN || 14))*60*1000);
    // HH:MM (로컬 표기는 단순화 — 실제로는 tz 반영 필요. dev 검증용 근사).
    const hh = String(now.getUTCHours()).padStart(2,"0");
    const mm = String(now.getUTCMinutes()).padStart(2,"0");
    process.stdout.write(JSON.stringify({ startTime: "00:00", stopTime: hh+":"+mm, days: [0,1,2,3,4,5,6], timezone: "UTC" }));
  ')"
  e2e::log "스케줄(중지 = 지금 + ${E2E_SCHEDULE_STOP_MIN:-14}분, UTC): ${schedule}"

  local appId; appId="$(create_app "e2e-wake" "${sub}" "${url}" "schedule" "${schedule}")" || return 1
  track_app "${appId}"

  e2e::wait_for "wake 앱 배포 완주" 1200 20 app_settled "${appId}" || return 1
  e2e::assert_fn "status=ACTIVE" app_status_is "${appId}" ACTIVE

  # 스케줄 중지 시각 이후 runtimeState → SLEEPING 전환 대기(task 0 + 리스너 규칙 Waker 전환).
  # 배포가 중지 시각보다 늦게 끝나면 오늘 중지는 이미 지나간 것 — 원인을 분명히 남기고 실패.
  local stop_epoch; stop_epoch="$(node -e 'const s=JSON.parse(process.argv[1]);const [h,m]=s.stopTime.split(":").map(Number);const d=new Date();d.setUTCHours(h,m,0,0);process.stdout.write(String(Math.floor(d.getTime()/1000)))' "${schedule}")"
  local now_epoch; now_epoch="$(date +%s)"
  if [[ "${now_epoch}" -gt "${stop_epoch}" ]]; then
    e2e::fail "첫 배포가 예정 중지 시각보다 늦게 끝남 — E2E_SCHEDULE_STOP_MIN 을 늘려 재실행"; return 1
  fi
  local wait_s=$(( stop_epoch - now_epoch + 300 ))
  e2e::log "중지 예정까지 $(( stop_epoch - now_epoch ))s — SLEEPING 전환을 최대 ${wait_s}s 대기"
  e2e::wait_for "스케줄 중지 → SLEEPING 전환" "${wait_s}" 15 app_runtime_is "${appId}" SLEEPING \
    || { e2e::fail "스케줄 중지가 SLEEPING 으로 반영되지 않음"; return 1; }
  e2e::ok "SLEEPING 전환 확인(잠자기)"

  # 앱 URL 접속 → Waker 가 대기 페이지(200) 반환 + 기동 시작.
  local host="${sub}.${APPS_DOMAIN}"
  #  잠자기 직후에는 리스너 규칙 변경 전파·기존 태스크 드레이닝 동안 앱이 직접 200 을 줄 수 있다 —
  #  상태 코드가 아니라 Waker 대기 페이지 문구가 보일 때까지 5초 간격으로 재접속한다(브라우저 자동 새로고침과 동일).
  local waker_marker="앱을 준비하는 중이에요"
  saw_waker_page() { e2e::app_curl "https://${host}/" -s --connect-timeout 10 --max-time 30 2>/dev/null | grep -q "${waker_marker}"; }
  e2e::wait_for "잠자는 앱 접속 시 Waker 대기 페이지" 180 5 saw_waker_page \
    || { e2e::fail "Waker 대기 페이지가 나오지 않음(요청이 Waker 로 가지 않음)"; return 1; }
  e2e::ok "잠자는 앱 접속 시 대기 페이지(Waker) 확인"

  # runtimeState → WAKING → RUNNING 복원. 대기 중에도 브라우저처럼 계속 접속한다.
  runtime_running_with_refresh() { e2e::app_http_status "https://${host}/" >/dev/null; app_runtime_is "${appId}" RUNNING; }
  e2e::wait_for "wake 후 RUNNING 복원" 300 10 runtime_running_with_refresh \
    || { e2e::fail "wake 후 RUNNING 복원 실패"; return 1; }

  # 복원 후 앱 실제 응답(/health 200) 확인.
  http_health_wake() { [[ "$(e2e::app_http_status "https://${host}/health")" == "200" ]]; }
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
  # 우선순위: E2E_WEB_URL > ConsoleUrl Output(D19: https://console.{appsDomain}) > CloudFrontDomain.
  local webUrl="${E2E_WEB_URL:-}"
  if [[ -z "${webUrl}" && -n "${CONSOLE_URL:-}" ]]; then
    webUrl="${CONSOLE_URL}"
  fi
  if [[ -z "${webUrl}" ]]; then
    # 구버전 플랫폼(ConsoleUrl 없음) 폴백 — public 모드에서만 존재.
    local cf; cf="$(e2e::_stack_output "apphub-${STAGE}-platform" CloudFrontDomain)"
    [[ -n "${cf}" && "${cf}" != "None" ]] && webUrl="https://${cf}"
  fi
  if [[ -z "${webUrl}" ]]; then
    e2e::fail "SPA URL을 알 수 없습니다. E2E_WEB_URL 을 설정하세요."
    return 1
  fi
  e2e::log "SPA URL=${webUrl}"
  if [[ "${FRONTEND_MODE:-public}" == "private" ]]; then
    e2e::log "[WARN] private 모드 — 콘솔은 internal ALB 뒤에 있어 사내망/VPN 에서만 열립니다."
  fi

  if ! command -v npx >/dev/null 2>&1; then
    e2e::fail "npx 가 없어 Playwright 실행 불가. Node/npm 설치 확인."
    return 1
  fi

  # Playwright spec 실행(e2e/web). BASE_URL/자격은 환경변수로 전달.
  e2e::log "Playwright 실행: e2e/web"
  (
    cd "${SCRIPT_DIR}/web"
    E2E_WEB_URL="${webUrl}" \
    E2E_USERNAME="${E2E_USERNAME:-}" \
    E2E_PASSWORD="${E2E_PASSWORD:-}" \
    E2E_ADMIN_USERNAME="${E2E_ADMIN_USERNAME:-}" \
    E2E_ADMIN_PASSWORD="${E2E_ADMIN_PASSWORD:-}" \
      npx playwright test
  ) || { e2e::fail "Playwright 시나리오 실패"; return 1; }

  e2e::ok "시나리오 5 통과 (웹 UI)"
}

################################################################################
# 시나리오 6 — ALB 증설(D20, 레지스트리 조작) — dev 전용 · 명시 실행만
################################################################################
# 흐름(계약 delta-2026-10-07 §3·§4·§5):
#  (a) internal n=0 ALB 레지스트리(CONFIG/ALB#{arn}) ruleCount 원래 값 백업
#  (b) ruleCount → 80, internal 앱 A 생성 → 배정 후 여유 ≤ 10 → ALBPENDING#internal#1 +
#      provisioner(APP_STACK_KIND=alb) 빌드 → apphub-{stage}-alb-internal-1 CREATE_COMPLETE →
#      ALB#(index=1, ACTIVE) 등록
#  (c) n=0 ruleCount → 90, 앱 B 생성 → App.albIndex=1 배정, 증설 리스너 규칙 + 접속 200
#  (d) 정리: n=0 ruleCount 복원(trap — 실패해도), 앱 A/B 삭제, --cleanup-shard 면 증설 스택 삭제
#
# ruleCount 복원은 "올린 양(delta)만큼 되돌리기"다. 테스트 앱 생성(+1)/삭제(-1)나 동시에 일어난
#  다른 배정이 있어도 결과가 (원래 값 + 그 사이 실제 순증감)이 되어 카운터가 틀어지지 않는다.
S6_SLUG="internal"
S6_INDEX=1
S6_N0_SK=""
S6_N0_ORIG=""
S6_N0_DELTA=0
S6_APP_A=""
S6_APP_B=""
S6_BUILD_ID=""
S6_CLEANED="false"

s6_stack_name() { echo "apphub-${STAGE}-alb-${S6_SLUG}-${S6_INDEX}"; }

# ALB# 항목 중 internal + index 일치 1건(평문 JSON) 또는 빈 문자열.
s6_find_alb() {
  local index="$1"
  e2e::ddb_config_query "ALB#" | E2E_I="${index}" E2E_SLUG="${S6_SLUG}" node -e '
    const a = JSON.parse(require("fs").readFileSync(0, "utf8") || "[]");
    const slug = (x) => x.schemeSlug || (x.scheme === "internet-facing" ? "internet" : x.scheme);
    const f = a.find((x) => slug(x) === process.env.E2E_SLUG && Number(x.index || 0) === Number(process.env.E2E_I));
    if (f) process.stdout.write(JSON.stringify(f));
  '
}

# internal ALB# 중 index ≥ 1 개수(기존 증설 존재 여부).
s6_count_shards() {
  e2e::ddb_config_query "ALB#" | E2E_SLUG="${S6_SLUG}" node -e '
    const a = JSON.parse(require("fs").readFileSync(0, "utf8") || "[]");
    const slug = (x) => x.schemeSlug || (x.scheme === "internet-facing" ? "internet" : x.scheme);
    process.stdout.write(String(a.filter((x) => slug(x) === process.env.E2E_SLUG && Number(x.index || 0) >= 1).length));
  '
}

# 살아있는(ttl 미경과) internal PENDING 개수.
s6_count_pending() {
  e2e::ddb_config_query "ALBPENDING#${S6_SLUG}#" | node -e '
    const a = JSON.parse(require("fs").readFileSync(0, "utf8") || "[]");
    const now = Math.floor(Date.now() / 1000);
    process.stdout.write(String(a.filter((x) => !x.ttl || Number(x.ttl) > now).length));
  '
}

s6_rule_count() {
  local item; item="$(e2e::ddb_config_get "$1")"
  [[ -z "${item}" ]] && return 1
  local n; n="$(e2e::json "${item}" ruleCount)"
  echo "${n:-0}"
}

# n=0 ruleCount 를 target 으로(낙관적 잠금: 읽은 값과 같을 때만). 올린 양을 S6_N0_DELTA 에 누적.
s6_raise_n0() {
  local target="$1"
  local cur; cur="$(s6_rule_count "${S6_N0_SK}")" || { e2e::fail "n=0 레지스트리 항목 없음"; return 1; }
  if (( cur >= target )); then
    e2e::log "n=0 ruleCount=${cur} 가 이미 ${target} 이상 — 조작 생략"
    return 0
  fi
  local delta=$(( target - cur ))
  e2e::ddb_config_update "${S6_N0_SK}" \
    "SET ruleCount = if_not_exists(ruleCount, :zero) + :d" \
    "attribute_exists(SK) AND (attribute_not_exists(ruleCount) OR ruleCount = :cur)" \
    "{\":d\":{\"N\":\"${delta}\"},\":cur\":{\"N\":\"${cur}\"},\":zero\":{\"N\":\"0\"}}" \
    || { e2e::fail "n=0 ruleCount ${cur}→${target} 조작 실패(동시 변경?)"; return 1; }
  S6_N0_DELTA=$(( S6_N0_DELTA + delta ))
  e2e::log "n=0 ruleCount ${cur} → ${target} (누적 delta=${S6_N0_DELTA}, 원래 값=${S6_N0_ORIG})"
}

# 올린 양만큼 되돌린다(멱등 — 성공 후 delta=0).
s6_restore_n0() {
  [[ -z "${S6_N0_SK}" || "${S6_N0_DELTA}" -le 0 ]] && return 0
  if e2e::ddb_config_update "${S6_N0_SK}" \
      "SET ruleCount = ruleCount - :d" \
      "attribute_exists(SK) AND ruleCount >= :d" \
      "{\":d\":{\"N\":\"${S6_N0_DELTA}\"}}"; then
    e2e::ok "n=0 ruleCount 복원(-${S6_N0_DELTA}) → 현재 $(s6_rule_count "${S6_N0_SK}" || echo '?') (백업 원래 값 ${S6_N0_ORIG})"
    S6_N0_DELTA=0
    return 0
  fi
  e2e::fail "n=0 ruleCount 복원 실패 — 수동 복구 필요: SK='${S6_N0_SK}' 에서 ruleCount 를 ${S6_N0_DELTA} 만큼 낮추세요(백업 원래 값 ${S6_N0_ORIG})."
  return 1
}

app_alb_index_is() {
  local appId="$1" want="$2"
  local resp; resp="$(e2e::api GET "/apps/${appId}" 2>/dev/null || true)"
  local idx; idx="$(e2e::json "${resp}" 'data.albIndex' 2>/dev/null || true)"
  [[ -n "${idx}" && "${idx}" == "${want}" ]]
}
app_has_alb_index() {
  local resp; resp="$(e2e::api GET "/apps/$1" 2>/dev/null || true)"
  [[ -n "$(e2e::json "${resp}" 'data.albIndex' 2>/dev/null || true)" ]]
}

# 증설 시작 관측: PENDING(buildId 기록) 또는 이미 ALB#(index=1) 등록.
s6_scaleout_seen() {
  local p; p="$(e2e::ddb_config_get "ALBPENDING#${S6_SLUG}#${S6_INDEX}")"
  if [[ -n "${p}" ]]; then
    S6_BUILD_ID="$(e2e::json "${p}" buildId)"
    [[ -n "${S6_BUILD_ID}" ]] && return 0
    return 1
  fi
  [[ -n "$(s6_find_alb "${S6_INDEX}")" ]]
}

# 증설 스택이 종결 상태인지(성공/실패 모두 — 판정은 호출부).
s6_stack_terminal() {
  case "$(e2e::stack_status "$(s6_stack_name)")" in
    CREATE_COMPLETE|UPDATE_COMPLETE|*_FAILED|ROLLBACK_COMPLETE|*ROLLBACK_COMPLETE) return 0 ;;
    *) return 1 ;;
  esac
}

s6_alb_active() {
  local item; item="$(s6_find_alb "${S6_INDEX}")"
  [[ -n "${item}" && "$(e2e::json "${item}" status)" == "ACTIVE" ]]
}

s6_shard_rule_count_zero() {
  local item; item="$(s6_find_alb "${S6_INDEX}")"
  [[ -z "${item}" ]] && return 0
  local n; n="$(e2e::json "${item}" ruleCount)"
  [[ "${n:-0}" == "0" ]]
}

# 앱 삭제 후 소멸까지 대기(DELETE 는 ACTIVE|FAILED 만 접수 → 먼저 settle 대기).
s6_delete_app_and_wait() {
  local appId="$1"
  [[ -z "${appId}" ]] && return 0
  if app_gone "${appId}"; then return 0; fi
  e2e::wait_for "앱 ${appId} 삭제 가능 상태(settle)" 1200 20 app_settled "${appId}" || true
  e2e::api DELETE "/apps/${appId}" "" "" >/dev/null 2>&1 || true
  e2e::wait_for "앱 ${appId} 삭제 완료(404)" 1200 20 app_gone "${appId}"
}

# 증설 스택 + 레지스트리 정리(index=1 ruleCount 0 확인 → ALB# 조건부 삭제 → 스택 삭제).
s6_cleanup_shard() {
  local stack; stack="$(s6_stack_name)"
  e2e::log "증설 정리: ${stack}"
  if [[ "$(s6_count_pending)" != "0" ]]; then
    e2e::fail "진행 중 증설(ALBPENDING#${S6_SLUG}#*) 이 있어 정리 보류 — 빌드 종료 후 재실행"
    return 1
  fi
  if ! e2e::wait_for "index=${S6_INDEX} ruleCount=0(배정 앱 없음)" 300 15 s6_shard_rule_count_zero; then
    e2e::fail "index=${S6_INDEX} 에 배정된 앱이 남아 있어 증설 스택을 지우지 않습니다."
    return 1
  fi
  local item; item="$(s6_find_alb "${S6_INDEX}")"
  if [[ -n "${item}" ]]; then
    local arn; arn="$(e2e::json "${item}" albArn)"
    [[ -z "${arn}" ]] && arn="$(e2e::json "${item}" SK)" && arn="${arn#ALB#}"
    # 조건: 그 사이 배정이 생기지 않았고(ruleCount=0) index 가 맞을 때만.
    e2e::ddb_config_delete "ALB#${arn}" \
      "attribute_exists(SK) AND #idx = :i AND (attribute_not_exists(ruleCount) OR ruleCount = :zero)" \
      "{\":i\":{\"N\":\"${S6_INDEX}\"},\":zero\":{\"N\":\"0\"}}" \
      '{"#idx":"index"}' \
      || { e2e::fail "ALB# 레지스트리 항목 삭제 실패(조건 불충족)"; return 1; }
    e2e::ok "레지스트리 ALB#(index=${S6_INDEX}) 삭제"
  fi
  if [[ "$(e2e::stack_status "${stack}")" != "MISSING" ]]; then
    aws cloudformation delete-stack --stack-name "${stack}" --region "${REGION}"
    if aws cloudformation wait stack-delete-complete --stack-name "${stack}" --region "${REGION}"; then
      e2e::ok "증설 스택 ${stack} 삭제 완료"
    else
      e2e::fail "증설 스택 ${stack} 삭제 대기 실패(상태: $(e2e::stack_status "${stack}"))"
      return 1
    fi
  fi
}

# 정리(멱등). 순서: ① ruleCount 복원(가장 중요·빠름) ② 앱 삭제 ③ 증설 스택(옵션).
s6_cleanup() {
  [[ "${S6_CLEANED}" == "true" ]] && return 0
  S6_CLEANED="true"
  e2e::step "시나리오 6 정리"
  local rc=0
  s6_restore_n0 || rc=1
  if [[ "${KEEP}" == "true" ]]; then
    e2e::log "--keep — 테스트 앱(${S6_APP_A:-} ${S6_APP_B:-})·증설 스택 보존"
    return "${rc}"
  fi
  # 토큰 만료(1시간) 대비 재로그인.
  [[ -n "${S6_APP_A}${S6_APP_B}" ]] && e2e::cognito_login "${E2E_USERNAME:-}" "${E2E_PASSWORD:-}"
  s6_delete_app_and_wait "${S6_APP_A}" || rc=1
  s6_delete_app_and_wait "${S6_APP_B}" || rc=1
  if [[ "${CLEANUP_SHARD}" == "true" ]]; then
    s6_cleanup_shard || rc=1
  else
    e2e::log "증설 스택 $(s6_stack_name) 보존(--cleanup-shard 미지정). 재실행 전 정리: --scenario 6 --cleanup-shard"
  fi
  return "${rc}"
}

s6_preflight() {
  if [[ "${STAGE}" != "dev" ]]; then
    e2e::fail "시나리오 6은 dev 전용입니다(레지스트리를 직접 조작). --stage dev 로 실행하세요."
    return 1
  fi
  if [[ -z "${TABLE_NAME:-}" || "${TABLE_NAME}" == "None" ]]; then
    e2e::fail "TableName Output 을 찾지 못했습니다."
    return 1
  fi
  local n0arn; n0arn="$(e2e::alb_param "${S6_SLUG}" 0 alb-arn)"
  [[ -z "${n0arn}" ]] && n0arn="$(e2e::_ssm "/apphub/${STAGE}/network/internal-alb-arn")"
  if [[ -z "${n0arn}" || "${n0arn}" == "None" ]]; then
    e2e::fail "n=0 internal ALB ARN(SSM alb/internal/0/alb-arn)을 찾지 못했습니다."
    return 1
  fi
  S6_N0_SK="ALB#${n0arn}"
  e2e::log "n=0 internal ALB = ${n0arn}"

  local shards; shards="$(s6_count_shards)"
  local pending; pending="$(s6_count_pending)"
  local st; st="$(e2e::stack_status "$(s6_stack_name)")"
  if [[ "${shards}" != "0" || "${pending}" != "0" || "${st}" != "MISSING" ]]; then
    if [[ "${CLEANUP_SHARD}" == "true" ]]; then
      e2e::log "기존 증설 흔적(ALB# index≥1: ${shards}, PENDING: ${pending}, 스택: ${st}) — 정리만 수행"
      S6_CLEANED="true"   # 이번 실행은 정리 전용(앱/ruleCount 조작 없음).
      s6_cleanup_shard || return 1
      e2e::ok "시나리오 6 정리 전용 실행 완료 — 다시 --scenario 6 으로 검증하세요"
      return 2
    fi
    e2e::fail "기존 internal 증설 흔적이 있습니다(ALB# index≥1: ${shards}, PENDING: ${pending}, 스택 $(s6_stack_name): ${st})."
    e2e::fail "  선제 증설 조건(여유 ≤ 10)이 성립하지 않으므로 중단합니다. --scenario 6 --cleanup-shard 로 먼저 정리하세요."
    return 1
  fi

  # n=0 항목 백업. 아직 lazy seed 전이면 backend 와 같은 shape 로 조건부 시드(원래 값 0).
  local item; item="$(e2e::ddb_config_get "${S6_N0_SK}")"
  if [[ -z "${item}" ]]; then
    local vpc; vpc="$(e2e::_ssm "/apphub/${STAGE}/network/vpc-id")"
    local vals
    vals="$(E2E_ARN="${n0arn}" E2E_VPC="${vpc}" node -e '
      process.stdout.write(JSON.stringify({
        ":et": {S: "AlbRegistry"}, ":arn": {S: process.env.E2E_ARN}, ":sc": {S: "internal"},
        ":sl": {S: "internal"}, ":zero": {N: "0"}, ":act": {S: "ACTIVE"}, ":vpc": {S: process.env.E2E_VPC || "-"},
      }));')"
    e2e::ddb_config_update "${S6_N0_SK}" \
      "SET entityType = :et, albArn = :arn, scheme = :sc, schemeSlug = :sl, #idx = :zero, #st = :act, ruleCount = :zero, vpcId = :vpc" \
      "attribute_not_exists(SK)" "${vals}" '{"#idx":"index","#st":"status"}' || true
    e2e::log "n=0 레지스트리 항목이 없어 시드함(lazy seed 와 동일 shape)"
  fi
  S6_N0_ORIG="$(s6_rule_count "${S6_N0_SK}")" || { e2e::fail "n=0 레지스트리 조회 실패"; return 1; }
  e2e::log "백업: n=0 ruleCount 원래 값 = ${S6_N0_ORIG}"
  if (( S6_N0_ORIG >= 80 )); then
    e2e::fail "n=0 ruleCount 가 이미 ${S6_N0_ORIG}(≥80) — 실제 증설 조건과 겹쳐 시나리오를 중단합니다."
    return 1
  fi
}

scenario_6_body() {
  resolve_ids
  local pre=0
  s6_preflight || pre=$?
  [[ "${pre}" -eq 2 ]] && return 0   # 정리 전용 실행
  [[ "${pre}" -ne 0 ]] && return 1

  # ── (b) 80 으로 올리고 앱 A 생성 → 선제 증설 ──
  s6_raise_n0 80 || return 1
  local sub_a; sub_a="$(uniq_sub shard-a)"
  local repo_a="apphub-e2e-shard-a-${sub_a}"
  local url_a; url_a="$(prepare_codecommit_repo sample-ok "${repo_a}")" || return 1
  S6_APP_A="$(create_app "e2e-shard-a" "${sub_a}" "${url_a}" "always-on")" || return 1
  e2e::log "앱 A 생성: ${S6_APP_A} (subdomain=${sub_a})"

  e2e::wait_for "앱 A 슬롯 배정" 600 10 app_has_alb_index "${S6_APP_A}" || return 1
  e2e::assert_fn "앱 A albIndex=0(n=0 ALB 에 배정)" app_alb_index_is "${S6_APP_A}" 0

  e2e::wait_for "ALBPENDING#${S6_SLUG}#${S6_INDEX} 생성 + 증설 빌드 시작" 600 10 s6_scaleout_seen || return 1
  if [[ -n "${S6_BUILD_ID}" ]]; then
    local b; b="$(aws codebuild batch-get-builds --ids "${S6_BUILD_ID}" --region "${REGION}" --output json 2>/dev/null || true)"
    local info
    info="$(printf '%s' "${b}" | node -e '
      const d = JSON.parse(require("fs").readFileSync(0, "utf8") || "{}");
      const x = (d.builds || [])[0];
      if (!x) process.exit(0);
      const env = Object.fromEntries(((x.environment || {}).environmentVariables || []).map((v) => [v.name, v.value]));
      process.stdout.write([x.buildStatus, env.APP_STACK_KIND, env.ALB_SCHEME, env.ALB_INDEX].join(" "));
    ')"
    e2e::log "provisioner 빌드 ${S6_BUILD_ID}: ${info:-<조회 실패>}"
    local bstatus kind slug idx
    read -r bstatus kind slug idx <<< "${info}"
    if [[ "${kind}" == "alb" && "${slug}" == "${S6_SLUG}" && "${idx}" == "${S6_INDEX}" \
          && ( "${bstatus}" == "IN_PROGRESS" || "${bstatus}" == "SUCCEEDED" ) ]]; then
      e2e::ok "provisioner(alb kind) 빌드 시작 확인"
    else
      e2e::fail "provisioner 빌드 확인 실패(기대: alb ${S6_SLUG} ${S6_INDEX}, IN_PROGRESS|SUCCEEDED)"
      return 1
    fi
  else
    e2e::log "PENDING 이 이미 종료돼 빌드 ID 를 보지 못함 — ALB# 등록으로 대신 확인"
  fi

  e2e::wait_for "증설 스택 $(s6_stack_name) 종결" 1800 30 s6_stack_terminal || return 1
  local sst; sst="$(e2e::stack_status "$(s6_stack_name)")"
  [[ "${sst}" == "CREATE_COMPLETE" || "${sst}" == "UPDATE_COMPLETE" ]] \
    || { e2e::fail "증설 스택 상태 ${sst}(CREATE_COMPLETE 기대)"; return 1; }
  e2e::ok "증설 스택 ${sst}"

  e2e::wait_for "ALB#(index=${S6_INDEX}) ACTIVE 등록(deploy-notify)" 300 10 s6_alb_active || return 1
  local shard; shard="$(s6_find_alb "${S6_INDEX}")"
  local shard_arn; shard_arn="$(e2e::json "${shard}" albArn)"
  local ssm_arn; ssm_arn="$(e2e::alb_param "${S6_SLUG}" "${S6_INDEX}" alb-arn)"
  [[ -n "${shard_arn}" && "${shard_arn}" == "${ssm_arn}" ]] \
    || { e2e::fail "레지스트리 albArn(${shard_arn}) ≠ SSM alb/${S6_SLUG}/${S6_INDEX}/alb-arn(${ssm_arn})"; return 1; }
  e2e::ok "레지스트리 ALB#(index=${S6_INDEX}, ACTIVE) = SSM 발행 ARN"
  [[ "$(s6_count_pending)" == "0" ]] && e2e::ok "PENDING 정리됨" || e2e::log "[WARN] PENDING 이 아직 남아 있음"

  # ── (c) n=0 을 90(한도)으로 → 앱 B 는 index=1 로 ──
  e2e::cognito_login "${E2E_USERNAME:-}" "${E2E_PASSWORD:-}"   # 토큰 만료 대비
  s6_raise_n0 90 || return 1
  local sub_b; sub_b="$(uniq_sub shard-b)"
  local repo_b="apphub-e2e-shard-b-${sub_b}"
  local url_b; url_b="$(prepare_codecommit_repo sample-ok "${repo_b}")" || return 1
  S6_APP_B="$(create_app "e2e-shard-b" "${sub_b}" "${url_b}" "always-on")" || return 1
  e2e::log "앱 B 생성: ${S6_APP_B} (subdomain=${sub_b})"
  e2e::wait_for "앱 B 슬롯 배정" 600 10 app_has_alb_index "${S6_APP_B}" || return 1
  e2e::assert_fn "앱 B albIndex=${S6_INDEX}(증설 ALB 에 배정)" app_alb_index_is "${S6_APP_B}" "${S6_INDEX}"
  # 배정 확인 즉시 n=0 복원 — 다른 dev 사용자의 앱 생성에 주는 영향 시간을 줄인다.
  s6_restore_n0 || return 1

  e2e::wait_for "앱 B 배포 완주(settle)" 1200 20 app_settled "${S6_APP_B}" || return 1
  e2e::assert_fn "앱 B status=ACTIVE" app_status_is "${S6_APP_B}" ACTIVE

  local host_b="${sub_b}.${APPS_DOMAIN}"
  local lst; lst="$(e2e::alb_param "${S6_SLUG}" "${S6_INDEX}" https-listener-arn)"
  local rule=""
  if [[ -n "${lst}" ]]; then
    rule="$(aws elbv2 describe-rules --listener-arn "${lst}" --region "${REGION}" \
      --query "Rules[?Conditions[?contains(HostHeaderConfig.Values, '${host_b}')]].RuleArn" \
      --output text 2>/dev/null || true)"
  fi
  [[ -n "${rule}" && "${rule}" != "None" ]] \
    || { e2e::fail "증설 ALB 리스너(${lst:-<SSM 없음>})에 ${host_b} 규칙이 없음"; return 1; }
  e2e::ok "증설 ALB 리스너에 ${host_b} 규칙 존재"

  # 접속: /health 200(실행 중) 또는 / 200(잠든 경우 Waker 대기 페이지).
  #  터널 사용 시 앱 B 는 증설 ALB(index=1)에 있으므로 그 ALB 로 가는 포워딩을 추가로 연다.
  if e2e::tunnel_enabled; then
    e2e::tunnel_forward "${S6_SLUG}" "${S6_INDEX}" || return 1
    e2e::tunnel_map_host "${host_b}" "${E2E_TUNNEL_LAST_PORT}"
  fi
  s6_http_ok() {
    [[ "$(e2e::app_http_status "https://${host_b}/health")" == "200" ]] \
      || [[ "$(e2e::app_http_status "https://${host_b}/")" == "200" ]]
  }
  e2e::wait_for "앱 B HTTPS 200(또는 Waker 응답)" 300 10 s6_http_ok \
    || { e2e::fail "앱 B 접속 실패 — internal 앱은 VPC 내부에서 실행하거나 E2E_INTERNAL_TUNNEL=1 사용."; return 1; }

  e2e::ok "시나리오 6 검증 통과 (선제 증설 → 증설 ALB 배정 → 접속)"
}

scenario_6() {
  e2e::step "시나리오 6: ALB 증설(레지스트리 조작, dev 전용)"
  S6_CLEANED="false"; S6_N0_DELTA=0; S6_APP_A=""; S6_APP_B=""; S6_BUILD_ID=""; S6_N0_SK=""; S6_N0_ORIG=""
  # 어떤 경로로 끝나든(assert 의 exit, Ctrl-C 포함) ruleCount 복원·정리가 돌게 한다 —
  #  전역 EXIT trap(on_exit)이 S6_ACTIVE 를 보고 s6_cleanup 을 호출한다(터널 정리와 공존).
  S6_ACTIVE="true"
  local rc=0
  scenario_6_body || rc=1
  s6_cleanup || rc=1
  S6_ACTIVE="false"
  [[ "${rc}" -eq 0 ]] && e2e::ok "시나리오 6 통과" || e2e::fail "시나리오 6 실패"
  return "${rc}"
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
    6) scenario_6 || FAILED=1 ;;
    *) e2e::fail "알 수 없는 시나리오 번호: ${n}"; FAILED=1 ;;
  esac
  # 시나리오가 어떻게 끝났든(return 1 포함) 남은 생성 앱 삭제 접수.
  if [[ ${#E2E_TRACKED_APPS[@]} -gt 0 ]]; then
    cleanup_tracked_apps "${E2E_CLEANUP_SETTLE_TIMEOUT:-600}" || FAILED=1
  fi
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
