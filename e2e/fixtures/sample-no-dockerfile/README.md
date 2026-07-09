# sample-no-dockerfile — DOCKERFILE_MISSING 검증

앱 코드(`server.js`)는 정상이지만 **레포 루트에 Dockerfile이 없다**.

## 무엇을 검증하는가
플랫폼 검증 1단계(C1 Dockerfile 존재)에서 파이프라인이 배포 전에 중단되는지.
Dockerfile 검증기가 `content=undefined`(파일 없음)를 받아 `DOCKERFILE_MISSING`을 반환한다.

## 기대 결과
| 항목 | 기대 |
|---|---|
| 검증기 failureCategory | `DOCKERFILE_MISSING` |
| Deployment.status | `FAILED` |
| Deployment.failureCategory | `DOCKERFILE_MISSING` |
| 기존 서비스 | 영향 없음(배포 전 중단) |

## 사용자 안내 문구(프론트 매핑, apphub-conventions 4장)
> "배포에 필요한 설정 파일(Dockerfile)이 없어요. Kiro에게 '이 앱을 배포 표준에 맞게 준비해줘'라고 요청한 뒤 다시 push 해주세요."

## 주의
이 픽스처는 **의도적으로 Dockerfile을 두지 않는다**. 실수로 Dockerfile을 추가하면
검증 목적이 깨진다.
