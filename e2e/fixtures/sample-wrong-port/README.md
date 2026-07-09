# sample-wrong-port — DOCKERFILE_INVALID (포트 불일치) 검증

앱이 **3000 포트**에서 리슨하고 Dockerfile도 `EXPOSE 3000`이다. 컨테이너 계약 C2(8080)를 위반한다.

## 무엇을 검증하는가
Dockerfile 정적 검증(C2 `EXPOSE 8080`)에서 포트 불일치를 잡아 `DOCKERFILE_INVALID`를 반환하는지.
빌드/스모크까지 가기 전에 정적 단계에서 중단돼야 한다.

## 기대 결과
| 항목 | 기대 |
|---|---|
| 검증기 failureCategory | `DOCKERFILE_INVALID` |
| 검증기 exposedPorts | `[3000]` (8080 미포함) |
| Deployment.status | `FAILED` |
| Deployment.failureCategory | `DOCKERFILE_INVALID` |

## 사용자 안내 문구(프론트 매핑)
> "앱 설정이 배포 표준과 달라요. Kiro에게 '배포 표준(8080 포트, /health 응답)에 맞춰줘'라고 요청하세요."

## 주의
결함은 오직 포트(3000)다. 베이스 이미지·USER·구조는 정상이라 실패 원인이 격리된다.
