#!/usr/bin/env bash
#
# Kiro 설정 번들(zip) 생성 — 사용자가 자기 앱 레포에 넣을 .kiro/ 묶음.
# 프론트 "Kiro 설정 다운로드" 버튼이 서빙할 산출물을 만든다.
#
# OS별로 zip 2개를 만든다(공통 파일 .kiro/·hooks/ + OS별 설치기 + OS별 README):
#   - kiro-config-mac.zip      : install-hooks.sh   + README(=README-mac.md)
#   - kiro-config-windows.zip  : install-hooks.ps1  + README(=README-windows.md)
# 훅(hooks/pre-commit)과 .kiro/ 스티어링은 OS 공통이다(git이 sh로 훅을 실행).
#
# 사용:
#   ./scripts/build-kiro-bundle.sh [--out-dir <디렉토리>] [--upload --stage <dev|prod> [--region <region>]]
#       [--sso-start-url <url> --sso-region <r> --sso-permission-set <name> --account-id <id> [--codecommit-region <r>]]
#
# D22 Git 인증(코드 저장소 로그인) 설정 — --sso-* 3개를 모두 주면 활성(일부만 주면 오류):
#   두 zip 모두에 apphub-aws.conf(KEY=VALUE) 를 넣고, mac zip 에 setup-aws-git.sh, windows zip 에
#   setup-aws-git.ps1 을 넣는다. 하나도 안 주면 셋 다 넣지 않는다(이전과 같은 번들).
#
# 동작(멱등):
#   1. kiro-config/ 의 구성으로 OS별 zip 2개를 만든다(결정적: 파일 목록 고정, README는 README.md로 rename).
#      훅/설치 스크립트의 실행 비트를 보존한다.
#   2. --upload 지정 시, 플랫폼 자산 버킷의 고정 키로 각각 업로드한다:
#         s3://{AssetsBucketName}/kiro-config/kiro-config-mac.zip
#         s3://{AssetsBucketName}/kiro-config/kiro-config-windows.zip
#      (deploy.sh 3b의 검증기/CDK소스 업로드와 동일한 자산 버킷·고정 키 패턴)
#
# 서빙 계약:
#   - 프론트 "Kiro 설정 다운로드(Mac)/(Windows)"는 이 두 고정 S3 키의 오브젝트를 제공한다.
#   - 배포용 고정 URI: s3://{assets}/kiro-config/kiro-config-{mac,windows}.zip
#     (SSM: /apphub/{stage}/platform/kiro-bundle-s3-uri-{mac,windows} — 발행은 인프라 후속 항목)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
KIRO_DIR="${ROOT_DIR}/kiro-config"

OUT_DIR=""
DO_UPLOAD="false"
STAGE=""
ASSETS_BUCKET_ARG=""
REGION="ap-northeast-2"
SSO_START_URL=""
SSO_REGION=""
SSO_PERMISSION_SET=""
ACCOUNT_ID=""
CODECOMMIT_REGION=""

usage() {
  cat <<'USAGE'
사용법: build-kiro-bundle.sh [옵션]
  --out-dir <디렉토리>      zip 2개의 출력 디렉토리 (기본: kiro-config/dist)
  --upload                  플랫폼 자산 버킷에 고정 키로 업로드
  --stage <dev|prod>        업로드 시 필수 (자산 버킷 Output 조회용)
  --assets-bucket <name>    자산 버킷명 직접 지정(주면 스택 조회 생략, deploy.sh가 전달)
  --region <region>         기본: ap-northeast-2
  Git 인증 설정(D22, 선택 — 3개 모두 주면 활성):
  --sso-start-url <url>       Identity Center 시작 URL (https://d-xxxxxxxxxx.awsapps.com/start)
  --sso-region <region>       Identity Center 리전
  --sso-permission-set <name> 권한 세트 이름 (예: AppHubGit)
  --account-id <12자리>       활성 시 필수 — AppHub(CodeCommit) AWS 계정 ID
  --codecommit-region <r>     CodeCommit 리전 (기본: --region 값)
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir) OUT_DIR="${2:-}"; shift 2 ;;
    --upload)  DO_UPLOAD="true"; shift ;;
    --stage)   STAGE="${2:-}"; shift 2 ;;
    --assets-bucket) ASSETS_BUCKET_ARG="${2:-}"; shift 2 ;;
    --region)  REGION="${2:-}"; shift 2 ;;
    --sso-start-url)      SSO_START_URL="${2:-}"; shift 2 ;;
    --sso-region)         SSO_REGION="${2:-}"; shift 2 ;;
    --sso-permission-set) SSO_PERMISSION_SET="${2:-}"; shift 2 ;;
    --account-id)         ACCOUNT_ID="${2:-}"; shift 2 ;;
    --codecommit-region)  CODECOMMIT_REGION="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "알 수 없는 인자: $1" >&2; usage; exit 2 ;;
  esac
done

log() { echo "[kiro-bundle] $*"; }

# ── D22 Git 인증 설정 인자 검증(전부/없음) ──────────────────────────────────
GIT_AUTH="false"
SSO_GIVEN=0
for v in "${SSO_START_URL}" "${SSO_REGION}" "${SSO_PERMISSION_SET}"; do
  [[ -n "${v}" ]] && SSO_GIVEN=$((SSO_GIVEN + 1))
done
if [[ "${SSO_GIVEN}" -eq 3 ]]; then
  GIT_AUTH="true"
  [[ -n "${CODECOMMIT_REGION}" ]] || CODECOMMIT_REGION="${REGION}"
  [[ "${SSO_START_URL}" =~ ^https://[^[:space:]]+$ ]] \
    || { echo "오류: --sso-start-url 은 https:// 로 시작해야 합니다: ${SSO_START_URL}" >&2; exit 2; }
  [[ "${SSO_REGION}" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]] \
    || { echo "오류: --sso-region 형식이 올바르지 않습니다(예: ap-northeast-2): ${SSO_REGION}" >&2; exit 2; }
  [[ "${CODECOMMIT_REGION}" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]] \
    || { echo "오류: --codecommit-region 형식이 올바르지 않습니다: ${CODECOMMIT_REGION}" >&2; exit 2; }
  [[ "${SSO_PERMISSION_SET}" =~ ^[A-Za-z0-9+=,.@-]{1,32}$ ]] \
    || { echo "오류: --sso-permission-set 은 영숫자와 +=,.@- 로 1~32자여야 합니다: ${SSO_PERMISSION_SET}" >&2; exit 2; }
  [[ "${ACCOUNT_ID}" =~ ^[0-9]{12}$ ]] \
    || { echo "오류: Git 인증 설정에는 --account-id <12자리 숫자> 가 필요합니다." >&2; exit 2; }
elif [[ "${SSO_GIVEN}" -ne 0 ]]; then
  echo "오류: --sso-start-url / --sso-region / --sso-permission-set 은 3개를 모두 주거나 모두 생략해야 합니다." >&2
  exit 2
fi

# ── 전제조건 점검 ────────────────────────────────────────────────────────────
if [[ ! -d "${KIRO_DIR}/.kiro" ]]; then
  echo "오류: ${KIRO_DIR}/.kiro 디렉토리가 없습니다." >&2
  exit 1
fi
command -v zip >/dev/null 2>&1 || { echo "오류: 'zip' 명령이 필요합니다." >&2; exit 1; }

# 필수 파일 존재 확인(번들 무결성).
#   공통: steering + pre-commit 훅
#   OS별: 설치기(sh/ps1) + README(mac/windows)
STEERING="${KIRO_DIR}/.kiro/steering/deployment-standard.md"
HOOK="${KIRO_DIR}/hooks/pre-commit"
INSTALLER_SH="${KIRO_DIR}/install-hooks.sh"
INSTALLER_PS1="${KIRO_DIR}/install-hooks.ps1"
README_MAC="${KIRO_DIR}/README-mac.md"
README_WIN="${KIRO_DIR}/README-windows.md"
SETUP_SH="${KIRO_DIR}/setup-aws-git.sh"
SETUP_PS1="${KIRO_DIR}/setup-aws-git.ps1"
REQUIRED=("${STEERING}" "${HOOK}" "${INSTALLER_SH}" "${INSTALLER_PS1}" "${README_MAC}" "${README_WIN}")
[[ "${GIT_AUTH}" == "true" ]] && REQUIRED+=("${SETUP_SH}" "${SETUP_PS1}")
for f in "${REQUIRED[@]}"; do
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
sh -n "${HOOK}"         || { echo "오류: hooks/pre-commit 문법 오류: ${HOOK}" >&2; exit 1; }
sh -n "${INSTALLER_SH}" || { echo "오류: install-hooks.sh 문법 오류: ${INSTALLER_SH}" >&2; exit 1; }
PS1_FILES=("${INSTALLER_PS1}")
if [[ "${GIT_AUTH}" == "true" ]]; then
  sh -n "${SETUP_SH}" || { echo "오류: setup-aws-git.sh 문법 오류: ${SETUP_SH}" >&2; exit 1; }
  PS1_FILES+=("${SETUP_PS1}")
fi
# PowerShell 문법 검증(pwsh 가 있으면; CI/mac 에 없을 수 있어 best-effort).
if command -v pwsh >/dev/null 2>&1; then
  for ps1 in "${PS1_FILES[@]}"; do
    pwsh -NoProfile -Command "\$null = [System.Management.Automation.Language.Parser]::ParseFile('${ps1}', [ref]\$null, [ref]\$errs); if (\$errs) { \$errs | ForEach-Object { \$_.ToString() }; exit 1 }" \
      || { echo "오류: PowerShell 문법 오류: ${ps1}" >&2; exit 1; }
  done
  log "스크립트 문법(sh -n / pwsh parse) OK"
else
  log "스크립트 문법(sh -n) OK — pwsh 미설치로 install-hooks.ps1 파싱 검증은 건너뜀"
fi
# 실행 비트 보장(zip에 권한을 담기 위해 원본에 먼저 부여).
chmod +x "${HOOK}" "${INSTALLER_SH}"
[[ "${GIT_AUTH}" == "true" ]] && chmod +x "${SETUP_SH}"

# ── zip 생성 (결정적) ────────────────────────────────────────────────────────
if [[ -z "${OUT_DIR}" ]]; then
  OUT_DIR="${KIRO_DIR}/dist"
fi
mkdir -p "${OUT_DIR}"

# apphub-aws.conf 내용(D22 계약 형식: KEY=VALUE, 주석 #, UTF-8, LF). 비밀값 없음.
write_aws_conf() {
  {
    echo "# AppHub — 코드 저장소(CodeCommit) 로그인 설정. setup-aws-git 이 읽습니다(비밀값 없음)."
    echo "# 이 파일은 AppHub 설치 시 자동 생성됩니다 — 직접 고치지 마세요."
    echo "SSO_START_URL=${SSO_START_URL}"
    echo "SSO_REGION=${SSO_REGION}"
    echo "ACCOUNT_ID=${ACCOUNT_ID}"
    echo "PERMISSION_SET=${SSO_PERMISSION_SET}"
    echo "CODECOMMIT_REGION=${CODECOMMIT_REGION}"
    echo "PROFILE_NAME=apphub"
  } > "$1"
}

# build_zip <설치기 파일명> <README 소스 파일명> <출력 zip 경로> [<Git 인증 설정기 파일명>]
# 스테이징 디렉토리에 공통(.kiro·hooks) + 지정 설치기 + README(→README.md) 만 담아 zip 한다.
# 이렇게 해야 각 OS zip에 해당 OS 설치기와 안내만 들어가고, README는 항상 README.md 로 보인다.
build_zip() {
  local installer_name="$1" readme_src="$2" out_zip="$3" setup_name="${4:-}"
  local stage_dir
  local -a extra=()
  stage_dir="$(mktemp -d)"
  # 공통 파일 복사(디렉토리 구조 유지).
  cp -R "${KIRO_DIR}/.kiro" "${stage_dir}/.kiro"
  mkdir -p "${stage_dir}/hooks"
  cp -p "${HOOK}" "${stage_dir}/hooks/pre-commit"
  # OS별 설치기 + README(→ README.md).
  cp -p "${KIRO_DIR}/${installer_name}" "${stage_dir}/${installer_name}"
  cp -p "${KIRO_DIR}/${readme_src}" "${stage_dir}/README.md"
  # D22: Git 인증 활성 시에만 설정 파일 + OS별 설정기.
  if [[ -n "${setup_name}" ]]; then
    write_aws_conf "${stage_dir}/apphub-aws.conf"
    cp -p "${KIRO_DIR}/${setup_name}" "${stage_dir}/${setup_name}"
    extra=(apphub-aws.conf "${setup_name}")
  fi

  rm -f "${out_zip}"
  # -X: 확장 속성 제외(결정적), -r: 재귀. 유닉스 실행 비트는 zip이 보존한다.
  ( cd "${stage_dir}" && zip -X -r "${out_zip}" .kiro hooks "${installer_name}" README.md ${extra[@]+"${extra[@]}"} >/dev/null )
  rm -rf "${stage_dir}"

  log "zip 생성 완료: ${out_zip}"
  log "번들 내용:"
  unzip -l "${out_zip}" | sed 's/^/    /'
}

MAC_ZIP="${OUT_DIR}/kiro-config-mac.zip"
WIN_ZIP="${OUT_DIR}/kiro-config-windows.zip"

log "mac 번들 생성 → ${MAC_ZIP}"
if [[ "${GIT_AUTH}" == "true" ]]; then
  log "Git 인증 설정 포함: Identity Center(권한 세트 ${SSO_PERMISSION_SET}, 계정 ${ACCOUNT_ID}, CodeCommit ${CODECOMMIT_REGION})"
  MAC_SETUP="setup-aws-git.sh"; WIN_SETUP="setup-aws-git.ps1"
else
  log "Git 인증 설정 미포함(--sso-* 미지정)"
  MAC_SETUP=""; WIN_SETUP=""
fi
build_zip "install-hooks.sh" "README-mac.md" "${MAC_ZIP}" "${MAC_SETUP}"
log "windows 번들 생성 → ${WIN_ZIP}"
build_zip "install-hooks.ps1" "README-windows.md" "${WIN_ZIP}" "${WIN_SETUP}"

# ── 업로드(선택) ─────────────────────────────────────────────────────────────
if [[ "${DO_UPLOAD}" == "true" ]]; then
  if [[ "${STAGE}" != "dev" && "${STAGE}" != "prod" ]]; then
    echo "오류: --upload 에는 --stage <dev|prod> 가 필요합니다." >&2
    exit 2
  fi
  command -v aws >/dev/null 2>&1 || { echo "오류: 'aws' CLI가 필요합니다." >&2; exit 1; }
  # 자산 버킷 결정:
  #  - --assets-bucket 로 직접 주면(deploy.sh 경로) describe-stacks 재조회를 건너뛴다.
  #    deploy.sh가 platform 스택의 AssetsBucketName Output을 이미 확정해 전달하므로,
  #    같은 배포 안에서 버킷을 두 번 조회할 때 생길 수 있는 불일치를 원천 제거한다.
  #  - 미지정 시(수동 단독 실행) 기존대로 platform 스택에서 Output을 조회한다(하위호환).
  #  S3 키(kiro-config/*)는 stage 무관 고정이지만, --stage 검사는 위에서 그대로 유지한다.
  PLATFORM_STACK="apphub-${STAGE}-platform"
  if [[ -n "${ASSETS_BUCKET_ARG}" ]]; then
    ASSETS_BUCKET="${ASSETS_BUCKET_ARG}"
    log "자산 버킷 직접 지정됨(스택 조회 생략): ${ASSETS_BUCKET}"
  else
    ASSETS_BUCKET="$(aws cloudformation describe-stacks \
      --stack-name "${PLATFORM_STACK}" --region "${REGION}" \
      --query "Stacks[0].Outputs[?OutputKey=='AssetsBucketName'].OutputValue" \
      --output text 2>/dev/null || true)"
  fi
  if [[ -z "${ASSETS_BUCKET}" || "${ASSETS_BUCKET}" == "None" ]]; then
    echo "오류: ${PLATFORM_STACK} 의 AssetsBucketName Output을 찾을 수 없습니다." >&2
    echo "      플랫폼이 먼저 배포돼 있어야 합니다(deploy.sh)." >&2
    exit 1
  fi
  MAC_KEY="kiro-config/kiro-config-mac.zip"
  WIN_KEY="kiro-config/kiro-config-windows.zip"
  log "업로드 → s3://${ASSETS_BUCKET}/${MAC_KEY}"
  aws s3 cp "${MAC_ZIP}" "s3://${ASSETS_BUCKET}/${MAC_KEY}" --region "${REGION}"
  log "업로드 → s3://${ASSETS_BUCKET}/${WIN_KEY}"
  aws s3 cp "${WIN_ZIP}" "s3://${ASSETS_BUCKET}/${WIN_KEY}" --region "${REGION}"
  log "업로드 완료. 다운로드 계약 URI:"
  log "  mac    : s3://${ASSETS_BUCKET}/${MAC_KEY}"
  log "  windows: s3://${ASSETS_BUCKET}/${WIN_KEY}"
fi

log "완료."
