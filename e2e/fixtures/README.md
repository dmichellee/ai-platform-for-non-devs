# 골든 샘플 픽스처 (TEST-STRATEGY L4)

라이브 E2E(`e2e/run-e2e.sh`)가 dev 스테이지의 소스 리포로 push해서 사용하는 최소 샘플 앱들.
각 픽스처는 **실제로 빌드되는 최소 코드**이거나, **의도적 결함**으로 특정 실패 유형을 재현한다.
조직 식별정보는 포함하지 않는다.

## 픽스처 목록

| 픽스처 | 결함/목적 | 검증기 정적결과 | 최종 기대 failureCategory | 어느 단계에서 잡히나 |
|---|---|---|---|---|
| `sample-ok` | 표준 완전 준수 | `ok: true` | (없음, SUCCEEDED) | — (성공 경로) |
| `sample-streaming` | SSE 스트리밍(표준 준수) | `ok: true` | (없음, SUCCEEDED) | — (스트리밍 검증) |
| `sample-no-dockerfile` | Dockerfile 없음 | `DOCKERFILE_MISSING` | `DOCKERFILE_MISSING` | 정적 검증 (C1) |
| `sample-wrong-port` | EXPOSE 3000 / 3000 리슨 | `DOCKERFILE_INVALID` | `DOCKERFILE_INVALID` | 정적 검증 (C2) |
| `sample-build-error` | 설치 불가 의존성 | `ok: true` | `BUILD_FAILED` | `docker build` 단계 |
| `sample-no-health` | `/health` 미구현(404) | `ok: true` | `HEALTHCHECK_FAILED` | 스모크 단계 |

> "검증기 정적결과"는 `backend/dist/dockerfile-validator.mjs`를 각 픽스처 Dockerfile에 돌린 결과다.
> `sample-build-error`/`sample-no-health`는 **정적 검증을 통과**하며, 실패는 buildspec의 실동작
> 단계(`docker build` / 스모크 `GET /health`)에서 결정된다 — KIRO-STANDARDS 3장 "정적은 검증기,
> 실동작은 이미지 실행". 이 분리가 곧 신뢰 경계다.

## 공통 규약
- 모든 정상 픽스처: 포트 환경변수 `PORT`(기본 8080), `GET /health` 200, non-root(`USER node`),
  베이스 이미지 `public.ecr.aws/docker/library/node:22-slim`, 의존성 0(빌드 빠름).
- 실패 픽스처는 실패 원인을 하나로 격리한다(다른 항목은 정상). 실패 분류를 명확히 검증하기 위함.

## 검증기로 다시 확인하는 법 (로컬, AWS 불필요)
```bash
ALLOWED='["public.ecr.aws/docker/library/node:22-slim","public.ecr.aws/docker/library/python:3.12-slim"]'
printf '%s' "$ALLOWED" | node ../../backend/dist/dockerfile-validator.mjs sample-ok/Dockerfile --allowed-base-images-json -
# -> {"ok":true,...,"exposedPorts":[8080]}
printf '%s' "$ALLOWED" | node ../../backend/dist/dockerfile-validator.mjs sample-wrong-port/Dockerfile --allowed-base-images-json -
# -> {"ok":false,"failureCategory":"DOCKERFILE_INVALID","exposedPorts":[3000],...}  (exit 1)
```
> 허용 베이스 이미지 목록은 관리자 설정(AdminSettings.allowedBaseImages)에서 온다.
> 위 예시 목록은 KIRO-STANDARDS 1장 C6의 예시 이미지다.

## 앱 코드 문법 확인
```bash
for f in sample-*/server.js; do node --check "$f" && echo "OK $f"; done
```
