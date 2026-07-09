#!/usr/bin/env bash
# backend Python 자산 빌드/동기화 (D-M8 — 순수 boto3, pip install 불필요).
#
# 1) API Lambda 자산: app/ 소스를 infra/lambda/api/ 로 동기화(handler.py 진입점 + app 패키지).
#    CDK는 이 경로를 Code.fromAsset 으로 참조하고 runtime=PYTHON_3_13, handler="handler.handler".
#    (자산 루트가 app/ 이므로 app/handler.py 의 handler 가 "handler.handler" 로 노출된다.)
# 1b) P2 — Step Functions task(provision-task/delete-task) + Waker/복원/잠자기(waker/wake-restore/
#    sleep-transition) 자산 5종: app/ + handler.py shim 을 각 infra/lambda/{name}/ 로 동기화.
#    P3 infra 가 이 경로를 Code.fromAsset + runtime=PYTHON_3_13, handler="handler.handler" 로 참조.
# 2) Dockerfile 검증기 CLI: 자립 스크립트(dockerfile.py + dockerfile_validator.py)를
#    backend/dist/validator/ 로 산출 → P3 deploy.sh 가 플랫폼 자산 버킷 고정 키로 업로드,
#    buildspec 이 `python dockerfile_validator.py <path> --allowed-base-images-json -` 로 호출.
#
# 멱등: 대상 디렉토리를 깨끗이 비우고 다시 채운다. 서드파티 의존성을 싣지 않는다(boto3는 런타임 기본).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

APP_SRC="${SCRIPT_DIR}/app"
API_ASSET_DIR="${ROOT_DIR}/infra/lambda/api"
DIST_VALIDATOR_DIR="${SCRIPT_DIR}/dist/validator"
LAMBDA_ROOT="${ROOT_DIR}/infra/lambda"

# P2 — Step Functions task + Waker/복원/잠자기 자산(각각 app 패키지를 import 하는 shim).
# "자산폴더명|shim 이 재노출할 app 모듈 경로" 매핑. 모두 runtime=PYTHON_3_13, handler="handler.handler".
PY_ASSETS=(
  "provision-task|app.orchestration.provision"
  "delete-task|app.orchestration.delete"
  "waker|app.wake.waker"
  "wake-restore|app.wake.restore"
  "sleep-transition|app.wake.sleep"
)

# rsync 제외 목록(테스트/캐시/타입힌트 아티팩트는 배포 자산에서 제외).
RSYNC_EXCLUDES=(
  --exclude='__pycache__/'
  --exclude='*.pyc'
  --exclude='.pytest_cache/'
)

echo "[backend/build] 1) API Lambda 자산 동기화: app/ -> infra/lambda/api/"
rm -rf "${API_ASSET_DIR}"
mkdir -p "${API_ASSET_DIR}"
# app 패키지를 자산 루트의 app/ 하위로 복사하고, 진입점 handler.py 를 자산 루트에 shim 으로 둔다.
rsync -a "${RSYNC_EXCLUDES[@]}" "${APP_SRC}/" "${API_ASSET_DIR}/app/"
# 진입점 shim: 자산 루트의 handler.py 가 app.handler.handler 를 재노출 → CDK handler="handler.handler".
cat > "${API_ASSET_DIR}/handler.py" <<'PY'
"""Lambda 진입점 shim — CDK handler="handler.handler". 실제 로직은 app.handler."""
from app.handler import handler  # noqa: F401
PY

echo "[backend/build] 1b) Step Functions task + Waker 자산 5종 동기화: app/ -> infra/lambda/{name}/"
for entry in "${PY_ASSETS[@]}"; do
  name="${entry%%|*}"
  module="${entry##*|}"
  asset_dir="${LAMBDA_ROOT}/${name}"
  rm -rf "${asset_dir}"
  mkdir -p "${asset_dir}"
  # app 패키지를 자산 루트의 app/ 하위로 복사(API 자산과 동일 방식 — 자립 배포 단위).
  rsync -a "${RSYNC_EXCLUDES[@]}" "${APP_SRC}/" "${asset_dir}/app/"
  # 진입점 shim: 자산 루트의 handler.py 가 {module}.handle 를 handler 로 재노출 → CDK handler="handler.handler".
  cat > "${asset_dir}/handler.py" <<PY
"""Lambda 진입점 shim — CDK handler="handler.handler". 실제 로직은 ${module}.handle."""
from ${module} import handle as handler  # noqa: F401
PY
  echo "  - ${name} 자산: ${asset_dir} (handler.py -> ${module}.handle + app/)"
done

echo "[backend/build] 2) Dockerfile 검증기 자립 스크립트: -> backend/dist/validator/"
rm -rf "${DIST_VALIDATOR_DIR}"
mkdir -p "${DIST_VALIDATOR_DIR}"
# dockerfile.py(로직) + dockerfile_validator.py(CLI 진입, 절대 import 모드) 두 파일이면 자립.
cp "${APP_SRC}/validator/dockerfile.py" "${DIST_VALIDATOR_DIR}/dockerfile.py"
cp "${APP_SRC}/validator/cli.py" "${DIST_VALIDATOR_DIR}/dockerfile_validator.py"

echo "[backend/build] 완료."
echo "  - API 자산:   ${API_ASSET_DIR} (handler.py + app/)"
echo "  - task/wake 자산: ${LAMBDA_ROOT}/{provision-task,delete-task,waker,wake-restore,sleep-transition} (handler.py + app/)"
echo "  - 검증기 CLI: ${DIST_VALIDATOR_DIR}/dockerfile_validator.py (python <...> --allowed-base-images-json -)"
