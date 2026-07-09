/**
 * sample-wrong-port — 앱이 3000 포트에서 리슨하고 Dockerfile도 EXPOSE 3000 이다.
 * 컨테이너 계약 C2(8080 리슨 + EXPOSE 8080)를 위반한다.
 * 플랫폼 검증 1단계(C2)에서 DOCKERFILE_INVALID 로 중단돼야 한다(정적 파싱).
 */
"use strict";

const http = require("node:http");

// 의도적 결함: 8080이 아닌 3000에서 리슨(계약 위반).
const PORT = 3000;

const server = http.createServer((req, res) => {
  if ((req.url ?? "/") === "/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("hello from sample-wrong-port\n");
});

server.listen(PORT, () => console.log(`[sample-wrong-port] listening on ${PORT}`));
