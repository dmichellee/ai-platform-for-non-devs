/**
 * sample-build-error — 앱 코드와 Dockerfile은 정적 검증을 통과하지만,
 * 빌드 단계에서 존재하지 않는 의존성 설치가 실패해 이미지 빌드가 깨진다.
 * → 플랫폼 검증은 정적 단계(C1/C2/C6) 통과 → docker build 단계에서 BUILD_FAILED.
 *
 * 참고: 이 파일 자체는 문법적으로 유효하다(node --check 통과). 결함은 빌드 의존성에 있다.
 */
"use strict";

const http = require("node:http");
// 아래 require는 실제로는 실행되지 않는다(빌드가 먼저 실패하므로).
// package.json이 설치 불가능한 버전을 요구해 `npm ci`가 실패한다.
const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);

const server = http.createServer((req, res) => {
  if ((req.url ?? "/") === "/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("hello from sample-build-error\n");
});

server.listen(PORT, () => console.log(`[sample-build-error] listening on ${PORT}`));
