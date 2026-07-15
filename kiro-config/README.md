# Kiro 설정 번들 (배포 표준 자동 준수) — 소스

이 폴더는 사용자에게 배포되는 "Kiro 설정 번들"의 **소스**다. 빌드하면 OS별 zip 2개가 나온다:

| 다운로드 | 담기는 설치기 | 사용자 안내(zip 안 README.md) |
|----------|----------------|-------------------------------|
| `kiro-config-mac.zip`     | `install-hooks.sh`  | `README-mac.md`     |
| `kiro-config-windows.zip` | `install-hooks.ps1` | `README-windows.md` |

**공통 파일**(두 zip에 모두 들어감): `.kiro/steering/deployment-standard.md`, `hooks/pre-commit`.
훅(`hooks/pre-commit`)은 POSIX sh 스크립트이며 git이 실행한다 — mac/linux는 시스템 sh,
Windows는 Git for Windows에 번들된 sh가 실행하므로 **OS 무관하게 동일한 검사**가 돈다.
그래서 OS별로 다른 건 **설치기와 안내 문구뿐**이다.

## 소스 구성
```
kiro-config/
├── .kiro/steering/deployment-standard.md   # (공통) 배포 표준 지침 (inclusion: always)
├── hooks/pre-commit                        # (공통) 커밋 직전 배포 표준 검사 (POSIX sh)
├── install-hooks.sh                        # (mac) 훅 설치기
├── install-hooks.ps1                       # (windows) 훅 설치기 (PowerShell)
├── README-mac.md                           # (mac) 사용자 안내 → zip 안에서 README.md
├── README-windows.md                       # (windows) 사용자 안내 → zip 안에서 README.md
└── README.md                               # (이 파일) 소스 설명, zip에는 포함되지 않음
```

## 빌드 / 서빙
- 빌드: `scripts/build-kiro-bundle.sh` — OS별 zip 2개를 `kiro-config/dist/` 에 생성한다.
- 업로드: `--upload --stage <dev|prod>` — 플랫폼 자산 버킷의 고정 키에 각각 올린다.
  - `s3://{assets}/kiro-config/kiro-config-mac.zip`
  - `s3://{assets}/kiro-config/kiro-config-windows.zip`
- 서빙 계약: `_workspace/contracts/api-contract.md` 의 "Kiro 설정 다운로드" 참조.
  프론트는 OS별 다운로드 버튼("Mac"/"Windows")으로 두 키를 제공한다.

## 검사 내용 / 신뢰 경계
검사 항목과 "훅은 보조 수단, 최종 강제는 플랫폼" 원칙은 각 OS README에 동일하게 정리돼 있다.
사용자용 상세 안내는 `README-mac.md` / `README-windows.md` 를 본다.
