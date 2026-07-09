# sample-build-error — BUILD_FAILED 검증

Dockerfile은 **정적 검증을 통과**하지만, 이미지 빌드 단계에서 실패한다.

## 무엇을 검증하는가
정적 검증(C1/C2/C6/USER)을 통과한 뒤 `docker build`가 실패하는 경우가 `BUILD_FAILED`로
분류되는지. 결함은 `package.json`의 **존재하지 않는 의존성**(`this-package-does-not-exist-apphub-e2e@0.0.0-nonexistent`)이라 `npm ci`/`npm install`이 non-zero로 종료한다.

## 기대 결과
| 단계 | 기대 |
|---|---|
| Dockerfile 검증 | `ok: true` (정적 검증 통과 — EXPOSE 8080, 허용 베이스, USER node) |
| docker build | 실패 (npm 설치 단계) |
| Deployment.failureCategory | `BUILD_FAILED` |
| Deployment.status | `FAILED` |

## 사용자 안내 문구(프론트 매핑)
> "앱을 빌드하는 중 오류가 발생했어요. 아래 로그 마지막 부분을 복사해 Kiro에게 '이 빌드 오류를 고쳐줘'라고 전달하세요."

## 검증기로는 잡히지 않음
이 픽스처의 실패는 **정적 검증기 범위 밖**(빌드 실동작)이다. 검증기는 `ok: true`를 반환하며,
BUILD_FAILED는 buildspec의 `docker build` 단계가 결정한다(KIRO-STANDARDS 3장: 신뢰 경계는 플랫폼 검증).
