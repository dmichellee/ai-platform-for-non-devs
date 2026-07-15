#!/bin/sh
# AppHub 배포 표준 — git pre-commit 훅 설치기 (Kiro 배포 표준 번들)
#
# hooks/pre-commit 을 이 프로젝트의 .git/hooks/pre-commit 으로 설치하고 실행 권한을 준다.
#
# 사용:  sh install-hooks.sh
#
# 멱등:
#   - 이미 같은 내용이 설치돼 있으면 아무것도 하지 않고 통과한다.
#   - .git/hooks/pre-commit 이 없으면 설치한다.
#   - 다른 내용의 pre-commit 이 이미 있으면 타임스탬프 백업(.bak)을 만든 뒤 교체한다.
#   - git 레포가 아니면 친절한 에러로 안내하고 멈춘다.
#
# 의존성 없음: POSIX sh + git + cp/chmod 만 사용.

set -eu

# ── 옵션 파싱 ─────────────────────────────────────────────────────────────────
# --force / -f : 다른 내용의 기존 훅이 있어도 확인 없이 백업 후 교체(CI·자동화용).
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=1 ;;
    -h|--help)
      echo "사용: sh install-hooks.sh [--force]"
      echo "  --force, -f  다른 내용의 기존 pre-commit 훅을 확인 없이 백업 후 교체합니다(비대화형·CI용)."
      exit 0
      ;;
    *)
      echo "오류: 알 수 없는 옵션이에요: $arg" >&2
      echo "      사용법은 'sh install-hooks.sh --help' 를 참고하세요." >&2
      exit 1
      ;;
  esac
done

# 이 스크립트가 있는 디렉토리(번들 루트). 어디서 실행해도 hooks/pre-commit 을 찾도록.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SRC="$SCRIPT_DIR/hooks/pre-commit"

if [ ! -f "$SRC" ]; then
  echo "오류: 번들의 hooks/pre-commit 을 찾을 수 없어요: $SRC" >&2
  echo "      이 스크립트는 번들 루트(install-hooks.sh 와 hooks/ 가 함께 있는 곳)에서 실행하세요." >&2
  exit 1
fi

# ── git 레포 확인 ─────────────────────────────────────────────────────────────
if ! command -v git >/dev/null 2>&1; then
  echo "오류: git 이 설치돼 있지 않아요. git 을 먼저 설치하세요." >&2
  exit 1
fi

GIT_DIR=$(git rev-parse --git-dir 2>/dev/null || true)
if [ -z "$GIT_DIR" ]; then
  echo "오류: 여기는 git 저장소가 아니에요." >&2
  echo "      먼저 프로젝트 폴더에서 'git init' 을 실행한 뒤 다시 시도하세요." >&2
  exit 1
fi

HOOK_DIR="$GIT_DIR/hooks"
DEST="$HOOK_DIR/pre-commit"

mkdir -p "$HOOK_DIR"

# ── 멱등 설치 ─────────────────────────────────────────────────────────────────
if [ -f "$DEST" ]; then
  # 이미 같은 내용이면 통과.
  if cmp -s "$SRC" "$DEST"; then
    chmod +x "$DEST" 2>/dev/null || true
    echo "[install-hooks] 이미 최신 pre-commit 훅이 설치돼 있어요. (변경 없음)"
    exit 0
  fi
  # 다른 내용의 훅이 이미 있다. 함부로 덮지 않고 사용자에게 확인한다.
  # --force 면 확인을 건너뛴다. 그 외에는 사람에게 물어보되, 물어볼 터미널이
  # 없으면(CI·파이프 등) 안전하게 중단한다.
  if [ "$FORCE" -ne 1 ]; then
    echo "[install-hooks] 이미 다른 내용의 pre-commit 훅이 설치돼 있어요: $DEST" >&2
    # 권한 비트가 아니라 '실제로 열리는지'로 터미널 유무를 판정한다.
    # (macOS 등에서 /dev/tty 는 항상 존재하지만 CI·파이프에선 열리지 않는다.)
    if { true </dev/tty; } 2>/dev/null && { true >/dev/tty; } 2>/dev/null; then
      printf '기존 훅을 백업(.bak)한 뒤 배포 표준 훅으로 교체할까요? [y/N] ' > /dev/tty
      read -r ANSWER < /dev/tty || ANSWER=""
      case "$ANSWER" in
        y|Y|yes|YES) : ;;  # 진행
        *)
          echo "[install-hooks] 설치를 취소했어요. 기존 훅은 그대로 뒀어요." >&2
          exit 1
          ;;
      esac
    else
      echo "      비대화형 환경이라 확인을 받을 수 없어요. 기존 훅을 유지합니다." >&2
      echo "      교체하려면 '--force' 옵션으로 다시 실행하세요." >&2
      exit 1
    fi
  fi
  # 백업 후 교체.
  TS=$(date +%Y%m%d-%H%M%S 2>/dev/null || echo backup)
  BACKUP="$DEST.$TS.bak"
  cp -p "$DEST" "$BACKUP"
  echo "[install-hooks] 기존 pre-commit 훅을 백업했어요: $BACKUP"
fi

cp "$SRC" "$DEST"
chmod +x "$DEST"
echo "[install-hooks] 배포 표준 pre-commit 훅을 설치했어요: $DEST"
echo "[install-hooks] 이제 커밋할 때 Dockerfile/EXPOSE/시크릿을 자동으로 점검해요."
exit 0
