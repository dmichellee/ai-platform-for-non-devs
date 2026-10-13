#!/bin/sh
# AppHub — 코드 저장소(CodeCommit) 로그인 설정 (macOS / Linux, PC당 1회)
#
# 하는 일 (몇 번 실행해도 결과가 같다):
#   1. 같은 폴더의 apphub-aws.conf 를 읽는다(회사 AWS 로그인 정보 — 비밀값 없음).
#   2. AWS CLI v2 가 설치돼 있는지 확인한다.
#   3. ~/.aws/config 에 [sso-session apphub] + [profile apphub] 두 섹션을 추가한다.
#      - 이미 같은 값이면 아무것도 바꾸지 않는다.
#      - 다른 값이 있으면 덮어쓰지 않고 멈춘다(--force 면 두 섹션만 교체, 원본은 config.bak.시각 으로 백업).
#      - 다른 섹션은 절대 건드리지 않는다.
#   4. git 전역 설정 — CodeCommit 주소(git-codecommit.{리전}.amazonaws.com)에만 AWS 로그인 도우미를 쓴다.
#      다른 git 호스트(GitHub 등) 설정은 건드리지 않는다.
#   5. aws sso login --profile apphub 로 브라우저 로그인(--no-login 이면 생략).
#
# 사용:
#   sh setup-aws-git.sh              # 설정 + 로그인
#   sh setup-aws-git.sh --no-login   # 설정만
#   sh setup-aws-git.sh --force      # 기존 apphub 설정이 다르면 교체(확인 생략)
#   sh setup-aws-git.sh --uninstall  # 이 스크립트가 넣은 설정만 제거
#
# 의존성: POSIX sh + awk + git + aws(CLI v2). macOS 기본 /bin/sh(bash 3.2)에서 동작.

set -eu

FORCE=0
UNINSTALL=0
NO_LOGIN=0
for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --no-login) NO_LOGIN=1 ;;
    -h|--help)
      echo "사용: sh setup-aws-git.sh [--no-login] [--force] [--uninstall]"
      echo "  --no-login   설정만 하고 브라우저 로그인(aws sso login)은 건너뜁니다."
      echo "  --force      이미 다른 값의 apphub 설정이 있어도 확인 없이 교체합니다(원본은 백업)."
      echo "  --uninstall  이 스크립트가 넣은 설정(~/.aws/config 의 apphub 두 섹션, git CodeCommit 설정)만 제거합니다."
      exit 0
      ;;
    *)
      echo "오류: 알 수 없는 옵션이에요: $arg" >&2
      echo "      사용법은 'sh setup-aws-git.sh --help' 를 참고하세요." >&2
      exit 1
      ;;
  esac
done

say()  { echo "[setup-aws-git] $*"; }
fail() { echo "[setup-aws-git] 오류: $*" >&2; exit 1; }

# ── 1. 설정 파일 읽기 ────────────────────────────────────────────────────────
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CONF="$SCRIPT_DIR/apphub-aws.conf"
if [ ! -f "$CONF" ]; then
  echo "[setup-aws-git] 오류: 설정 파일을 찾을 수 없어요: $CONF" >&2
  echo "      이 스크립트는 Kiro 설정 zip 을 푼 폴더(apphub-aws.conf 와 함께 있는 곳)에서 실행하세요." >&2
  echo "      zip 에 apphub-aws.conf 가 없다면, 이 회사 AppHub 는 코드 저장소 로그인 설정을 쓰지 않아요." >&2
  echo "      관리자에게 문의하세요." >&2
  exit 1
fi

# KEY=VALUE 만 읽는다(셸로 실행하지 않음 — source 금지). 주석(#)·빈 줄 무시, CR 제거.
conf_get() {
  awk -v k="$1" '
    { sub(/\r$/, "") }
    /^[ \t]*#/ || /^[ \t]*$/ { next }
    {
      i = index($0, "=")
      if (i == 0) next
      key = substr($0, 1, i - 1); val = substr($0, i + 1)
      gsub(/^[ \t]+|[ \t]+$/, "", key); gsub(/^[ \t]+|[ \t]+$/, "", val)
      if (key == k) { print val; exit }
    }' "$CONF"
}

SSO_START_URL=$(conf_get SSO_START_URL)
SSO_REGION=$(conf_get SSO_REGION)
ACCOUNT_ID=$(conf_get ACCOUNT_ID)
PERMISSION_SET=$(conf_get PERMISSION_SET)
CODECOMMIT_REGION=$(conf_get CODECOMMIT_REGION)
PROFILE_NAME=$(conf_get PROFILE_NAME)
[ -n "$PROFILE_NAME" ] || PROFILE_NAME="apphub"

for pair in "SSO_START_URL=$SSO_START_URL" "SSO_REGION=$SSO_REGION" "ACCOUNT_ID=$ACCOUNT_ID" \
            "PERMISSION_SET=$PERMISSION_SET" "CODECOMMIT_REGION=$CODECOMMIT_REGION"; do
  case "$pair" in
    *=) fail "apphub-aws.conf 에 ${pair%=} 값이 없어요. 관리자에게 새 Kiro 설정 zip 을 요청하세요." ;;
  esac
done
case "$PROFILE_NAME" in
  *[!A-Za-z0-9_-]*) fail "apphub-aws.conf 의 PROFILE_NAME 에는 영문·숫자·-·_ 만 쓸 수 있어요: $PROFILE_NAME" ;;
esac

SESSION_HDR="sso-session $PROFILE_NAME"
PROFILE_HDR="profile $PROFILE_NAME"
GIT_HOST="https://git-codecommit.${CODECOMMIT_REGION}.amazonaws.com"
GIT_KEY="credential.${GIT_HOST}"
HELPER="!aws codecommit credential-helper --profile ${PROFILE_NAME} \$@"

AWS_DIR="$HOME/.aws"
AWS_CFG="${AWS_CONFIG_FILE:-$AWS_DIR/config}"

# 원하는 섹션 본문(key = value 줄).
desired_session() {
  printf 'sso_start_url = %s\nsso_region = %s\nsso_registration_scopes = sso:account:access\n' \
    "$SSO_START_URL" "$SSO_REGION"
}
desired_profile() {
  printf 'sso_session = %s\nsso_account_id = %s\nsso_role_name = %s\nregion = %s\n' \
    "$PROFILE_NAME" "$ACCOUNT_ID" "$PERMISSION_SET" "$CODECOMMIT_REGION"
}

# ── ~/.aws/config 섹션 도구(awk) ─────────────────────────────────────────────
# 섹션 머리 정규화: 앞뒤 공백 제거, 대괄호 안 공백 하나로. "[ profile   apphub ]" == "[profile apphub]".
AWK_NORM='
function norm(line,   s) {
  s = line; sub(/\r$/, "", s); gsub(/^[ \t]+|[ \t]+$/, "", s)
  if (s !~ /^\[.*\]$/) return ""
  s = substr(s, 2, length(s) - 2); gsub(/^[ \t]+|[ \t]+$/, "", s); gsub(/[ \t]+/, " ", s)
  return s
}'

# section_body <머리> : 그 섹션의 "key = value" 줄(정규화)을 출력. 섹션 없으면 아무것도 출력 안 하고 1 반환.
section_body() {
  [ -f "$AWS_CFG" ] || return 1
  APPHUB_WANT="$1" awk "$AWK_NORM"'
    BEGIN { want = ENVIRON["APPHUB_WANT"] }
    { h = norm($0) }
    h != "" { insec = (h == want); if (insec) found = 1; next }
    insec {
      line = $0; sub(/\r$/, "", line)
      if (line ~ /^[ \t]*[#;]/ || line ~ /^[ \t]*$/) next
      i = index(line, "="); if (i == 0) next
      k = substr(line, 1, i - 1); v = substr(line, i + 1)
      gsub(/^[ \t]+|[ \t]+$/, "", k); gsub(/^[ \t]+|[ \t]+$/, "", v)
      print k " = " v
    }
    END { exit(found ? 0 : 1) }' "$AWS_CFG"
}

# section_state <머리> <원하는 본문> : absent | same | conflict
#  same = 원하는 key 가 전부 같은 값으로 있음(사용자가 덧붙인 다른 key 는 허용·보존).
section_state() {
  if ! body=$(section_body "$1"); then echo absent; return 0; fi
  missing=$(printf '%s\n' "$2" | while IFS= read -r want; do
    [ -n "$want" ] || continue
    k=${want%% = *}
    got=$(printf '%s\n' "$body" | APPHUB_K="$k" awk 'index($0, ENVIRON["APPHUB_K"] " = ") == 1 { print; exit }')
    [ "$got" = "$want" ] || echo "$want"
  done)
  if [ -z "$missing" ]; then echo same; else echo conflict; fi
}

# rewrite_sections <출력파일> : 두 apphub 섹션을 제거(UNINSTALL)하거나 원하는 본문으로 교체/추가.
#  같은 자리에서 교체한다 — 다른 섹션의 내용·순서는 그대로.
rewrite_sections() {
  out="$1"
  if [ "$UNINSTALL" -eq 1 ]; then s_new=""; p_new=""; else s_new=$(desired_session); p_new=$(desired_profile); fi
  src="$AWS_CFG"; [ -f "$src" ] || src=/dev/null
  # 값은 ENVIRON 으로 넘긴다(awk -v 는 줄바꿈·역슬래시를 해석해 BSD awk 에서 깨진다).
  APPHUB_SH="$SESSION_HDR" APPHUB_PH="$PROFILE_HDR" APPHUB_SB="$s_new" APPHUB_PB="$p_new" APPHUB_RM="$UNINSTALL" \
  awk "$AWK_NORM"'
    BEGIN {
      sh = ENVIRON["APPHUB_SH"]; ph = ENVIRON["APPHUB_PH"]
      sb = ENVIRON["APPHUB_SB"]; pb = ENVIRON["APPHUB_PB"]; rm = ENVIRON["APPHUB_RM"] + 0
    }
    function emit(hdr, body) {
      if (rm == 1) return
      if (NR_OUT > 0 && last != "") print ""
      print "[" hdr "]"; print body; print ""; last = ""; NR_OUT++
    }
    {
      h = norm($0)
      if (h != "") {
        skip = 0
        if (h == sh) { skip = 1; if (!s_done) { emit(sh, sb); s_done = 1 }; next }
        if (h == ph) { skip = 1; if (!p_done) { emit(ph, pb); p_done = 1 }; next }
      }
      if (skip) next
      print; last = $0; NR_OUT++
    }
    END {
      if (!s_done) emit(sh, sb)
      if (!p_done) emit(ph, pb)
    }' "$src" > "$out"
}

timestamp() { date +%Y%m%d-%H%M%S 2>/dev/null || echo backup; }

backup_cfg() {
  [ -f "$AWS_CFG" ] || return 0
  b="$AWS_CFG.bak.$(timestamp)"
  cp -p "$AWS_CFG" "$b"
  BACKED_UP=1
  say "기존 설정을 백업했어요: $b"
}

write_cfg() {
  if [ ! -d "$(dirname "$AWS_CFG")" ]; then
    mkdir -p "$(dirname "$AWS_CFG")"
    chmod 700 "$(dirname "$AWS_CFG")" 2>/dev/null || true
  fi
  tmp="$AWS_CFG.apphub-tmp.$$"
  (umask 077; rewrite_sections "$tmp")
  if [ -f "$AWS_CFG" ]; then
    # 덮어쓰기 중단 시 복구할 수 있도록 섹션 추가 경로에서도 원본을 백업한다(이미 백업했으면 생략).
    [ -n "${BACKED_UP:-}" ] || backup_cfg
    # cat > 로 덮어 기존 파일 권한·소유를 유지한다.
    cat "$tmp" > "$AWS_CFG"
  else
    (umask 077; cat "$tmp" > "$AWS_CFG")
    chmod 600 "$AWS_CFG" 2>/dev/null || true
  fi
  rm -f "$tmp"
}

git_helpers() { git config --global --get-all "${GIT_KEY}.helper" 2>/dev/null || true; }
# 이 CodeCommit 주소 섹션 아래 키 목록(정규식 이스케이프 없이 접두어 비교).
git_keys_under_host() {
  git config --global --get-regexp '^credential\.' 2>/dev/null \
    | APPHUB_P="credential.${GIT_HOST}." awk 'index(tolower($1), tolower(ENVIRON["APPHUB_P"])) == 1' || true
}

# ── git 확인 ────────────────────────────────────────────────────────────────
command -v git >/dev/null 2>&1 || fail "git 이 설치돼 있지 않아요. 먼저 git 을 설치하세요(터미널에서 'git --version' 실행 시 설치 안내가 나와요)."

# ── 제거 모드 ───────────────────────────────────────────────────────────────
if [ "$UNINSTALL" -eq 1 ]; then
  if section_body "$SESSION_HDR" >/dev/null || section_body "$PROFILE_HDR" >/dev/null; then
    backup_cfg
    write_cfg
    say "~/.aws/config 에서 [$SESSION_HDR] · [$PROFILE_HDR] 를 제거했어요."
  else
    say "~/.aws/config 에 apphub 설정이 없어요. (변경 없음)"
  fi
  if [ -n "$(git_keys_under_host)" ]; then
    git config --global --unset-all "${GIT_KEY}.helper" 2>/dev/null || true
    git config --global --unset-all "${GIT_KEY}.useHttpPath" 2>/dev/null || true
    # 이 주소 섹션에 남은 키가 없으면 빈 섹션 머리도 지운다(사용자가 넣은 다른 키가 있으면 유지).
    if [ -z "$(git_keys_under_host)" ]; then
      git config --global --remove-section "$GIT_KEY" 2>/dev/null || true
    fi
    say "git 전역 설정에서 ${GIT_HOST} 로그인 도우미 설정을 제거했어요."
  else
    say "git 전역 설정에 CodeCommit 로그인 설정이 없어요. (변경 없음)"
  fi
  say "제거 완료. 다른 AWS·git 설정은 그대로예요."
  exit 0
fi

# ── 2. AWS CLI v2 확인 ──────────────────────────────────────────────────────
AWS_INSTALL_URL="https://docs.aws.amazon.com/ko_kr/cli/latest/userguide/getting-started-install.html"
if ! command -v aws >/dev/null 2>&1; then
  echo "[setup-aws-git] AWS CLI 가 설치돼 있지 않아요. 아래 안내대로 'AWS CLI 버전 2' 를 설치한 뒤 다시 실행하세요." >&2
  echo "      $AWS_INSTALL_URL" >&2
  echo "      (macOS: 안내 페이지의 'AWSCLIV2.pkg' 를 내려받아 설치. 회사 PC 는 관리자 권한이 필요할 수 있어요.)" >&2
  exit 1
fi
AWS_VER=$(aws --version 2>&1 || true)
# AWS CLI v2 는 --version 에서도 ~/.aws/config 를 읽는다 — 파일 문제를 "v2 필요"로 오안내하지 않는다.
case "$AWS_VER" in
  *"Unable to parse config file"*)
    echo "[setup-aws-git] AWS 설정 파일(~/.aws/config)을 읽을 수 없어요. 파일 내용(문법 오류)을 확인한 뒤 다시 실행하세요." >&2
    echo "      ($AWS_VER)" >&2
    exit 1 ;;
esac
case "$AWS_VER" in
  aws-cli/2.*)
    # sso-session 설정은 AWS CLI 2.9 이상에서 지원된다(그 전 2.x 는 로그인 단계에서 실패).
    AWS_MINOR=$(printf '%s' "$AWS_VER" | sed -n 's|^aws-cli/2\.\([0-9][0-9]*\).*|\1|p')
    if [ -n "$AWS_MINOR" ] && [ "$AWS_MINOR" -lt 9 ]; then
      echo "[setup-aws-git] AWS CLI 가 오래됐어요(현재: ${AWS_VER%% *}). 2.9 이상으로 업데이트한 뒤 다시 실행하세요." >&2
      echo "      $AWS_INSTALL_URL" >&2
      exit 1
    fi
    say "AWS CLI 확인: ${AWS_VER%% *}" ;;
  *)
    echo "[setup-aws-git] AWS CLI 버전 2 가 필요해요(현재: ${AWS_VER:-알 수 없음})." >&2
    echo "      아래 안내대로 버전 2 를 설치한 뒤 다시 실행하세요: $AWS_INSTALL_URL" >&2
    exit 1
    ;;
esac

# ── 3·4. 먼저 전부 점검(아무것도 바꾸기 전에) ─────────────────────────────────
S_STATE=$(section_state "$SESSION_HDR" "$(desired_session)")
P_STATE=$(section_state "$PROFILE_HDR" "$(desired_profile)")

if [ "$S_STATE" = conflict ] || [ "$P_STATE" = conflict ]; then
  if [ "$FORCE" -ne 1 ]; then
    echo "[setup-aws-git] ~/.aws/config 에 이미 다른 값의 apphub 설정이 있어요. 덮어쓰지 않고 멈춥니다." >&2
    for hdr in "$SESSION_HDR" "$PROFILE_HDR"; do
      if body=$(section_body "$hdr"); then
        echo "      현재 [$hdr]:" >&2
        printf '%s\n' "$body" | sed 's/^/        /' >&2
      fi
    done
    echo "      바뀔 값:" >&2
    echo "        [$SESSION_HDR]" >&2; desired_session | sed 's/^/          /' >&2
    echo "        [$PROFILE_HDR]" >&2; desired_profile | sed 's/^/          /' >&2
    echo "      이 값으로 바꾸려면 'sh setup-aws-git.sh --force' 로 다시 실행하세요(원본은 백업돼요)." >&2
    exit 1
  fi
fi

EXPECTED_HELPERS=$(printf '\n%s\nx' "$HELPER")
CURRENT_HELPERS=$(git_helpers; printf 'x')
GIT_HELPER_OK=0
[ "$CURRENT_HELPERS" = "$EXPECTED_HELPERS" ] && GIT_HELPER_OK=1
if [ "$GIT_HELPER_OK" -eq 0 ]; then
  others=$(git_helpers | awk 'NF > 0')
  if [ -n "$others" ]; then
    say "${GIT_HOST} 에 이미 다른 git 로그인 도우미가 설정돼 있어요:"
    printf '%s\n' "$others" | sed 's/^/        /'
    say "이 주소에서만 AWS 로그인 도우미로 바꿉니다(다른 git 호스트 설정은 그대로)."
    if [ "$FORCE" -ne 1 ]; then
      if { true </dev/tty; } 2>/dev/null && { true >/dev/tty; } 2>/dev/null; then
        printf '바꿀까요? [y/N] ' > /dev/tty
        read -r ANSWER < /dev/tty || ANSWER=""
        case "$ANSWER" in
          y|Y|yes|YES) : ;;
          *) say "취소했어요. 아무것도 바꾸지 않았어요."; exit 1 ;;
        esac
      else
        echo "[setup-aws-git] 비대화형 환경이라 확인을 받을 수 없어요. 바꾸려면 '--force' 로 다시 실행하세요." >&2
        exit 1
      fi
    fi
  fi
fi

# ── 3. ~/.aws/config 적용 ───────────────────────────────────────────────────
if [ "$S_STATE" = same ] && [ "$P_STATE" = same ]; then
  say "~/.aws/config 의 apphub 설정이 이미 맞아요. (변경 없음)"
else
  if [ "$S_STATE" = conflict ] || [ "$P_STATE" = conflict ]; then
    backup_cfg
  fi
  write_cfg
  say "~/.aws/config 에 [$SESSION_HDR] · [$PROFILE_HDR] 를 설정했어요."
fi

# ── 4. git 전역 설정 적용(CodeCommit 주소에만) ───────────────────────────────
if [ "$GIT_HELPER_OK" -eq 1 ]; then
  say "git 로그인 도우미가 이미 맞아요. (변경 없음)"
else
  # 빈 값 = 이 주소에서 OS 기본 도우미(macOS 키체인 등)를 끈다 → 그 다음 AWS 도우미.
  git config --global --replace-all "${GIT_KEY}.helper" ""
  git config --global --add "${GIT_KEY}.helper" "$HELPER"
  say "git 로그인 도우미를 설정했어요: ${GIT_HOST}"
fi
if [ "$(git config --global --get-all "${GIT_KEY}.useHttpPath" 2>/dev/null || true)" != "true" ]; then
  git config --global --replace-all "${GIT_KEY}.useHttpPath" true
fi

# ── 5. 브라우저 로그인 ───────────────────────────────────────────────────────
if [ "$NO_LOGIN" -eq 1 ]; then
  say "--no-login — 로그인은 건너뛰었어요. 나중에 'aws sso login --profile ${PROFILE_NAME}' 를 실행하세요."
else
  say "브라우저가 열리면 회사 AWS 계정으로 로그인하고 '허용'을 누르세요."
  if aws sso login --profile "$PROFILE_NAME"; then
    say "로그인 완료."
  else
    echo "[setup-aws-git] 로그인하지 못했어요. 설정은 그대로 저장돼 있어요." >&2
    echo "      인터넷 연결을 확인한 뒤 'aws sso login --profile ${PROFILE_NAME}' 를 다시 실행하세요." >&2
    echo "      계속 안 되면 관리자에게 '회사 AWS 로그인 계정과 그룹(AppHub-Developers)'을 확인해 달라고 하세요." >&2
  fi
fi

# ── 6. 확인 방법 ────────────────────────────────────────────────────────────
say "설정 완료. 확인하려면: aws sts get-caller-identity --profile ${PROFILE_NAME}"
say "로그인은 보통 하루에 한 번 만료돼요. 저장소 push/clone 이 403 이나 'Unable to locate credentials' 로"
say "실패하면 'aws sso login --profile ${PROFILE_NAME}' 를 실행한 뒤 다시 시도하세요."
exit 0
