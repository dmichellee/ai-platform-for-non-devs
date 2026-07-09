# sample-ok — 성공 경로 골든 샘플

배포 표준(KIRO-STANDARDS 1장 컨테이너 계약)을 **완전히 준수**하는 최소 웹앱.

## 무엇을 검증하는가
- Dockerfile 정적 검증 통과 (C1 존재 / C2 EXPOSE 8080 / C6 허용 베이스 이미지 / C7 non-root)
- 이미지 빌드 성공 (BUILD)
- 스모크 테스트 통과 — `GET /health` 200 (C3+C9)
- 배포 완주 → 발급 URL HTTPS 200
- 자동 배포(커밋 push → 파이프라인 트리거) 확인용 기준 앱

## 기대 결과
| 단계 | 기대 |
|---|---|
| Dockerfile 검증 | `ok: true` (경고 없음) |
| 빌드 | 성공 |
| 스모크 /health | 200 |
| Deployment.status | `SUCCEEDED` |
| failureCategory | 없음 |

## 구성
- `server.js` — Node 내장 http (의존성 0). `GET /` 200, `GET /health` 200.
- `Dockerfile` — `public.ecr.aws/docker/library/node:22-slim`, `EXPOSE 8080`, `USER node`.
- 포트: 환경변수 `PORT`(기본 8080)에서 리슨.

## 로컬 확인 (선택)
```bash
node --check server.js
docker build -t sample-ok .
docker run --rm -p 8080:8080 sample-ok &
curl -s localhost:8080/health   # -> {"status":"ok"}
```
