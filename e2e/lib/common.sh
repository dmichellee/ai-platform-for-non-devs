#!/usr/bin/env bash
#
# e2e 공용 헬퍼 — run-e2e.sh 가 source 한다. 단독 실행용 아님.
# 라이브 AWS(dev 스테이지)를 전제로 하며, stack-outputs / api-contract 계약을 소비한다.
#
# 제공 함수:
#   e2e::load_outputs        — CloudFormation Outputs/SSM에서 ApiUrl/UserPool/ConsoleUrl/TableName 등 로드
#   e2e::cognito_login       — 테스트 사용자로 로그인(InitiateAuth USER_PASSWORD_AUTH) → ID 토큰(JWT_TOKEN)
#   e2e::alb_param           — ALB별 SSM 키(/network/alb/{slug}/{n}/{key}) 조회
#   e2e::ddb_*               — CONFIG 파티션 조회/조건부 갱신(시나리오 6 레지스트리 조작용)
#   e2e::api                 — 인증 붙여 API 호출(JSON), HTTP 코드 검증
#   e2e::api_raw             — 상태코드만 반환하는 저수준 호출
#   e2e::wait_for            — 조건 함수가 참이 될 때까지 폴링(타임아웃)
#   e2e::http_status         — 임의 URL의 HTTP 상태코드(터널 미경유 — 콘솔·외부 URL용)
#   e2e::app_curl            — 앱 URL(https://{sub}.{appsDomain}) curl. 터널 켜짐이면 --connect-to 로 경유
#   e2e::app_http_status     — 앱 URL HTTP 상태코드(app_curl 사용)
#   e2e::tunnel_*            — lib/tunnel.sh(E2E_INTERNAL_TUNNEL=1 일 때 SSM 포트 포워딩)
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
#  D19: ApiUrl 은 모드별 실제 호출 URL(private 이면 Private API — 사내망/VPN 필요),
#       ConsoleUrl = https://console.{appsDomain}, FrontendMode = public|private.
#  D21: CognitoIdpEndpoint 는 SPA 가 쓰는 로그인 엔드포인트(참고용 — CLI 는 기본 공개 엔드포인트).
e2e::load_outputs() {
  local platform="apphub-${STAGE}-platform"
  local network="apphub-${STAGE}-network"

  API_URL="$(e2e::_stack_output "${platform}" ApiUrl)"
  USER_POOL_ID="$(e2e::_stack_output "${platform}" UserPoolId)"
  USER_POOL_CLIENT_ID="$(e2e::_stack_output "${platform}" UserPoolClientId)"
  ASSETS_BUCKET="$(e2e::_stack_output "${platform}" AssetsBucketName)"
  TABLE_NAME="$(e2e::_stack_output "${platform}" TableName)"
  FRONTEND_MODE="$(e2e::_stack_output "${platform}" FrontendMode)"
  CONSOLE_URL="$(e2e::_stack_output "${platform}" ConsoleUrl)"
  COGNITO_IDP_ENDPOINT="$(e2e::_stack_output "${platform}" CognitoIdpEndpoint)"
  [[ "${FRONTEND_MODE}" == "None" || -z "${FRONTEND_MODE}" ]] && FRONTEND_MODE="public"
  [[ "${CONSOLE_URL}" == "None" ]] && CONSOLE_URL=""
  [[ "${COGNITO_IDP_ENDPOINT}" == "None" ]] && COGNITO_IDP_ENDPOINT=""

  # 앱 도메인은 network SSM 계약(apps-domain)에서.
  APPS_DOMAIN="$(e2e::_ssm "/apphub/${STAGE}/network/apps-domain")"

  if [[ -z "${API_URL}" || "${API_URL}" == "None" ]]; then
    e2e::fail "ApiUrl Output을 찾을 수 없습니다. dev 스테이지가 배포돼 있나요?(deploy.sh --stage ${STAGE})"
    exit 1
  fi
  e2e::log "FrontendMode=${FRONTEND_MODE}"
  e2e::log "ApiUrl=${API_URL}"
  e2e::log "ConsoleUrl=${CONSOLE_URL:-<none>}"
  e2e::log "AppsDomain=${APPS_DOMAIN}"
  e2e::log "UserPool=${USER_POOL_ID}"
  if [[ "${FRONTEND_MODE}" == "private" ]]; then
    e2e::log "[WARN] FrontendMode=private — ApiUrl 은 Private API(VPC 엔드포인트 경유)이고 콘솔은 internal ALB 입니다."
    e2e::log "[WARN]   이 스크립트는 플랫폼 VPC에 닿는 사내망/VPN/베스천에서 실행해야 API·웹 호출이 성공합니다."
  fi
}

# ── 인증(api-contract.md, D21): Cognito로 ID 토큰 획득 ───────────────────────
# 테스트 사용자 자격은 환경변수로 주입한다(스크립트에 하드코딩 금지):
#   E2E_USERNAME / E2E_PASSWORD  (user 그룹)
#   E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD (admin 그룹, 웹 UI/관리자 시나리오용)
# SPA 와 같은 경로: InitiateAuth(USER_PASSWORD_AUTH). 공개 API라 IAM 관리자 권한이 필요 없다.
#  (SPA 앱 클라이언트 authFlows = userPassword + refresh 만 — ADMIN_USER_PASSWORD_AUTH 는 비활성.)
# 선택: E2E_COGNITO_IDP_ENDPOINT 를 주면 그 엔드포인트로 호출(--endpoint-url, 예: private 모드 VPC 엔드포인트).
e2e::cognito_login() {
  local username="$1" password="$2"
  if [[ -z "${username}" || -z "${password}" ]]; then
    e2e::fail "테스트 자격 증명이 비어 있습니다. E2E_USERNAME/E2E_PASSWORD 환경변수를 설정하세요."
    exit 1
  fi
  # 비밀번호에 콤마/등호가 있어도 안전하도록 shorthand 대신 JSON 으로 전달.
  local params
  params="$(E2E_U="${username}" E2E_P="${password}" node -e \
    'process.stdout.write(JSON.stringify({USERNAME: process.env.E2E_U, PASSWORD: process.env.E2E_P}))')"
  local endpoint_args=()
  [[ -n "${E2E_COGNITO_IDP_ENDPOINT:-}" ]] && endpoint_args=(--endpoint-url "${E2E_COGNITO_IDP_ENDPOINT}")
  local auth errf; errf="$(mktemp)"
  auth="$(aws cognito-idp initiate-auth \
    --client-id "${USER_POOL_CLIENT_ID}" \
    --auth-flow USER_PASSWORD_AUTH \
    --auth-parameters "${params}" \
    ${endpoint_args[@]+"${endpoint_args[@]}"} \
    --region "${REGION}" --output json 2>"${errf}" || true)"
  if [[ -z "${auth}" ]]; then
    # 오류 메시지(NotAuthorizedException 등)만 표시 — 자격 값은 포함되지 않는다.
    e2e::fail "로그인 실패(${username}): $(head -c 300 "${errf}" | tr '\n' ' ')"
    e2e::fail "  자격 증명 / 앱 클라이언트 USER_PASSWORD_AUTH 허용 여부를 확인하세요."
    rm -f "${errf}"
    exit 1
  fi
  rm -f "${errf}"
  # NEW_PASSWORD_REQUIRED 등 챌린지가 오면 안내 후 종료(테스트 사용자는 사전에 확정 비번이어야 함).
  local challenge
  challenge="$(echo "${auth}" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).ChallengeName || ""')"
  if [[ -n "${challenge}" ]]; then
    e2e::fail "로그인 챌린지(${challenge}) 발생. 테스트 사용자는 확정된 비밀번호여야 합니다(임시 비번 상태 아님)."
    e2e::fail "  웹 로그인 화면에서 한 번 로그인해 새 비밀번호를 정하면 확정됩니다."
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

# ── 앱 URL 호출(internal 앱 터널 경유) ──────────────────────────────────────
# 사용: e2e::app_curl <url> [curl 인자...]
#  - 호스트가 *.{appsDomain} 이고 터널(E2E_INTERNAL_TUNNEL=1)이 열려 있으면
#    --connect-to "{host}:443:127.0.0.1:{port}" 를 붙인다. TCP 연결만 터널로 가고
#    Host 헤더·SNI·인증서 검증은 실제 호스트명 그대로(와일드카드 인증서로 검증).
#  - 인증서 검증을 끄려면 E2E_CURL_INSECURE=1(-k).
e2e::app_curl() {
  local url="$1"; shift
  local rest="${url#*://}"
  local host="${rest%%/*}"; host="${host%%:*}"
  local extra=()
  local port; port="$(e2e::tunnel_port_for "${host}")"
  if [[ -n "${port}" ]]; then
    e2e::tunnel_ensure_port "${port}" || true
    extra+=(--connect-to "${host}:443:127.0.0.1:${port}")
  fi
  [[ "${E2E_CURL_INSECURE:-0}" == "1" ]] && extra+=(-k)
  curl ${extra[@]+"${extra[@]}"} "$@" "${url}"
}

# 앱 URL 의 HTTP 상태코드(연결 실패 시 000). 사용: e2e::app_http_status <url>
e2e::app_http_status() {
  local code
  code="$(e2e::app_curl "$1" -s -o /dev/null -w '%{http_code}' --connect-timeout 10 --max-time 30 2>/dev/null || true)"
  echo "${code:-000}"
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

# ── ALB별 SSM 키 (D20, 계약 delta §1.1) ─────────────────────────────────────
# 사용: e2e::alb_param <schemeSlug> <n> <key>   (key: alb-arn, https-listener-arn, waker-tg-arn …)
e2e::alb_param() {
  local slug="$1" n="$2" key="$3"
  local v; v="$(e2e::_ssm "/apphub/${STAGE}/network/alb/${slug}/${n}/${key}")"
  [[ "${v}" == "None" ]] && v=""
  echo "${v}"
}

# ── DynamoDB CONFIG 파티션 헬퍼(시나리오 6 — 레지스트리 조작) ────────────────
# 전역 TABLE_NAME(load_outputs) 필요. 출력은 unmarshall 된 평문 JSON(S/N/BOOL 만 변환).
e2e::_ddb_unmarshall() {
  node -e '
    const raw = require("fs").readFileSync(0, "utf8").trim();
    if (!raw) { process.exit(0); }
    const conv = (av) => {
      if (av == null) return null;
      if ("S" in av) return av.S;
      if ("N" in av) return Number(av.N);
      if ("BOOL" in av) return av.BOOL;
      if ("NULL" in av) return null;
      if ("M" in av) return Object.fromEntries(Object.entries(av.M).map(([k, v]) => [k, conv(v)]));
      if ("L" in av) return av.L.map(conv);
      return av;
    };
    const item = (it) => Object.fromEntries(Object.entries(it).map(([k, v]) => [k, conv(v)]));
    const d = JSON.parse(raw);
    if (Array.isArray(d.Items)) process.stdout.write(JSON.stringify(d.Items.map(item)));
    else if (d.Item) process.stdout.write(JSON.stringify(item(d.Item)));
  '
}

# PK=CONFIG 키 JSON(SK 는 ARN 등 특수문자 포함 가능 → node 로 안전 직렬화).
e2e::_config_key() {
  E2E_SK="$1" node -e 'process.stdout.write(JSON.stringify({PK:{S:"CONFIG"},SK:{S:process.env.E2E_SK}}))'
}

# 단건 조회(강한 일관성). 없으면 빈 문자열. 사용: ITEM="$(e2e::ddb_config_get "ALB#${arn}")"
e2e::ddb_config_get() {
  local sk="$1"
  aws dynamodb get-item --table-name "${TABLE_NAME}" --region "${REGION}" \
    --key "$(e2e::_config_key "${sk}")" --consistent-read --output json 2>/dev/null \
    | e2e::_ddb_unmarshall
}

# SK 접두어 조회 → 평문 JSON 배열. 사용: e2e::ddb_config_query "ALB#"
e2e::ddb_config_query() {
  local prefix="$1"
  local values
  values="$(E2E_P="${prefix}" node -e \
    'process.stdout.write(JSON.stringify({":pk":{S:"CONFIG"},":p":{S:process.env.E2E_P}}))')"
  local out
  out="$(aws dynamodb query --table-name "${TABLE_NAME}" --region "${REGION}" \
    --key-condition-expression "PK = :pk AND begins_with(SK, :p)" \
    --expression-attribute-values "${values}" --consistent-read --output json 2>/dev/null || true)"
  if [[ -z "${out}" ]]; then echo "[]"; return 0; fi
  echo "${out}" | e2e::_ddb_unmarshall
}

# 조건부 update-item. 성공 0 / 조건 실패·오류 1(stderr 는 로그로).
# 사용: e2e::ddb_config_update <sk> <update-expr> <condition-expr> <values-json> [names-json]
e2e::ddb_config_update() {
  local sk="$1" expr="$2" cond="$3" values="$4" names="${5:-}"
  local args=(--table-name "${TABLE_NAME}" --region "${REGION}"
    --key "$(e2e::_config_key "${sk}")"
    --update-expression "${expr}" --condition-expression "${cond}"
    --expression-attribute-values "${values}")
  [[ -n "${names}" ]] && args+=(--expression-attribute-names "${names}")
  local errf; errf="$(mktemp)"
  if aws dynamodb update-item "${args[@]}" >/dev/null 2>"${errf}"; then
    rm -f "${errf}"; return 0
  fi
  e2e::log "update-item 실패(${sk}): $(head -c 300 "${errf}" | tr '\n' ' ')"
  rm -f "${errf}"; return 1
}

# 조건부 delete-item. 사용: e2e::ddb_config_delete <sk> <condition-expr> <values-json> [names-json]
e2e::ddb_config_delete() {
  local sk="$1" cond="$2" values="$3" names="${4:-}"
  local args=(--table-name "${TABLE_NAME}" --region "${REGION}"
    --key "$(e2e::_config_key "${sk}")"
    --condition-expression "${cond}" --expression-attribute-values "${values}")
  [[ -n "${names}" ]] && args+=(--expression-attribute-names "${names}")
  local errf; errf="$(mktemp)"
  if aws dynamodb delete-item "${args[@]}" >/dev/null 2>"${errf}"; then
    rm -f "${errf}"; return 0
  fi
  e2e::log "delete-item 실패(${sk}): $(head -c 300 "${errf}" | tr '\n' ' ')"
  rm -f "${errf}"; return 1
}

# 스택 상태(없으면 MISSING).
e2e::stack_status() {
  local stack="$1"
  local st
  st="$(aws cloudformation describe-stacks --stack-name "${stack}" --region "${REGION}" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || true)"
  [[ -z "${st}" || "${st}" == "None" ]] && st="MISSING"
  echo "${st}"
}

# internal 앱 접속용 SSM 포트 포워딩 터널(E2E_INTERNAL_TUNNEL=1 일 때만 동작).
# shellcheck source=lib/tunnel.sh
source "$(dirname "${BASH_SOURCE[0]}")/tunnel.sh"
