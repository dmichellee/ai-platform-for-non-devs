/**
 * Playwright 설정 — AppHub 웹 UI E2E (TEST-STRATEGY L4 시나리오 5).
 *
 * baseURL 은 배포된 SPA(CloudFront) 또는 로컬 preview 를 가리킨다.
 * 라이브 실행 시 환경변수로 주입:
 *   E2E_WEB_URL              SPA 베이스 URL (필수)
 *   E2E_ADMIN_USERNAME/...   관리자 프리셋 생성 시나리오용(선택)
 *
 * 주의: 실제 실행은 배포된 dev SPA + (실서비스면) Cognito 로그인이 필요하다.
 *   SPA가 목 모드(config.json 없음)면 "사용자로 둘러보기" 우회 버튼으로
 *   백엔드 없이도 화면 흐름을 검증할 수 있다(D-M6-03).
 */
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_WEB_URL ?? "http://localhost:4173";

export default defineConfig({
  testDir: "./specs",
  // 화면 흐름은 순차 검증(상태 전이 관찰). 병렬 비활성.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    // 자체 서명 인증서/개발 도메인 허용.
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
