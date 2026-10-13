#!/usr/bin/env pwsh
# AppHub 배포 표준 — git pre-commit 훅 설치기 (Windows / PowerShell 판)
#
# hooks/pre-commit 을 이 프로젝트의 .git/hooks/pre-commit 으로 설치한다.
# 훅 자체는 POSIX sh 스크립트이며, Git for Windows 에 번들된 sh 가 커밋 때 실행한다.
# (그래서 훅은 OS 공통이고, 이 스크립트는 '설치'만 담당한다.)
#
# 사용:
#   powershell -ExecutionPolicy Bypass -File install-hooks.ps1
#   powershell -ExecutionPolicy Bypass -File install-hooks.ps1 -Force   # 확인 없이 교체
#
# 멱등(mac 판 install-hooks.sh 와 동일 동작):
#   - 이미 같은 내용이 설치돼 있으면 아무것도 하지 않고 통과한다.
#   - .git/hooks/pre-commit 이 없으면 설치한다.
#   - 다른 내용의 pre-commit 이 이미 있으면: 물어본 뒤(대화형) 타임스탬프 백업(.bak) 후 교체.
#     비대화형(CI·파이프)에서는 기존 훅을 유지하고 멈춘다. -Force 면 확인 없이 교체.
#   - git 레포가 아니면 친절한 에러로 안내하고 멈춘다.
#
# 의존성 없음: PowerShell 5.1+ 와 git 만 사용.

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'

# 실패 메시지는 stderr 로 보내고 종료한다(mac 판의 'echo >&2; exit 1' 과 대응).
function Fail([string]$message) {
    [Console]::Error.WriteLine($message)
    exit 1
}

if ($Help) {
    Write-Host "사용: powershell -ExecutionPolicy Bypass -File install-hooks.ps1 [-Force]"
    Write-Host "  -Force  다른 내용의 기존 pre-commit 훅을 확인 없이 백업 후 교체합니다(비대화형·CI용)."
    exit 0
}

# 이 스크립트가 있는 디렉토리(번들 루트). 어디서 실행해도 hooks/pre-commit 을 찾도록.
$scriptDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($scriptDir)) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$src = Join-Path (Join-Path $scriptDir 'hooks') 'pre-commit'

if (-not (Test-Path -LiteralPath $src -PathType Leaf)) {
    Fail "오류: 번들의 hooks/pre-commit 을 찾을 수 없어요: $src`n      이 스크립트는 번들 루트(install-hooks.ps1 와 hooks/ 가 함께 있는 곳)에서 실행하세요."
}

# ── git 레포 확인 ─────────────────────────────────────────────────────────────
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Fail "오류: git 이 설치돼 있지 않아요. Git for Windows 를 먼저 설치하세요 (https://git-scm.com)."
}

# git 호출 구간에만 EAP 를 Continue 로 낮춘다. Stop 상태에서 native 명령이 stderr 에
# 쓰면(git 저장소가 아닐 때 'fatal: ...') 일부 PowerShell 버전이 NativeCommandError 를
# 터미널 에러로 던져, 아래 친절한 안내 대신 예외 스택이 노출되는 것을 막기 위함.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$gitDir = (& git rev-parse --git-dir 2>$null)
$gitExit = $LASTEXITCODE
$ErrorActionPreference = $prevEAP
if ($gitExit -ne 0 -or [string]::IsNullOrWhiteSpace($gitDir)) {
    Fail "오류: 여기는 git 저장소가 아니에요.`n      먼저 프로젝트 폴더에서 'git init' 을 실행한 뒤 다시 시도하세요."
}
$gitDir = $gitDir.Trim()

$hookDir = Join-Path $gitDir 'hooks'
$dest = Join-Path $hookDir 'pre-commit'

New-Item -ItemType Directory -Force -Path $hookDir | Out-Null

# 두 파일이 바이트 단위로 같은지 비교(mac 판 'cmp -s' 대응).
function Get-Sha256([string]$path) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
}

# ── 멱등 설치 ─────────────────────────────────────────────────────────────────
if (Test-Path -LiteralPath $dest -PathType Leaf) {
    # 이미 같은 내용이면 통과.
    if ((Get-Sha256 $src) -eq (Get-Sha256 $dest)) {
        Write-Host "[install-hooks] 이미 최신 pre-commit 훅이 설치돼 있어요. (변경 없음)"
        exit 0
    }
    # 다른 내용의 훅이 이미 있다. 함부로 덮지 않고 사용자에게 확인한다.
    # -Force 면 확인을 건너뛴다. 그 외에는 사람에게 물어보되, stdin 이 리다이렉트된
    # 비대화형 환경(CI·파이프)에서는 안전하게 중단한다.
    if (-not $Force) {
        Write-Host "[install-hooks] 이미 다른 내용의 pre-commit 훅이 설치돼 있어요: $dest"
        if (-not [Console]::IsInputRedirected) {
            $answer = Read-Host "기존 훅을 백업(.bak)한 뒤 배포 표준 훅으로 교체할까요? [y/N]"
            if ($answer -notmatch '^\s*(y|Y|yes|YES)\s*$') {
                Write-Host "[install-hooks] 설치를 취소했어요. 기존 훅은 그대로 뒀어요."
                exit 1
            }
        }
        else {
            Fail "      비대화형 환경이라 확인을 받을 수 없어요. 기존 훅을 유지합니다.`n      교체하려면 '-Force' 옵션으로 다시 실행하세요."
        }
    }
    # 백업 후 교체.
    $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = "$dest.$ts.bak"
    Copy-Item -LiteralPath $dest -Destination $backup -Force
    Write-Host "[install-hooks] 기존 pre-commit 훅을 백업했어요: $backup"
}

# 바이트 그대로 복사한다(텍스트 변환 없이 → 훅의 LF 줄바꿈이 보존돼 sh 가 정상 실행).
Copy-Item -LiteralPath $src -Destination $dest -Force
Write-Host "[install-hooks] 배포 표준 pre-commit 훅을 설치했어요: $dest"
Write-Host "[install-hooks] 이제 커밋할 때 Dockerfile/EXPOSE/시크릿을 자동으로 점검해요."
exit 0
