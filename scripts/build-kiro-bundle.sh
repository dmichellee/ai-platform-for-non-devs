#!/usr/bin/env bash
#
# Kiro 설정 번들(zip) 생성 — 사용자가 자기 앱 레포에 넣을 .kiro/ 묶음.
# 프론트 "Kiro 설정 다운로드" 버튼이 서빙할 산출물을 만든다.
#
# 사용:
#   ./scripts/build-kiro-bundle.sh [--out <경로>] [--upload --stage <dev|prod> [--region <region>]]
#
# 동작(멱등):
#   1. kiro-config/ 의 번들 3구성(.kiro/steering + hooks/pre-commit + install-hooks.sh + README.md)을
#      zip으로 묶는다(결정적: 파일 목록 고정, 정렬). 훅/설치 스크립트의 실행 비트를 보존한다.
#   2. --upload 지정 시, 플랫폼 자산 버킷의 고정 키로 업로드한다:
#         s3://{AssetsBucketName}/kiro-config/kiro-config.zip
#      (deploy.sh 3b의 검증기/CDK소스 업로드와 동일한 자산 버킷·고정 키 패턴)
#
# 서빙 계약(_workspace/contracts/api-contract.md):
#   - 프론트 "Kiro 설정 다운로드"는 이 고정 S3 키의 오브젝트를 제공한다.
#   - 배포용 고정 URI: s3://{assets}/kiro-config/kiro-config.zip
#     (SSM: /apphub/{stage}/platform/kiro-bundle-s3-uri — 발행은 인프라 후속 항목)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
KIRO_DIR="${ROOT_DIR}/kiro-config"

OUT=""
DO_UPLOAD="false"
STAGE=""
REGION="ap-northeast-2"

usage() {
  cat <<'USAGE'
사용법: build-kiro-bundle.sh [옵션]
  --out <경로>              zip 출력 경로 (기본: kiro-config/dist/kiro-config.zip)
  --upload                  플랫폼 자산 버킷에 고정 키로 업로드
  --stage <dev|prod>        업로드 시 필수 (자산 버킷 Output 조회용)
  --region <region>         기본: ap-northeast-2
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)     OUT="${2:-}"; shift 2 ;;
    --upload)  DO_UPLOAD="true"; shift ;;
    --stage)   STAGE="${2:-}"; shift 2 ;;
    --region)  REGION="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "알 수 없는 인자: $1" >&2; usage; exit 2 ;;
  esac
done

log() { echo "[kiro-bundle] $*"; }

# ── 전제조건 점검 ────────────────────────────────────────────────────────────
if [[ ! -d "${KIRO_DIR}/.kiro" ]]; then
  echo "오류: ${KIRO_DIR}/.kiro 디렉토리가 없습니다." >&2
  exit 1
fi
command -v zip >/dev/null 2>&1 || { echo "오류: 'zip' 명령이 필요합니다." >&2; exit 1; }

# 필수 파일 존재 확인(번들 무결성). 구성: steering + pre-commit 훅 + 설치 스크립트 + README.
STEERING="${KIRO_DIR}/.kiro/steering/deployment-standard.md"
HOOK="${KIRO_DIR}/hooks/pre-commit"
INSTALLER="${KIRO_DIR}/install-hooks.sh"
README="${KIRO_DIR}/README.md"
for f in "${STEERING}" "${HOOK}" "${INSTALLER}" "${README}"; do
  if [[ ! -f "$f" ]]; then
    echo "오류: 번들 필수 파일이 없습니다: $f" >&2
    exit 1
  fi
done

# 구 Kiro hook 파일(.kiro.hook)이 남아 있으면 실수로 함께 배포되지 않게 막는다(재구성 이후 금지).
if [[ -e "${KIRO_DIR}/.kiro/hooks" ]]; then
  echo "오류: 구 Kiro hook 경로(.kiro/hooks)가 남아 있습니다. 이 번들은 git pre-commit 방식으로 재구성됐습니다." >&2
  echo "      ${KIRO_DIR}/.kiro/hooks 를 제거하세요." >&2
  exit 1
fi

# 셸 스크립트 문법 검증(깨진 스크립트를 사용자에게 배포하지 않는다).
sh -n "${HOOK}"      || { echo "오류: hooks/pre-commit 문법 오류: ${HOOK}" >&2; exit 1; }
sh -n "${INSTALLER}" || { echo "오류: install-hooks.sh 문법 오류: ${INSTALLER}" >&2; exit 1; }
log "셸 스크립트 문법(sh -n) OK"
# 실행 비트 보장(zip에 권한을 담기 위해 원본에 먼저 부여).
chmod +x "${HOOK}" "${INSTALLER}"

# ── zip 생성 (결정적) ────────────────────────────────────────────────────────
if [[ -z "${OUT}" ]]; then
  OUT="${KIRO_DIR}/dist/kiro-config.zip"
fi
mkdir -p "$(dirname "${OUT}")"
rm -f "${OUT}"

log "zip 생성 → ${OUT}"
# kiro-config 디렉토리 안에서 .kiro/ · hooks/ · install-hooks.sh · README.md 를 담는다.
# -X: 확장 속성 제외(결정적), -r: 재귀. 유닉스 실행 비트는 zip이 보존한다(위에서 chmod +x).
( cd "${KIRO_DIR}" && zip -X -r "${OUT}" .kiro hooks install-hooks.sh README.md >/dev/null )
log "zip 생성 완료: $(cd "$(dirname "${OUT}")" && pwd)/$(basename "${OUT}")"
log "번들 내용:"
unzip -l "${OUT}" | sed 's/^/    /'

# ── 업로드(선택) ─────────────────────────────────────────────────────────────
if [[ "${DO_UPLOAD}" == "true" ]]; then
  if [[ "${STAGE}" != "dev" && "${STAGE}" != "prod" ]]; then
    echo "오류: --upload 에는 --stage <dev|prod> 가 필요합니다." >&2
    exit 2
  fi
  command -v aws >/dev/null 2>&1 || { echo "오류: 'aws' CLI가 필요합니다." >&2; exit 1; }
  PLATFORM_STACK="apphub-${STAGE}-platform"
  ASSETS_BUCKET="$(aws cloudformation describe-stacks \
    --stack-name "${PLATFORM_STACK}" --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='AssetsBucketName'].OutputValue" \
    --output text 2>/dev/null || true)"
  if [[ -z "${ASSETS_BUCKET}" || "${ASSETS_BUCKET}" == "None" ]]; then
    echo "오류: ${PLATFORM_STACK} 의 AssetsBucketName Output을 찾을 수 없습니다." >&2
    echo "      플랫폼이 먼저 배포돼 있어야 합니다(deploy.sh)." >&2
    exit 1
  fi
  KEY="kiro-config/kiro-config.zip"
  log "업로드 → s3://${ASSETS_BUCKET}/${KEY}"
  aws s3 cp "${OUT}" "s3://${ASSETS_BUCKET}/${KEY}" --region "${REGION}"
  log "업로드 완료. 프론트 다운로드 계약 URI: s3://${ASSETS_BUCKET}/${KEY}"
fi

log "완료."
