#!/bin/sh
# 컨테이너 시작 시 env → /tmp/apphub/config.json (frontend RuntimeConfig, 계약 delta §9.1).
# nginx 공식 이미지의 /docker-entrypoint.sh가 /docker-entrypoint.d/*.sh 를 nginx 기동 전에 실행한다.
# 값은 platform-stack이 ECS 태스크 env로 주입(APPHUB_*). 시크릿 없음(공개 클라이언트 설정값).
set -eu

OUT_DIR="/tmp/apphub"
OUT="${OUT_DIR}/config.json"
mkdir -p "${OUT_DIR}"

# JSON 문자열 이스케이프(역슬래시·큰따옴표). 값은 URL/ID라 제어문자가 없다.
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

API_URL="${APPHUB_API_URL:-}"
POOL_ID="${APPHUB_USER_POOL_ID:-}"
CLIENT_ID="${APPHUB_USER_POOL_CLIENT_ID:-}"
REGION="${APPHUB_REGION:-}"
IDP="${APPHUB_COGNITO_IDP_ENDPOINT:-}"
if [ -z "${IDP}" ] && [ -n "${REGION}" ]; then
  IDP="https://cognito-idp.${REGION}.amazonaws.com/"
fi
MOCK="false"
if [ -z "${API_URL}" ] || [ -z "${POOL_ID}" ] || [ -z "${CLIENT_ID}" ]; then
  MOCK="true"
  echo "[apphub-config] 경고: APPHUB_API_URL/USER_POOL_ID/USER_POOL_CLIENT_ID 중 일부가 비어 mock=true" >&2
fi

cat > "${OUT}" <<JSON
{
  "apiUrl": "$(esc "${API_URL}")",
  "userPoolId": "$(esc "${POOL_ID}")",
  "userPoolClientId": "$(esc "${CLIENT_ID}")",
  "region": "$(esc "${REGION}")",
  "cognitoIdpEndpoint": "$(esc "${IDP}")",
  "appsDomain": "$(esc "${APPHUB_APPS_DOMAIN:-}")",
  "stage": "$(esc "${APPHUB_STAGE:-}")",
  "mock": ${MOCK}
}
JSON
echo "[apphub-config] ${OUT} 생성 완료"
