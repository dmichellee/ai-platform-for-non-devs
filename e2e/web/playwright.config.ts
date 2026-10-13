/**
 * Playwright 설정 — AppHub 웹 UI E2E (시나리오 5).
 *
 * baseURL 은 배포된 콘솔(ConsoleUrl = https://console.{appsDomain}) 또는 로컬 preview 를 가리킨다.
 * 라이브 실행 시 환경변수로 주입(run-e2e.sh 시나리오 5가 채워 준다):
 *   E2E_WEB_URL                               콘솔 베이스 URL
 *   E2E_USERNAME/E2E_PASSWORD                 사용자 여정(실서비스 로그인)
 *   E2E_ADMIN_USERNAME/E2E_ADMIN_PASSWORD     관리자 여정(실서비스 로그인)
 *
 * 로그인(D21): 실서비스는 콘솔 로그인 화면에서 이메일/비밀번호를 직접 입력한다(외부 로그인 페이지 없음).
 *   SPA가 목 모드(config.json 없음)면 "사용자로 둘러보기" 우회 버튼으로
 *   백엔드 없이도 화면 흐름을 검증할 수 있다(D-M6-03).
 *   private 모드(D19)는 콘솔이 internal ALB 뒤라 사내망/VPN 에서 실행해야 한다.
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
