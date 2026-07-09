/**
 * sample-streaming — SSE(Server-Sent Events) 스트리밍 응답 앱.
 *
 * AI 챗 시나리오를 흉내낸다: `GET /stream` 이 여러 청크를 시간차로 흘려보낸다.
 * ALB(공유 로드밸런서)를 경유해도 청크가 버퍼링되지 않고 순차 도착하는지 검증하는 데 쓴다.
 *
 * 배포 표준은 완전히 준수한다(C2 8080, C3 /health 200, C5 env, C8 stdout).
 */
"use strict";

const http = require("node:http");

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
// 청크 개수/간격은 환경변수로 조정 가능(C5). 기본: 5청크, 300ms 간격.
const CHUNKS = Number.parseInt(process.env.STREAM_CHUNKS ?? "5", 10);
const INTERVAL_MS = Number.parseInt(process.env.STREAM_INTERVAL_MS ?? "300", 10);

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";

  // C3: 헬스체크.
  if (url === "/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // SSE 스트리밍 엔드포인트.
  if (url === "/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // ALB/프록시가 응답을 버퍼링하지 않도록 힌트.
      "x-accel-buffering": "no",
    });

    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      // 각 SSE 이벤트: "data: chunk-N\n\n"
      res.write(`data: chunk-${n}\n\n`);
      if (n >= CHUNKS) {
        res.write("event: done\ndata: [DONE]\n\n");
        clearInterval(timer);
        res.end();
      }
    }, INTERVAL_MS);

    // 클라이언트 연결 종료 시 타이머 정리(누수 방지).
    req.on("close", () => clearInterval(timer));
    return;
  }

  // 기본 라우트 — 안내.
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("sample-streaming: GET /stream for SSE, GET /health for healthcheck\n");
});

server.listen(PORT, () => console.log(`[sample-streaming] listening on ${PORT}`));

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`[sample-streaming] received ${sig}, shutting down`);
    server.close(() => process.exit(0));
  });
}
