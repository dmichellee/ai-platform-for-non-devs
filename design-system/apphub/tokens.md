# AppHub 색상 토큰 (라이트/다크 토글)

> 사용자 제공 팔레트(Material Design 계열). **다크 모드가 기본(default)**, 라이트 토글 지원.
> 구현: CSS 커스텀 프로퍼티 + `data-theme="light|dark"` 속성 토글. 프론트엔드는 이 토큰만 참조하고 raw hex 직접 사용 금지.

## 원본 팔레트 (사용자 제공)

| Role | Light | Dark (기본) |
|------|-------|-------------|
| Primary | `#6200EE` (500) | `#BB86FC` (200) |
| Primary Variant | `#3700B3` (700) | `#3700B3` (700) |
| Secondary | `#03DAC6` (200) | `#03DAC6` (200) |
| Secondary Variant | `#018786` (900) | `#03DAC6` (200) |
| Background | `#FFFFFF` | `#121212` |
| Surface | `#FFFFFF` | `#121212` |
| Error | `#B00020` | `#CF6679` |
| On Primary | `#FFFFFF` | `#000000` |
| On Secondary | `#000000` | `#000000` |
| On Background | `#000000` | `#FFFFFF` |
| On Surface | `#000000` | `#FFFFFF` |
| On Error | `#FFFFFF` | `#000000` |

## 파생 토큰 (가독성·계층용 — 원본에 없어 접근성 기준으로 보강)

Material 팔레트는 surface=background로 동일해 카드/구분이 약하므로, elevation·border·muted 파생값을 추가한다. WCAG 4.5:1 충족 확인.

| 파생 Role | Light | Dark | 용도 |
|-----------|-------|------|------|
| Surface Elevated (카드) | `#FFFFFF` | `#1E1E1E` | 배경 위 카드 (다크는 elevation overlay 적용) |
| Surface Hover | `#F5F3FF` | `#2A2A2A` | 호버/선택 배경 |
| Border | `#E2E0EC` | `#2E2E2E` | 구분선·카드 테두리 |
| Border Strong | `#C9C6D6` | `#3D3D3D` | 강조 테두리·입력 필드 |
| On Surface Muted | `#5F5B6B` | `#A0A0A0` | 보조 텍스트 (secondary, ≥3:1) |
| On Surface Subtle | `#8B879A` | `#6E6E6E` | 캡션·플레이스홀더 |
| Primary Soft (배경) | `rgba(98,0,238,0.08)` | `rgba(187,134,252,0.14)` | 액센트 배경(배지·선택 칩) |
| Error Soft (배경) | `rgba(176,0,32,0.08)` | `rgba(207,102,121,0.14)` | 위험 배경 |
| Success | `#018786` | `#03DAC6` | 성공 상태(= secondary 계열 재사용) |
| Scrim (모달 오버레이) | `rgba(0,0,0,0.5)` | `rgba(0,0,0,0.6)` | 모달 뒤 배경 |

## 상태 색 매핑 (runtimeState / status)

| 상태 | 색 토큰 | 표기 |
|------|---------|------|
| 실행 중 (RUNNING) | Success | 초록 계열 점+텍스트 |
| 잠자는 중 (SLEEPING) | On Surface Muted | 회색 |
| 깨우는 중 (WAKING) | Primary | 보라, 펄스 애니메이션 |
| 배포 실패 (FAILED) | Error | 빨강 |

## 타이포 / 기타

- 폰트: **Plus Jakarta Sans** (제목/본문), **JetBrains Mono** (URL·기술값·로그)
- radius: 사용자 화면 18~24px(부드러움) / 관리자 화면 8px(엄격)
- spacing: 4·8·12·16·24·32·48 (density 6/10)
- 다크가 default. 첫 방문 시 `prefers-color-scheme` 존중하되, 토글 선택은 localStorage에 저장.

## 아이콘 정책

- **이모지 절대 사용 금지 (프론트엔드 전 범위).** 모든 아이콘은 SVG.
- 아이콘 세트: **Lucide** (`lucide-react`) — 스트로크 1.5~2px, 라운드. 단일 세트로 통일.
- 앱 카드의 앱별 아이콘은 사용자가 이모지 대신 Lucide 아이콘 중 선택하거나, 앱 유형별 기본 아이콘 자동 배정.
