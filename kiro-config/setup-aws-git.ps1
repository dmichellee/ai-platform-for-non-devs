# AppHub — 코드 저장소(CodeCommit) 로그인 설정 (Windows / PowerShell 판, PC당 1회)
#
# mac 판 setup-aws-git.sh 와 동일 동작(몇 번 실행해도 결과가 같다):
#   1. 같은 폴더의 apphub-aws.conf 를 읽는다(회사 AWS 로그인 정보 — 비밀값 없음).
#   2. AWS CLI v2 가 설치돼 있는지 확인한다.
#   3. %USERPROFILE%\.aws\config 에 [sso-session apphub] + [profile apphub] 두 섹션을 추가한다.
#      - 이미 같은 값이면 아무것도 바꾸지 않는다.
#      - 다른 값이 있으면 덮어쓰지 않고 멈춘다(-Force 면 두 섹션만 교체, 원본은 config.bak.시각 으로 백업).
#      - 다른 섹션은 절대 건드리지 않는다.
#   4. git 전역 설정 — CodeCommit 주소(git-codecommit.{리전}.amazonaws.com)에만 AWS 로그인 도우미를 쓴다.
#      (이 주소에서만 Windows 기본 도우미(Git Credential Manager)를 끈다. 다른 git 호스트 설정은 그대로.)
#   5. aws sso login --profile apphub 로 브라우저 로그인(-NoLogin 이면 생략).
#
# 사용:
#   powershell -ExecutionPolicy Bypass -File setup-aws-git.ps1
#   powershell -ExecutionPolicy Bypass -File setup-aws-git.ps1 -NoLogin     # 설정만
#   powershell -ExecutionPolicy Bypass -File setup-aws-git.ps1 -Force       # 다른 값이 있으면 교체
#   powershell -ExecutionPolicy Bypass -File setup-aws-git.ps1 -Uninstall   # 이 스크립트가 넣은 설정만 제거
#
# 의존성: PowerShell 5.1+ + git(Git for Windows) + aws(CLI v2).
# 이 파일은 UTF-8(BOM 포함)로 저장한다 — Windows PowerShell 5.1 이 BOM 없는 파일을 시스템 코드페이지로 읽어
# 한국어 안내가 깨지는 것을 막기 위함.

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$Uninstall,
    [switch]$NoLogin,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'

function Say([string]$message) { Write-Host "[setup-aws-git] $message" }
function Fail([string]$message) {
    [Console]::Error.WriteLine("[setup-aws-git] 오류: $message")
    exit 1
}

if ($Help) {
    Write-Host "사용: powershell -ExecutionPolicy Bypass -File setup-aws-git.ps1 [-NoLogin] [-Force] [-Uninstall]"
    Write-Host "  -NoLogin    설정만 하고 브라우저 로그인(aws sso login)은 건너뜁니다."
    Write-Host "  -Force      이미 다른 값의 apphub 설정이 있어도 확인 없이 교체합니다(원본은 백업)."
    Write-Host "  -Uninstall  이 스크립트가 넣은 설정(.aws\config 의 apphub 두 섹션, git CodeCommit 설정)만 제거합니다."
    exit 0
}

# ── 1. 설정 파일 읽기 ────────────────────────────────────────────────────────
$scriptDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($scriptDir)) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$confPath = Join-Path $scriptDir 'apphub-aws.conf'
if (-not (Test-Path -LiteralPath $confPath -PathType Leaf)) {
    Fail ("설정 파일을 찾을 수 없어요: $confPath`n" +
          "      이 스크립트는 Kiro 설정 zip 을 푼 폴더(apphub-aws.conf 와 함께 있는 곳)에서 실행하세요.`n" +
          "      zip 에 apphub-aws.conf 가 없다면, 이 회사 AppHub 는 코드 저장소 로그인 설정을 쓰지 않아요. 관리자에게 문의하세요.")
}

# KEY=VALUE 만 읽는다(스크립트로 실행하지 않음). 주석(#)·빈 줄 무시.
$conf = @{}
foreach ($raw in [System.IO.File]::ReadAllLines($confPath, [System.Text.Encoding]::UTF8)) {
    $line = $raw.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) { continue }
    $i = $line.IndexOf('=')
    if ($i -lt 1) { continue }
    $k = $line.Substring(0, $i).Trim()
    if (-not $conf.ContainsKey($k)) { $conf[$k] = $line.Substring($i + 1).Trim() }
}
foreach ($k in @('SSO_START_URL', 'SSO_REGION', 'ACCOUNT_ID', 'PERMISSION_SET', 'CODECOMMIT_REGION')) {
    if (-not $conf.ContainsKey($k) -or [string]::IsNullOrEmpty($conf[$k])) {
        Fail "apphub-aws.conf 에 $k 값이 없어요. 관리자에게 새 Kiro 설정 zip 을 요청하세요."
    }
}
$profileName = 'apphub'
if ($conf.ContainsKey('PROFILE_NAME') -and $conf['PROFILE_NAME'] -ne '') { $profileName = $conf['PROFILE_NAME'] }
if ($profileName -notmatch '^[A-Za-z0-9_-]+$') {
    Fail "apphub-aws.conf 의 PROFILE_NAME 에는 영문·숫자·-·_ 만 쓸 수 있어요: $profileName"
}

$sessionHdr = "sso-session $profileName"
$profileHdr = "profile $profileName"
$gitHost = "https://git-codecommit.$($conf['CODECOMMIT_REGION']).amazonaws.com"
$gitKey = "credential.$gitHost"
$helper = "!aws codecommit credential-helper --profile $profileName " + '$@'

$desiredSession = @(
    "sso_start_url = $($conf['SSO_START_URL'])",
    "sso_region = $($conf['SSO_REGION'])",
    'sso_registration_scopes = sso:account:access'
)
$desiredProfile = @(
    "sso_session = $profileName",
    "sso_account_id = $($conf['ACCOUNT_ID'])",
    "sso_role_name = $($conf['PERMISSION_SET'])",
    "region = $($conf['CODECOMMIT_REGION'])"
)

$homeDir = $env:USERPROFILE
if ([string]::IsNullOrEmpty($homeDir)) { $homeDir = $HOME }
if (-not [string]::IsNullOrEmpty($env:AWS_CONFIG_FILE)) { $awsCfg = $env:AWS_CONFIG_FILE }
else { $awsCfg = Join-Path (Join-Path $homeDir '.aws') 'config' }

# ── .aws\config 섹션 도구 ───────────────────────────────────────────────────
function Read-CfgLines {
    if (-not (Test-Path -LiteralPath $awsCfg -PathType Leaf)) { return ,@() }
    $text = [System.IO.File]::ReadAllText($awsCfg)   # BOM 이 있으면 자동 처리
    if ($text -eq '') { return ,@() }
    $lines = $text -split "`r?`n"
    if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') { $lines = $lines[0..($lines.Count - 2)] }
    return ,@($lines)
}
function Get-NewLine {
    if (Test-Path -LiteralPath $awsCfg -PathType Leaf) {
        if ([System.IO.File]::ReadAllText($awsCfg).Contains("`r`n")) { return "`r`n" }
    }
    return "`n"
}
# 섹션 머리 정규화: "[ profile   apphub ]" == "profile apphub". 머리가 아니면 $null.
function Get-HeaderName([string]$line) {
    $s = $line.Trim()
    if ($s.Length -lt 2 -or -not $s.StartsWith('[') -or -not $s.EndsWith(']')) { return $null }
    return (($s.Substring(1, $s.Length - 2).Trim()) -replace '\s+', ' ')
}
# 섹션의 "key = value" 줄 목록. 섹션이 없으면 $null.
function Get-SectionBody($lines, [string]$want) {
    $found = $false; $in = $false; $body = New-Object System.Collections.Generic.List[string]
    foreach ($line in $lines) {
        $h = Get-HeaderName $line
        if ($null -ne $h) { $in = ($h -eq $want); if ($in) { $found = $true }; continue }
        if (-not $in) { continue }
        $t = $line.Trim()
        if ($t -eq '' -or $t.StartsWith('#') -or $t.StartsWith(';')) { continue }
        $i = $t.IndexOf('=')
        if ($i -lt 0) { continue }
        $body.Add(($t.Substring(0, $i).Trim() + ' = ' + $t.Substring($i + 1).Trim()))
    }
    if (-not $found) { return $null }
    return ,$body.ToArray()
}
# absent | same | conflict — same = 원하는 key 가 전부 같은 값(사용자가 덧붙인 다른 key 는 허용·보존).
function Get-SectionState($lines, [string]$hdr, [string[]]$desired) {
    $body = Get-SectionBody $lines $hdr
    if ($null -eq $body) { return 'absent' }
    foreach ($want in $desired) {
        $k = $want.Substring(0, $want.IndexOf(' = '))
        $got = $body | Where-Object { $_.StartsWith("$k = ") } | Select-Object -First 1
        if ($got -ne $want) { return 'conflict' }
    }
    return 'same'
}
# 두 apphub 섹션을 같은 자리에서 교체(또는 제거). 다른 섹션의 내용·순서는 그대로.
function Build-NewLines($lines, [bool]$remove) {
    $out = New-Object System.Collections.Generic.List[string]
    $script:sDone = $false; $script:pDone = $false; $skip = $false
    $emit = {
        param($hdr, $body)
        if ($remove) { return }
        if ($out.Count -gt 0 -and $out[$out.Count - 1] -ne '') { $out.Add('') }
        $out.Add("[$hdr]"); foreach ($b in $body) { $out.Add($b) }; $out.Add('')
    }
    foreach ($line in $lines) {
        $h = Get-HeaderName $line
        if ($null -ne $h) {
            $skip = $false
            if ($h -eq $sessionHdr) { $skip = $true; if (-not $script:sDone) { & $emit $sessionHdr $desiredSession; $script:sDone = $true }; continue }
            if ($h -eq $profileHdr) { $skip = $true; if (-not $script:pDone) { & $emit $profileHdr $desiredProfile; $script:pDone = $true }; continue }
        }
        if ($skip) { continue }
        $out.Add($line)
    }
    if (-not $script:sDone) { & $emit $sessionHdr $desiredSession }
    if (-not $script:pDone) { & $emit $profileHdr $desiredProfile }
    return ,$out.ToArray()
}
function Backup-Cfg {
    if (-not (Test-Path -LiteralPath $awsCfg -PathType Leaf)) { return }
    $bak = "$awsCfg.bak.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item -LiteralPath $awsCfg -Destination $bak -Force
    Say "기존 설정을 백업했어요: $bak"
}
function Write-Cfg([bool]$remove) {
    $nl = Get-NewLine
    $newLines = Build-NewLines (Read-CfgLines) $remove
    $dir = Split-Path -Parent $awsCfg
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $text = ''
    if ($newLines.Count -gt 0) { $text = ($newLines -join $nl) + $nl }
    # UTF-8(BOM 없음)으로 쓴다 — AWS CLI 가 BOM 을 섹션 이름 일부로 읽는 문제 방지.
    [System.IO.File]::WriteAllText($awsCfg, $text, (New-Object System.Text.UTF8Encoding $false))
}

# ── git 호출(빈 문자열 인자를 확실히 넘기기 위해 직접 프로세스 실행) ───────────
# Windows PowerShell 5.1 은 native 명령에 '' 인자를 넘기면 빠뜨린다. helper 빈 값 설정에 필요하므로
# 인자 문자열을 직접 만들어 넘긴다.
$gitCmd = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $gitCmd) { Fail "git 이 설치돼 있지 않아요. Git for Windows 를 먼저 설치하세요 (https://git-scm.com)." }
$gitExe = $gitCmd.Path
if ([string]::IsNullOrEmpty($gitExe)) { $gitExe = $gitCmd.Source }

function ConvertTo-ArgString([string]$a) {
    if ($a -eq '') { return '""' }
    if ($a -notmatch '[\s"]') { return $a }
    $e = $a -replace '(\\*)"', '$1$1\"'
    $e = $e -replace '(\\+)$', '$1$1'
    return '"' + $e + '"'
}
function Invoke-Git([string[]]$GitArgs) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $gitExe
    $psi.Arguments = (($GitArgs | ForEach-Object { ConvertTo-ArgString $_ }) -join ' ')
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $out = $p.StandardOutput.ReadToEnd()
    $null = $p.StandardError.ReadToEnd()
    $p.WaitForExit()
    return [pscustomobject]@{ ExitCode = $p.ExitCode; Out = $out }
}
function Invoke-GitChecked([string[]]$GitArgs) {
    $r = Invoke-Git $GitArgs
    if ($r.ExitCode -ne 0) { Fail "git 설정을 바꾸지 못했어요: git $($GitArgs -join ' ')" }
}
# 이 주소의 helper 값 목록(줄 단위, 빈 값 포함).
function Get-GitHelpers {
    $r = Invoke-Git @('config', '--global', '--get-all', "$gitKey.helper")
    if ($r.ExitCode -ne 0) { return ,@() }
    $lines = $r.Out -split "`r?`n"
    if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') { $lines = $lines[0..($lines.Count - 2)] }
    return ,@($lines)
}
function Get-GitKeysUnderHost {
    $r = Invoke-Git @('config', '--global', '--get-regexp', '^credential\.')
    if ($r.ExitCode -ne 0) { return ,@() }
    $prefix = "credential.$gitHost.".ToLowerInvariant()
    return ,@($r.Out -split "`r?`n" | Where-Object { $_ -ne '' -and $_.Split(' ')[0].ToLowerInvariant().StartsWith($prefix) })
}

# ── 제거 모드 ───────────────────────────────────────────────────────────────
if ($Uninstall) {
    $lines = Read-CfgLines
    if (($null -ne (Get-SectionBody $lines $sessionHdr)) -or ($null -ne (Get-SectionBody $lines $profileHdr))) {
        Backup-Cfg
        Write-Cfg $true
        Say ".aws\config 에서 [$sessionHdr] · [$profileHdr] 를 제거했어요."
    }
    else { Say ".aws\config 에 apphub 설정이 없어요. (변경 없음)" }
    if ((Get-GitKeysUnderHost).Count -gt 0) {
        $null = Invoke-Git @('config', '--global', '--unset-all', "$gitKey.helper")
        $null = Invoke-Git @('config', '--global', '--unset-all', "$gitKey.useHttpPath")
        if ((Get-GitKeysUnderHost).Count -eq 0) { $null = Invoke-Git @('config', '--global', '--remove-section', $gitKey) }
        Say "git 전역 설정에서 $gitHost 로그인 도우미 설정을 제거했어요."
    }
    else { Say "git 전역 설정에 CodeCommit 로그인 설정이 없어요. (변경 없음)" }
    Say "제거 완료. 다른 AWS·git 설정은 그대로예요."
    exit 0
}

# ── 2. AWS CLI v2 확인 ──────────────────────────────────────────────────────
$awsInstallUrl = 'https://docs.aws.amazon.com/ko_kr/cli/latest/userguide/getting-started-install.html'
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
    Fail ("AWS CLI 가 설치돼 있지 않아요. 아래 안내대로 'AWS CLI 버전 2' 를 설치한 뒤 PowerShell 창을 새로 열고 다시 실행하세요.`n" +
          "      $awsInstallUrl`n" +
          "      (Windows: 안내 페이지의 'AWSCLIV2.msi' 를 내려받아 설치. 회사 PC 는 관리자 권한이 필요할 수 있어요.)")
}
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
# PS 5.1 은 네이티브 stderr 를 ErrorRecord 로 감싸므로 문자열로 풀어 내부 오류 문구가 섞이지 않게 한다.
$awsVer = ((& aws --version 2>&1) | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { $_.ToString() } } | Where-Object { $_ -and $_.Trim() } | Out-String).Trim()
$ErrorActionPreference = $prevEAP
# AWS CLI v2 는 --version 에서도 ~/.aws/config 를 읽는다 — 파일 문제를 "v2 필요"로 오안내하지 않는다.
if ($awsVer -match 'Unable to parse config file') {
    Fail ("AWS 설정 파일(.aws\config)을 읽을 수 없어요. 파일 내용(문법 오류)이나 저장 형식(UTF-8 BOM)을 확인하세요.`n" +
          "      메모장으로 열어 '다른 이름으로 저장' → 인코딩 'UTF-8'(BOM 없음)으로 저장하면 대개 해결돼요.`n      ($awsVer)")
}
if ($awsVer -notmatch '^aws-cli/2\.') {
    Fail "AWS CLI 버전 2 가 필요해요(현재: $awsVer).`n      아래 안내대로 버전 2 를 설치한 뒤 다시 실행하세요: $awsInstallUrl"
}
# sso-session 설정은 AWS CLI 2.9 이상에서 지원된다(그 전 2.x 는 로그인 단계에서 실패).
if ($awsVer -match '^aws-cli/2\.(\d+)\.' -and [int]$Matches[1] -lt 9) {
    Fail "AWS CLI 가 오래됐어요(현재: $(($awsVer -split ' ')[0])). 2.9 이상으로 업데이트한 뒤 다시 실행하세요.`n      $awsInstallUrl"
}
Say "AWS CLI 확인: $(($awsVer -split ' ')[0])"

# ── 3·4. 먼저 전부 점검(아무것도 바꾸기 전에) ─────────────────────────────────
$lines = Read-CfgLines
$sState = Get-SectionState $lines $sessionHdr $desiredSession
$pState = Get-SectionState $lines $profileHdr $desiredProfile

if (($sState -eq 'conflict' -or $pState -eq 'conflict') -and -not $Force) {
    [Console]::Error.WriteLine("[setup-aws-git] .aws\config 에 이미 다른 값의 apphub 설정이 있어요. 덮어쓰지 않고 멈춥니다.")
    foreach ($hdr in @($sessionHdr, $profileHdr)) {
        $body = Get-SectionBody $lines $hdr
        if ($null -ne $body) {
            [Console]::Error.WriteLine("      현재 [$hdr]:")
            foreach ($b in $body) { [Console]::Error.WriteLine("        $b") }
        }
    }
    [Console]::Error.WriteLine("      바뀔 값:")
    [Console]::Error.WriteLine("        [$sessionHdr]"); foreach ($b in $desiredSession) { [Console]::Error.WriteLine("          $b") }
    [Console]::Error.WriteLine("        [$profileHdr]"); foreach ($b in $desiredProfile) { [Console]::Error.WriteLine("          $b") }
    [Console]::Error.WriteLine("      이 값으로 바꾸려면 -Force 를 붙여 다시 실행하세요(원본은 백업돼요).")
    exit 1
}

$currentHelpers = Get-GitHelpers
$gitHelperOk = ($currentHelpers.Count -eq 2 -and $currentHelpers[0] -eq '' -and $currentHelpers[1] -eq $helper)
if (-not $gitHelperOk) {
    $others = @($currentHelpers | Where-Object { $_ -ne '' })
    if ($others.Count -gt 0) {
        Say "$gitHost 에 이미 다른 git 로그인 도우미가 설정돼 있어요:"
        foreach ($o in $others) { Write-Host "        $o" }
        Say "이 주소에서만 AWS 로그인 도우미로 바꿉니다(다른 git 호스트 설정은 그대로)."
        if (-not $Force) {
            if ([Console]::IsInputRedirected) {
                Fail "비대화형 환경이라 확인을 받을 수 없어요. 바꾸려면 -Force 를 붙여 다시 실행하세요."
            }
            $answer = Read-Host "바꿀까요? [y/N]"
            if ($answer -notmatch '^\s*(y|Y|yes|YES)\s*$') {
                Say "취소했어요. 아무것도 바꾸지 않았어요."
                exit 1
            }
        }
    }
}

# ── 3. .aws\config 적용 ─────────────────────────────────────────────────────
if ($sState -eq 'same' -and $pState -eq 'same') {
    Say ".aws\config 의 apphub 설정이 이미 맞아요. (변경 없음)"
}
else {
    if ($sState -eq 'conflict' -or $pState -eq 'conflict') { Backup-Cfg }
    Write-Cfg $false
    Say ".aws\config 에 [$sessionHdr] · [$profileHdr] 를 설정했어요."
}

# ── 4. git 전역 설정 적용(CodeCommit 주소에만) ───────────────────────────────
if ($gitHelperOk) {
    Say "git 로그인 도우미가 이미 맞아요. (변경 없음)"
}
else {
    # 빈 값 = 이 주소에서 Windows 기본 도우미(Git Credential Manager)를 끈다 → 그 다음 AWS 도우미.
    Invoke-GitChecked @('config', '--global', '--replace-all', "$gitKey.helper", '')
    Invoke-GitChecked @('config', '--global', '--add', "$gitKey.helper", $helper)
    Say "git 로그인 도우미를 설정했어요: $gitHost"
}
$r = Invoke-Git @('config', '--global', '--get-all', "$gitKey.useHttpPath")
if ($r.Out.Trim() -ne 'true') {
    Invoke-GitChecked @('config', '--global', '--replace-all', "$gitKey.useHttpPath", 'true')
}

# ── 5. 브라우저 로그인 ───────────────────────────────────────────────────────
if ($NoLogin) {
    Say "-NoLogin — 로그인은 건너뛰었어요. 나중에 'aws sso login --profile $profileName' 를 실행하세요."
}
else {
    Say "브라우저가 열리면 회사 AWS 계정으로 로그인하고 '허용'을 누르세요."
    $ErrorActionPreference = 'Continue'
    & aws sso login --profile $profileName
    $loginExit = $LASTEXITCODE
    $ErrorActionPreference = $prevEAP
    if ($loginExit -eq 0) { Say "로그인 완료." }
    else {
        [Console]::Error.WriteLine("[setup-aws-git] 로그인하지 못했어요. 설정은 그대로 저장돼 있어요.")
        [Console]::Error.WriteLine("      인터넷 연결을 확인한 뒤 'aws sso login --profile $profileName' 를 다시 실행하세요.")
        [Console]::Error.WriteLine("      계속 안 되면 관리자에게 '회사 AWS 로그인 계정과 그룹(AppHub-Developers)'을 확인해 달라고 하세요.")
    }
}

# ── 6. 확인 방법 ────────────────────────────────────────────────────────────
Say "설정 완료. 확인하려면: aws sts get-caller-identity --profile $profileName"
Say "로그인은 보통 하루에 한 번 만료돼요. 저장소 push/clone 이 403 이나 'Unable to locate credentials' 로"
Say "실패하면 'aws sso login --profile $profileName' 를 실행한 뒤 다시 시도하세요."
exit 0
