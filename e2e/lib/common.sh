#!/usr/bin/env bash
#
# e2e 공용 헬퍼 — run-e2e.sh 가 source 한다. 단독 실행용 아님.
# 라이브 AWS(dev 스테이지)를 전제로 하며, stack-outputs / api-contract 계약을 소비한다.
#
# 제공 함수:
#   e2e::load_outputs        — CloudFormation Outputs/SSM에서 ApiUrl/UserPool/AssetsBucket 등 로드
#   e2e::cognito_login       — 테스트 사용자로 로그인 → ID 토큰 획득(전역 JWT_TOKEN 설정)
#   e2e::api                 — 인증 붙여 API 호출(JSON), HTTP 코드 검증
#   e2e::api_raw             — 상태코드만 반환하는 저수준 호출
#   e2e::wait_for            — 조건 함수가 참이 될 때까지 폴링(타임아웃)
#   e2e::http_status         — 임의 URL의 HTTP 상태코드
#   e2e::assert              — 조건 실패 시 에러 로그 + 종료
#   e2e::log / e2e::step / e2e::ok / e2e::fail
#
# 모든 함수는 실패 시 non-zero 반환 또는 exit. run-e2e.sh 는 set -euo pipefail 를 켠다.

# ── 로깅 ─────────────────────────────────────────────────────────────────────
e2e::log()  { echo "[e2e] $*"; }
e2e::step() { echo; echo "########## $* ##########"; }
e2e::ok()   { echo "[e2e][PASS] $*"; }
e2e::fail() { echo "[e2e][FAIL] $*" >&2; }

# 조건 실패 시 종료. 사용: e2e::assert "설명" <성공여부(0/1)>
e2e::assert() {
  local desc="$1" cond="$2"
  if [[ "${cond}" == "0" ]]; then
    e2e::ok "${desc}"
  else
    e2e::fail "${desc}"
    exit 1
  fi
}

# 조건 함수(0=참)를 평가해 실패 시 종료. set -e 안전(if 문맥).
# 사용: e2e::assert_fn "설명" <조건함수명> [인자...]
e2e::assert_fn() {
  local desc="$1" fn="$2"; shift 2
  if "${fn}" "$@"; then
    e2e::ok "${desc}"
  else
    e2e::fail "${desc}"
    exit 1
  fi
}

# ── 계약(stack-outputs.md) 소비: 스택 Output 조회 ────────────────────────────
# 전역: STAGE, REGION 이 이미 설정돼 있어야 함.
e2e::_stack_output() {
  local stack="$1" key="$2"
  aws cloudformation describe-stacks --stack-name "${stack}" --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue" --output text 2>/dev/null
}

# SSM 파라미터 조회(런타임 계약 경로 /apphub/{stage}/...).
e2e::_ssm() {
  local path="$1"
  aws ssm get-parameter --name "${path}" --region "${REGION}" \
    --query 'Parameter.Value' --output text 2>/dev/null
}

# stack-outputs.md 계약 키를 전역 변수로 로드한다.
e2e::load_outputs() {
  local platform="apphub-${STAGE}-platform"
  local network="apphub-${STAGE}-network"

  API_URL="$(e2e::_stack_output "${platform}" ApiUrl)"
  USER_POOL_ID="$(e2e::_stack_output "${platform}" UserPoolId)"
  USER_POOL_CLIENT_ID="$(e2e::_stack_output "${platform}" UserPoolClientId)"
  ASSETS_BUCKET="$(e2e::_stack_output "${platform}" AssetsBucketName)"

  # 앱 도메인은 network SSM 계약(apps-domain)에서.
  APPS_DOMAIN="$(e2e::_ssm "/apphub/${STAGE}/network/apps-domain")"

  if [[ -z "${API_URL}" || "${API_URL}" == "None" ]]; then
    e2e::fail "ApiUrl Output을 찾을 수 없습니다. dev 스테이지가 배포돼 있나요?(deploy.sh --stage ${STAGE})"
    exit 1
  fi
  e2e::log "ApiUrl=${API_URL}"
  e2e::log "AppsDomain=${APPS_DOMAIN}"
  e2e::log "UserPool=${USER_POOL_ID}"
}

# ── 인증(api-contract.md): Cognito로 ID 토큰 획득 ────────────────────────────
# 테스트 사용자 자격은 환경변수로 주입한다(스크립트에 하드코딩 금지):
#   E2E_USERNAME / E2E_PASSWORD  (user 그룹)
#   E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD (admin 그룹, 웹 UI/관리자 시나리오용)
# ADMIN_INITIATE_AUTH(USER_PASSWORD_AUTH)로 로그인. 앱 클라이언트에 이 흐름이 켜져 있어야 함.
e2e::cognito_login() {
  local username="$1" password="$2"
  if [[ -z "${username}" || -z "${password}" ]]; then
    e2e::fail "테스트 자격 증명이 비어 있습니다. E2E_USERNAME/E2E_PASSWORD 환경변수를 설정하세요."
    exit 1
  fi
  local auth
  auth="$(aws cognito-idp admin-initiate-auth \
    --user-pool-id "${USER_POOL_ID}" \
    --client-id "${USER_POOL_CLIENT_ID}" \
    --auth-flow ADMIN_USER_PASSWORD_AUTH \
    --auth-parameters "USERNAME=${username},PASSWORD=${password}" \
    --region "${REGION}" --output json 2>/dev/null || true)"
  if [[ -z "${auth}" ]]; then
    e2e::fail "로그인 실패(${username}). USER_PASSWORD_AUTH 흐름/자격 증명을 확인하세요."
    exit 1
  fi
  # NEW_PASSWORD_REQUIRED 등 챌린지가 오면 안내 후 종료(테스트 사용자는 사전에 확정 비번이어야 함).
  local challenge
  challenge="$(echo "${auth}" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).ChallengeName || ""')"
  if [[ -n "${challenge}" ]]; then
    e2e::fail "로그인 챌린지(${challenge}) 발생. 테스트 사용자는 확정된 비밀번호여야 합니다(임시 비번 상태 아님)."
    exit 1
  fi
  JWT_TOKEN="$(echo "${auth}" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).AuthenticationResult.IdToken')"
  if [[ -z "${JWT_TOKEN}" || "${JWT_TOKEN}" == "undefined" ]]; then
    e2e::fail "ID 토큰을 획득하지 못했습니다."
    exit 1
  fi
  e2e::log "로그인 OK (${username})"
}

# ── API 호출(api-contract.md): {data}/{error} 봉투 ───────────────────────────
# 사용: RESP="$(e2e::api <METHOD> <PATH> [JSON본문] [기대HTTP])"
#   - PATH는 /apps 처럼 슬래시로 시작. API_URL 뒤에 붙는다.
#   - 성공 시 응답 본문(JSON)을 stdout 으로. 기대 HTTP와 다르면 실패로 종료.
#   - 기대HTTP 미지정 시 2xx 이면 통과.
e2e::api() {
  local method="$1" path="$2" body="${3:-}" expect="${4:-}"
  local url="${API_URL%/}${path}"
  local tmp; tmp="$(mktemp)"
  local code
  if [[ -n "${body}" ]]; then
    code="$(curl -s -o "${tmp}" -w '%{http_code}' -X "${method}" "${url}" \
      -H "Authorization: Bearer ${JWT_TOKEN}" \
      -H 'Content-Type: application/json; charset=utf-8' \
      --data "${body}")"
  else
    code="$(curl -s -o "${tmp}" -w '%{http_code}' -X "${method}" "${url}" \
      -H "Authorization: Bearer ${JWT_TOKEN}")"
  fi
  local out; out="$(cat "${tmp}")"; rm -f "${tmp}"
  if [[ -n "${expect}" ]]; then
    if [[ "${code}" != "${expect}" ]]; then
      e2e::fail "${method} ${path} → HTTP ${code} (기대 ${expect}). 본문: ${out}"
      exit 1
    fi
  else
    if [[ "${code}" -lt 200 || "${code}" -ge 300 ]]; then
      e2e::fail "${method} ${path} → HTTP ${code} (2xx 기대). 본문: ${out}"
      exit 1
    fi
  fi
  echo "${out}"
}

# 저수준: 상태코드만 반환(에러 케이스 검증용, 종료 안 함).
e2e::api_status() {
  local method="$1" path="$2" body="${3:-}"
  local url="${API_URL%/}${path}"
  if [[ -n "${body}" ]]; then
    curl -s -o /dev/null -w '%{http_code}' -X "${method}" "${url}" \
      -H "Authorization: Bearer ${JWT_TOKEN}" \
      -H 'Content-Type: application/json; charset=utf-8' --data "${body}"
  else
    curl -s -o /dev/null -w '%{http_code}' -X "${method}" "${url}" \
      -H "Authorization: Bearer ${JWT_TOKEN}"
  fi
}

# 임의 URL(앱 발급 URL 등)의 HTTP 상태코드.
e2e::http_status() {
  local url="$1"
  curl -s -k -o /dev/null -w '%{http_code}' "${url}" || echo "000"
}

# JSON 응답에서 필드 추출(node). 사용: e2e::json "$RESP" 'data.appId'
e2e::json() {
  local json="$1" path="$2"
  echo "${json}" | node -e '
    const data = JSON.parse(require("fs").readFileSync(0,"utf8"));
    const path = process.argv[1].split(".");
    let cur = data;
    for (const k of path) { cur = cur == null ? undefined : cur[k]; }
    process.stdout.write(cur == null ? "" : (typeof cur === "object" ? JSON.stringify(cur) : String(cur)));
  ' "${path}"
}

# ── 폴링: 조건 함수가 0을 반환할 때까지 대기 ─────────────────────────────────
# 사용: e2e::wait_for "설명" <타임아웃초> <간격초> <조건함수명> [인자...]
e2e::wait_for() {
  local desc="$1" timeout="$2" interval="$3" fn="$4"; shift 4
  local elapsed=0
  e2e::log "대기: ${desc} (타임아웃 ${timeout}s)"
  while true; do
    if "${fn}" "$@"; then
      e2e::ok "${desc} — 조건 충족(${elapsed}s 경과)"
      return 0
    fi
    if [[ "${elapsed}" -ge "${timeout}" ]]; then
      e2e::fail "${desc} — 타임아웃(${timeout}s)"
      return 1
    fi
    sleep "${interval}"
    elapsed=$(( elapsed + interval ))
  done
}

# ── 리소스 누수 검사(시나리오 1의 삭제 후) ───────────────────────────────────
# 앱 삭제 후 app-* 스택 2개 + ECR + Route53 레코드 + 리스너 규칙이 남아있지 않은지.
# 사용: e2e::assert_no_leak <appId> <subdomain>
e2e::assert_no_leak() {
  local appId="$1" subdomain="$2"
  local leaks=0
  local prefix="apphub-${STAGE}"

  # 1) app-runtime / app-pipeline 스택 부재
  for kind in runtime pipeline; do
    local stack="${prefix}-app-${appId}-${kind}"
    local st
    st="$(aws cloudformation describe-stacks --stack-name "${stack}" --region "${REGION}" \
      --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "MISSING")"
    if [[ "${st}" != "MISSING" && "${st}" != "None" && -n "${st}" ]]; then
      e2e::fail "누수: 스택 ${stack} 이 아직 존재(${st})"
      leaks=$(( leaks + 1 ))
    else
      e2e::log "OK: 스택 ${stack} 없음"
    fi
  done

  # 2) ECR 리포 부재 (apphub-{stage}-app-{appId})
  local repo="${prefix}-app-${appId}"
  if aws ecr describe-repositories --repository-names "${repo}" --region "${REGION}" >/dev/null 2>&1; then
    e2e::fail "누수: ECR 리포 ${repo} 잔존"
    leaks=$(( leaks + 1 ))
  else
    e2e::log "OK: ECR 리포 ${repo} 없음"
  fi

  # 3) Route53 레코드 부재 ({subdomain}.{appsDomain})
  if [[ -n "${APPS_DOMAIN}" ]]; then
    local fqdn="${subdomain}.${APPS_DOMAIN}."
    # public zone 조회 — SSM public-hosted-zone-id
    local zoneId
    zoneId="$(e2e::_ssm "/apphub/${STAGE}/network/public-hosted-zone-id")"
    if [[ -n "${zoneId}" && "${zoneId}" != "None" ]]; then
      local found
      found="$(aws route53 list-resource-record-sets --hosted-zone-id "${zoneId}" \
        --query "ResourceRecordSets[?Name=='${fqdn}'].Name" --output text 2>/dev/null || true)"
      if [[ -n "${found}" ]]; then
        e2e::fail "누수: Route53 레코드 ${fqdn} 잔존"
        leaks=$(( leaks + 1 ))
      else
        e2e::log "OK: Route53 레코드 ${fqdn} 없음"
      fi
    fi
  fi

  # 4) 리스너 규칙 부재 — 앱 host-header 조건 규칙이 남아있지 않은지.
  #    internet/internal HTTPS 리스너를 순회해 subdomain host 조건 규칙을 찾는다.
  if [[ -n "${APPS_DOMAIN}" ]]; then
    local host="${subdomain}.${APPS_DOMAIN}"
    for which in internet internal; do
      local listenerArn
      listenerArn="$(e2e::_ssm "/apphub/${STAGE}/network/${which}-https-listener-arn")"
      [[ -z "${listenerArn}" || "${listenerArn}" == "None" ]] && continue
      local match
      match="$(aws elbv2 describe-rules --listener-arn "${listenerArn}" --region "${REGION}" \
        --query "Rules[?Conditions[?contains(HostHeaderConfig.Values, '${host}')]].RuleArn" \
        --output text 2>/dev/null || true)"
      if [[ -n "${match}" ]]; then
        e2e::fail "누수: ${which} 리스너에 ${host} 규칙 잔존(${match})"
        leaks=$(( leaks + 1 ))
      else
        e2e::log "OK: ${which} 리스너에 ${host} 규칙 없음"
      fi
    done
  fi

  if [[ "${leaks}" -eq 0 ]]; then
    e2e::ok "리소스 누수 없음(app-* 스택/ECR/Route53/리스너 규칙 전부 정리됨)"
    return 0
  fi
  e2e::fail "리소스 누수 ${leaks}건 발견 — 앱 삭제=app-* 스택 2개 삭제로 완결 원칙 위반"
  return 1
}
