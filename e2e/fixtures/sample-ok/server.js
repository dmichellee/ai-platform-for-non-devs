/**
 * sample-ok — 배포 표준을 완전히 준수하는 최소 웹앱.
 *
 * 컨테이너 계약(KIRO-STANDARDS 1장):
 *  - C2: PORT 환경변수(기본 8080)에서 HTTP 리슨
 *  - C3: GET /health 200 (인증 불필요)
 *  - C5: 설정은 환경변수로 (하드코딩 없음)
 *  - C8: stdout 로그
 *
 * 의존성 0 (Node 내장 http만) — 빌드/기동이 빠르다.
 */
"use strict";

const http = require("node:http");

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
// 앱 표시 이름은 환경변수로 주입받는다(C5). 없으면 기본값.
const APP_LABEL = process.env.APP_LABEL ?? "sample-ok";

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";

  // C3: 헬스체크 — 인증 없이 200.
  if (url === "/health" || url === "/health/") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // 기본 라우트 — 앱이 살아있음을 보여주는 최소 응답.
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(`hello from ${APP_LABEL}\n`);
});

server.listen(PORT, () => {
  // C8: stdout 로그.
  console.log(`[sample-ok] listening on ${PORT}`);
});

// 그레이스풀 종료(잠자기/재배포 시 빠른 정리).
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`[sample-ok] received ${sig}, shutting down`);
    server.close(() => process.exit(0));
  });
}
