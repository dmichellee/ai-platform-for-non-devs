/**
 * sample-no-dockerfile — 앱 코드는 정상이지만 레포 루트에 Dockerfile이 없다.
 * 플랫폼 검증 1단계(C1)에서 DOCKERFILE_MISSING 으로 파이프라인이 중단돼야 한다.
 * (앱 자체는 sample-ok와 동일하게 동작한다 — 결함은 오직 Dockerfile 부재.)
 */
"use strict";

const http = require("node:http");

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);

const server = http.createServer((req, res) => {
  if ((req.url ?? "/") === "/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("hello from sample-no-dockerfile\n");
});

server.listen(PORT, () => console.log(`[sample-no-dockerfile] listening on ${PORT}`));
