# sample-no-health — HEALTHCHECK_FAILED 검증

Dockerfile과 빌드는 정상이지만, 앱이 **`GET /health`를 구현하지 않았다**(C3 위반).
`/health`는 의도적으로 404를 반환한다.

## 무엇을 검증하는가
정적 검증·빌드를 통과한 뒤 buildspec의 스모크 단계(이미지 실행 → 60초 내 `GET /health` 200)에서
무응답/비200을 잡아 `HEALTHCHECK_FAILED`로 분류하는지.

## 기대 결과
| 단계 | 기대 |
|---|---|
| Dockerfile 검증 | `ok: true` (정적 검증 통과) |
| docker build | 성공 |
| 스모크 /health | 실패 (404, 60초 내 200 없음) |
| Deployment.failureCategory | `HEALTHCHECK_FAILED` |
| Deployment.status | `FAILED` |

## 사용자 안내 문구(프론트 매핑)
> "앱이 시작됐지만 상태 확인(/health)에 응답하지 않아요. Kiro에게 '/health 경로에 200 응답을 추가해줘'라고 요청하세요."

## 검증기로는 잡히지 않음
`/health` 유무는 **정적 파싱으로 알 수 없다**(실행해봐야 안다). 검증기는 `ok: true`를 반환하고,
HEALTHCHECK_FAILED는 buildspec의 스모크 단계(30회×2초=60초 상한)가 결정한다.
