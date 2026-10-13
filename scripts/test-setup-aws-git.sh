#!/usr/bin/env bash
#
# kiro-config/setup-aws-git.sh 동작 테스트 (D22, KIRO-STANDARDS 2.3).
#
# 실제 사용자 설정(~/.aws, ~/.gitconfig)은 절대 건드리지 않는다:
#   - HOME, GIT_CONFIG_GLOBAL 을 임시 디렉토리로, GIT_CONFIG_NOSYSTEM=1, AWS_* 환경변수 제거.
#   - PATH = 가짜 aws(fakebin) + 시스템 기본 경로(/usr/bin:/bin)만 — 실제 aws CLI 는 보이지 않는다.
#   - git 은 실제 git 을 쓰되 위 격리로 임시 전역 설정만 읽고 쓴다(설정 의미를 실제 git 으로 검증).
# 스크립트는 macOS 기본 /bin/sh 로 실행한다(고객 PC 와 동일).
#
# 사용: bash scripts/test-setup-aws-git.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SRC_SH="${ROOT_DIR}/kiro-config/setup-aws-git.sh"

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  ok   - $*"; }
bad()  { FAIL=$((FAIL + 1)); echo "  FAIL - $*"; }
check() { local desc="$1"; shift; if "$@"; then ok "$desc"; else bad "$desc"; fi; }

REAL_GIT="$(command -v git)"
[[ -n "${REAL_GIT}" ]] || { echo "git 이 필요합니다." >&2; exit 1; }
SYS_PATH="/usr/bin:/bin"
if [[ -x /usr/bin/aws || -x /bin/aws ]]; then
  echo "경고: 시스템 기본 경로에 aws 가 있어 'aws 없음' 케이스를 검증할 수 없습니다." >&2
fi

WORK="$(mktemp -d -t apphub-setup-aws-git-XXXXXX)"
trap 'rm -rf "${WORK}"' EXIT

# ── 가짜 aws ────────────────────────────────────────────────────────────────
FAKEBIN="${WORK}/fakebin"
mkdir -p "${FAKEBIN}"
cat > "${FAKEBIN}/aws" <<'FAKE'
#!/bin/sh
echo "$*" >> "${FAKE_AWS_LOG:-/dev/null}"
case "$1" in
  --version) echo "${FAKE_AWS_VERSION:-aws-cli/2.15.30 Python/3.11.8 Darwin/23 exe/x86_64}"; exit 0 ;;
  sso) [ "${FAKE_AWS_LOGIN_FAIL:-0}" = 1 ] && { echo "login failed" >&2; exit 255; }; echo "Successfully logged into Start URL"; exit 0 ;;
esac
exit 0
FAKE
chmod +x "${FAKEBIN}/aws"
# git 은 실제 git 을 가리키는 링크로 fakebin 에 둔다(PATH 를 줄여도 찾도록).
ln -s "${REAL_GIT}" "${FAKEBIN}/git"

# ── 번들 디렉토리(스크립트 + conf) ──────────────────────────────────────────
BUNDLE="${WORK}/bundle"
mkdir -p "${BUNDLE}"
cp "${SRC_SH}" "${BUNDLE}/setup-aws-git.sh"
cat > "${BUNDLE}/apphub-aws.conf" <<'CONF'
# AppHub — 코드 저장소 로그인 설정 (자동 생성)
SSO_START_URL=https://d-1234567890.awsapps.com/start
SSO_REGION=ap-northeast-2
ACCOUNT_ID=123456789012
PERMISSION_SET=AppHubGit
CODECOMMIT_REGION=ap-northeast-2
PROFILE_NAME=apphub
CONF

H="${WORK}/home"
CFG="${H}/.aws/config"
GCFG="${H}/gitconfig-global"
LOG="${WORK}/aws.log"
KEY="credential.https://git-codecommit.ap-northeast-2.amazonaws.com"
HELPER='!aws codecommit credential-helper --profile apphub $@'

reset_home() {
  rm -rf "${H}"; mkdir -p "${H}"; : > "${LOG}"
}

# 격리 환경에서 실행. stdin 은 /dev/null(비대화형).
run_setup() {
  env -i HOME="${H}" PATH="${FAKEBIN}:${SYS_PATH}" \
    GIT_CONFIG_GLOBAL="${GCFG}" GIT_CONFIG_NOSYSTEM=1 \
    FAKE_AWS_LOG="${LOG}" FAKE_AWS_VERSION="${FAKE_AWS_VERSION:-}" FAKE_AWS_LOGIN_FAIL="${FAKE_AWS_LOGIN_FAIL:-0}" \
    LANG=en_US.UTF-8 \
    /bin/sh "${BUNDLE}/setup-aws-git.sh" "$@" </dev/null >"${WORK}/out.txt" 2>&1
}

gitg() { HOME="${H}" GIT_CONFIG_GLOBAL="${GCFG}" GIT_CONFIG_NOSYSTEM=1 "${REAL_GIT}" config --global "$@"; }

# 섹션 텍스트 추출(머리 포함, 다음 머리 전까지).
section_text() { awk -v h="[$1]" '$0 ~ /^\[/ { ins = ($0 == h) } ins' "$2"; }
headers() { grep -E '^\[' "$1" | tr '\n' '|'; }
sum() { [[ -f "$1" ]] && shasum -a 256 "$1" | awk '{print $1}' || echo none; }
mode_of() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"; }

seed_existing() {
  mkdir -p "${H}/.aws"
  cat > "${CFG}" <<'EOF'
[default]
region = us-east-1
output = json

[profile other]
region = eu-west-1
role_arn = arn:aws:iam::111111111111:role/x
EOF
  gitg credential.helper osxkeychain
  gitg credential.https://github.com.helper "!gh auth git-credential"
  gitg user.name "Test User"
}

echo "# setup-aws-git.sh (sh -n)"
check "sh -n 구문 검사" sh -n "${SRC_SH}"
if command -v dash >/dev/null 2>&1; then check "dash -n 구문 검사" dash -n "${SRC_SH}"; fi

echo "# 1. conf 없음 → 중단"
reset_home
mv "${BUNDLE}/apphub-aws.conf" "${WORK}/conf.save"
run_setup --no-login; rc=$?
mv "${WORK}/conf.save" "${BUNDLE}/apphub-aws.conf"
check "exit 1" test "${rc}" -eq 1
check "설정 파일 안내 문구" grep -q "설정 파일을 찾을 수 없어요" "${WORK}/out.txt"
check "~/.aws/config 미생성" test ! -e "${CFG}"

echo "# 2. AWS CLI 없음 / v1 → 중단(아무것도 안 바뀜)"
reset_home
mv "${FAKEBIN}/aws" "${WORK}/aws.save"
run_setup --no-login; rc=$?
mv "${WORK}/aws.save" "${FAKEBIN}/aws"
check "aws 없음 exit 1" test "${rc}" -eq 1
check "설치 안내 URL 출력" grep -q "getting-started-install" "${WORK}/out.txt"
check "aws 없음 — config 미생성" test ! -e "${CFG}"
FAKE_AWS_VERSION="aws-cli/1.29.0 Python/3.9" run_setup --no-login; rc=$?
check "aws v1 exit 1" test "${rc}" -eq 1
check "aws v1 — config 미생성" test ! -e "${CFG}"
check "aws v1 — git 설정 미생성" test ! -e "${GCFG}"
FAKE_AWS_VERSION="aws-cli/2.8.12 Python/3.9.11" run_setup --no-login; rc=$?
check "aws 2.8(sso-session 미지원) exit 1" test "${rc}" -eq 1
check "aws 2.8 — 업데이트 안내" grep -q "2.9 이상" "${WORK}/out.txt"
check "aws 2.8 — config 미생성" test ! -e "${CFG}"

echo "# 3. 빈 HOME — 새로 생성(권한 700/600)"
reset_home
run_setup --no-login; rc=$?
check "exit 0" test "${rc}" -eq 0
check "~/.aws 권한 700" test "$(mode_of "${H}/.aws")" = 700
check "config 권한 600" test "$(mode_of "${CFG}")" = 600
check "[sso-session apphub] 존재" grep -qx '\[sso-session apphub\]' "${CFG}"
check "[profile apphub] 존재" grep -qx '\[profile apphub\]' "${CFG}"
check "aws sso login 미호출(--no-login)" bash -c "! grep -q 'sso login' '${LOG}'"

echo "# 4. 기존 설정 보존 + 섹션 내용"
reset_home
seed_existing
DEFAULT_BEFORE="$(section_text default "${CFG}")"
OTHER_BEFORE="$(section_text 'profile other' "${CFG}")"
run_setup --no-login; rc=$?
check "exit 0" test "${rc}" -eq 0
check "[default] 불변" test "$(section_text default "${CFG}")" = "${DEFAULT_BEFORE}"
check "[profile other] 불변" test "$(section_text 'profile other' "${CFG}")" = "${OTHER_BEFORE}"
EXPECT_SESSION='[sso-session apphub]
sso_start_url = https://d-1234567890.awsapps.com/start
sso_region = ap-northeast-2
sso_registration_scopes = sso:account:access'
EXPECT_PROFILE='[profile apphub]
sso_session = apphub
sso_account_id = 123456789012
sso_role_name = AppHubGit
region = ap-northeast-2'
check "sso-session 본문 계약 일치" test "$(section_text 'sso-session apphub' "${CFG}" | sed '/^$/d')" = "${EXPECT_SESSION}"
check "profile 본문 계약 일치" test "$(section_text 'profile apphub' "${CFG}" | sed '/^$/d')" = "${EXPECT_PROFILE}"
check "헤더 순서(기존 뒤에 추가)" test "$(headers "${CFG}")" = "[default]|[profile other]|[sso-session apphub]|[profile apphub]|"

echo "# 5. git helper 순서·useHttpPath·다른 호스트 불변"
HELPERS="$(gitg --get-all "${KEY}.helper"; printf x)"
check "helper = [\"\", aws helper] 순서" test "${HELPERS}" = "$(printf '\n%s\nx' "${HELPER}")"
check "useHttpPath = true" test "$(gitg --get "${KEY}.useHttpPath")" = "true"
check "전역 credential.helper(osxkeychain) 불변" test "$(gitg --get-all credential.helper)" = "osxkeychain"
check "github.com helper 불변" test "$(gitg --get-all credential.https://github.com.helper)" = "!gh auth git-credential"
check "user.name 불변" test "$(gitg --get user.name)" = "Test User"
# 실제 git 이 이 URL 에 대해 고르는 helper 목록(빈 값으로 osxkeychain 이 초기화되는지).
EFFECTIVE="$(HOME="${H}" GIT_CONFIG_GLOBAL="${GCFG}" GIT_CONFIG_NOSYSTEM=1 "${REAL_GIT}" config --get-urlmatch credential.helper https://git-codecommit.ap-northeast-2.amazonaws.com/v1/repos/x)"
check "codecommit URL 의 유효 helper = aws helper(마지막 값)" test "${EFFECTIVE}" = "${HELPER}"
EFFECTIVE_GH="$(HOME="${H}" GIT_CONFIG_GLOBAL="${GCFG}" GIT_CONFIG_NOSYSTEM=1 "${REAL_GIT}" config --get-urlmatch credential.helper https://github.com/o/r)"
check "github URL 의 유효 helper 는 그대로" test "${EFFECTIVE_GH}" = "!gh auth git-credential"

echo "# 6. 멱등 — 2회째 변경 없음"
S1="$(sum "${CFG}")"; G1="$(sum "${GCFG}")"
NBAK_BEFORE="$(ls "${H}/.aws/" | grep -c 'config\.bak' || true)"
run_setup --no-login; rc=$?
check "exit 0" test "${rc}" -eq 0
check "config 바이트 동일" test "$(sum "${CFG}")" = "${S1}"
check "gitconfig 바이트 동일" test "$(sum "${GCFG}")" = "${G1}"
check "'변경 없음' 안내" grep -q "이미 맞아요" "${WORK}/out.txt"
check "새 백업 파일 없음(변경 없으면 백업도 없음)" test "$(ls "${H}/.aws/" | grep -c 'config\.bak' || true)" = "${NBAK_BEFORE}"
run_setup --no-login
check "3회째도 바이트 동일" test "$(sum "${CFG}")" = "${S1}" -a "$(sum "${GCFG}")" = "${G1}"

echo "# 7. 사용자가 덧붙인 키(output=json)는 같은 값으로 간주·보존"
printf 'output = json\n' >> "${CFG}"
S2="$(sum "${CFG}")"
run_setup --no-login; rc=$?
check "exit 0 · 변경 없음" test "${rc}" -eq 0 -a "$(sum "${CFG}")" = "${S2}"

echo "# 8. 로그인 실행/실패"
run_setup; rc=$?
check "aws sso login --profile apphub 호출" grep -q '^sso login --profile apphub$' "${LOG}"
check "확인 명령 안내" grep -q "aws sts get-caller-identity --profile apphub" "${WORK}/out.txt"
FAKE_AWS_LOGIN_FAIL=1 run_setup; rc=$?
check "로그인 실패해도 exit 0" test "${rc}" -eq 0
check "로그인 실패 안내" grep -q "로그인하지 못했어요" "${WORK}/out.txt"
check "로그인 실패 — 설정 유지" grep -qx '\[profile apphub\]' "${CFG}"

echo "# 9. 다른 값 충돌 → 중단(아무것도 안 바뀜)"
reset_home
seed_existing
run_setup --no-login
# 기존 apphub 프로필을 다른 권한 세트로 바꿔 둔다 + git helper 도 지워 둔다(부분 적용 여부 확인용).
sed -i.tmp 's/^sso_role_name = AppHubGit$/sso_role_name = SomethingElse/' "${CFG}"; rm -f "${CFG}.tmp"
gitg --unset-all "${KEY}.helper"
S3="$(sum "${CFG}")"; G3="$(sum "${GCFG}")"
run_setup --no-login; rc=$?
check "exit 1" test "${rc}" -eq 1
check "충돌 안내(--force)" grep -q -- "--force" "${WORK}/out.txt"
check "현재 값 표시" grep -q "SomethingElse" "${WORK}/out.txt"
check "config 불변" test "$(sum "${CFG}")" = "${S3}"
check "gitconfig 불변(부분 적용 없음)" test "$(sum "${GCFG}")" = "${G3}"

echo "# 10. --force → 두 섹션만 같은 자리에서 교체 + 백업"
# 순서 검증용으로 apphub 섹션 뒤에 다른 섹션을 하나 더 둔다.
printf '\n[profile tail]\nregion = us-west-2\n' >> "${CFG}"
DEFAULT_BEFORE="$(section_text default "${CFG}")"
TAIL_BEFORE="$(section_text 'profile tail' "${CFG}")"
run_setup --no-login --force; rc=$?
check "exit 0" test "${rc}" -eq 0
BAK="$(ls "${H}/.aws/" | grep '^config\.bak\.' | sort | tail -n 1)"   # 이번 --force 실행이 만든 최신 백업
check "config.bak.{timestamp} 생성" test -n "${BAK}"
check "백업에 원래 값" grep -q "sso_role_name = SomethingElse" "${H}/.aws/${BAK:-none}"
check "새 값으로 교체" test "$(section_text 'profile apphub' "${CFG}" | sed '/^$/d')" = "${EXPECT_PROFILE}"
check "옛 값 제거" bash -c "! grep -q SomethingElse '${CFG}'"
check "[default] 불변" test "$(section_text default "${CFG}")" = "${DEFAULT_BEFORE}"
check "[profile tail] 불변" test "$(section_text 'profile tail' "${CFG}")" = "${TAIL_BEFORE}"
check "헤더 순서 유지(같은 자리 교체)" test "$(headers "${CFG}")" = "[default]|[profile other]|[sso-session apphub]|[profile apphub]|[profile tail]|"
check "git helper 복구" test "$(gitg --get-all "${KEY}.helper"; printf x)" = "$(printf '\n%s\nx' "${HELPER}")"

echo "# 11. codecommit 주소에 다른 helper → 비대화형이면 중단, --force 면 교체"
reset_home
gitg "${KEY}.helper" "store"
G4="$(sum "${GCFG}")"
if { true </dev/tty; } 2>/dev/null; then
  echo "  skip - 제어 터미널이 있어 비대화형 중단 케이스는 건너뜀"
else
  run_setup --no-login; rc=$?
  check "비대화형 exit 1" test "${rc}" -eq 1
  check "기존 helper 안내" grep -q "store" "${WORK}/out.txt"
  check "gitconfig 불변" test "$(sum "${GCFG}")" = "${G4}"
  check "config 미생성(부분 적용 없음)" test ! -e "${CFG}"
fi
run_setup --no-login --force; rc=$?
check "--force exit 0" test "${rc}" -eq 0
check "store → [\"\", aws helper]" test "$(gitg --get-all "${KEY}.helper"; printf x)" = "$(printf '\n%s\nx' "${HELPER}")"

echo "# 12. --uninstall → apphub 섹션·git 키만 제거"
reset_home
seed_existing
DEFAULT_BEFORE="$(section_text default "${CFG}")"
OTHER_BEFORE="$(section_text 'profile other' "${CFG}")"
run_setup --no-login
run_setup --uninstall; rc=$?
check "exit 0" test "${rc}" -eq 0
check "sso-session 제거" bash -c "! grep -q 'sso-session apphub' '${CFG}'"
check "profile apphub 제거" bash -c "! grep -q 'profile apphub' '${CFG}'"
check "[default] 불변" test "$(section_text default "${CFG}")" = "${DEFAULT_BEFORE}"
check "[profile other] 불변" test "$(section_text 'profile other' "${CFG}")" = "${OTHER_BEFORE}"
check "codecommit helper 제거" test -z "$(gitg --get-all "${KEY}.helper")"
check "codecommit 섹션 머리 제거" bash -c "! grep -q 'git-codecommit' '${GCFG}'"
check "전역 osxkeychain 불변" test "$(gitg --get-all credential.helper)" = "osxkeychain"
check "github helper 불변" test "$(gitg --get-all credential.https://github.com.helper)" = "!gh auth git-credential"
S5="$(sum "${CFG}")"; G5="$(sum "${GCFG}")"
run_setup --uninstall; rc=$?
check "2회째 uninstall exit 0 · 변경 없음" test "${rc}" -eq 0 -a "$(sum "${CFG}")" = "${S5}" -a "$(sum "${GCFG}")" = "${G5}"
run_setup --no-login; rc=$?
check "제거 후 재설치 exit 0" test "${rc}" -eq 0 -a "$(grep -c '^\[profile apphub\]$' "${CFG}")" -eq 1

echo "# 13. 잘못된 옵션 / conf 값 누락"
run_setup --bogus; rc=$?
check "알 수 없는 옵션 exit 1" test "${rc}" -eq 1
cp "${BUNDLE}/apphub-aws.conf" "${WORK}/conf.save"
grep -v '^ACCOUNT_ID=' "${WORK}/conf.save" > "${BUNDLE}/apphub-aws.conf"
run_setup --no-login; rc=$?
cp "${WORK}/conf.save" "${BUNDLE}/apphub-aws.conf"
check "ACCOUNT_ID 누락 exit 1" test "${rc}" -eq 1
# CRLF 로 저장된 conf(윈도우에서 편집 등)도 읽는다.
reset_home
sed 's/$/\r/' "${WORK}/conf.save" > "${BUNDLE}/apphub-aws.conf"
run_setup --no-login; rc=$?
cp "${WORK}/conf.save" "${BUNDLE}/apphub-aws.conf"
check "CRLF conf exit 0" test "${rc}" -eq 0
check "CRLF conf — 값에 CR 없음" bash -c "! grep -q \$'\r' '${CFG}'"

echo
echo "결과: ${PASS} 통과, ${FAIL} 실패"
[[ "${FAIL}" -eq 0 ]]
