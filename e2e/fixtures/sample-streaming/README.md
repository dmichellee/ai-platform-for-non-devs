# sample-streaming — ALB 경유 스트리밍(SSE) 검증

배포 표준을 준수하는 **SSE 스트리밍** 앱(AI 챗 시나리오 대역). 성공 경로 픽스처의 변형.

## 무엇을 검증하는가
공유 로드밸런서를 경유해도 스트리밍 응답이 **버퍼링 없이 순차 도착**하는지.
`GET /stream`이 `STREAM_INTERVAL_MS`(기본 300ms) 간격으로 `STREAM_CHUNKS`(기본 5)개의
SSE 이벤트(`data: chunk-N`)를 보내고 `event: done`으로 종료한다.

## 엔드포인트
| 경로 | 응답 |
|---|---|
| `GET /health` | 200 `{"status":"ok"}` |
| `GET /stream` | 200 `text/event-stream`, 청크 N개를 시간차로 흘림 |
| `GET /` | 200 안내 텍스트 |

## 기대 결과
| 항목 | 기대 |
|---|---|
| Dockerfile 검증 | `ok: true` |
| Deployment.status | `SUCCEEDED` |
| `GET /stream` (HTTPS, ALB 경유) | 청크가 한 번에 몰리지 않고 순차 수신, 마지막에 `[DONE]` |

## 로컬 확인 (선택)
```bash
node --check server.js
docker build -t sample-streaming .
docker run --rm -p 8080:8080 sample-streaming &
curl -N localhost:8080/stream   # -N: 버퍼링 없이 청크 즉시 출력
```
`curl -N`으로 청크가 300ms 간격으로 한 줄씩 나타나면 스트리밍이 정상이다.
