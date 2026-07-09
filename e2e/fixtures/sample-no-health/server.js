/**
 * sample-no-health — 앱이 8080에서 정상 리슨하고 빌드도 성공하지만,
 * `GET /health` 엔드포인트를 구현하지 않았다(계약 C3 위반).
 * → 정적 검증·빌드 통과 → 스모크 단계에서 /health 가 200을 못 줘 HEALTHCHECK_FAILED.
 *
 * 의도적으로 /health 는 404를 반환한다(다른 경로는 200).
 */
"use strict";

const http = require("node:http");

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);

const server = http.createServer((req, res) => {
  // 의도적 결함: /health 를 구현하지 않음 → 404.
  if ((req.url ?? "/") === "/health") {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found\n");
    return;
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("hello from sample-no-health (but /health is missing)\n");
});

server.listen(PORT, () => console.log(`[sample-no-health] listening on ${PORT}`));
