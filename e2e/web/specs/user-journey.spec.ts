/**
 * 시나리오 5 (사용자 여정) — TEST-STRATEGY L4.
 *  로그인 → 마법사로 앱 생성 → 대시보드 상태 변화 → 로그 뷰어 표시 → 삭제.
 *
 * 목 모드에서는 백엔드 없이 화면 흐름/용어/상태 배지 렌더링을 검증한다.
 * 실서비스 모드(우회 버튼 없음)에서는 test.skip 으로 안내(실 로그인은 별도 자격 필요).
 */
import { test, expect } from "@playwright/test";
import { goHash, loginMock, expectLoginScreen } from "./helpers.js";

test.describe("사용자 여정", () => {
  test("로그인 화면이 표시된다", async ({ page }) => {
    await goHash(page, "/login");
    await expectLoginScreen(page);
  });

  test("로그인 → 대시보드 진입", async ({ page }) => {
    const ok = await loginMock(page, "user");
    test.skip(!ok, "실서비스 모드(우회 버튼 없음) — 실 Cognito 로그인 자격이 필요해 skip");
    // 대시보드로 이동(로그인 후 자동 이동 또는 명시 이동).
    await goHash(page, "/");
    // 대시보드 진입 확인: "새 앱 만들기" 또는 "첫 앱 만들기" 액션이 보여야 함.
    const cta = page.getByText(/앱 만들기/);
    await expect(cta.first()).toBeVisible();
  });

  test("앱 생성 마법사 열기 → 단계 진행 UI", async ({ page }) => {
    const ok = await loginMock(page, "user");
    test.skip(!ok, "실서비스 모드 — skip");
    await goHash(page, "/apps/new");
    // 마법사 단계 진행 표시(aria-label="단계 진행").
    await expect(page.getByLabel("단계 진행")).toBeVisible();
    // 앱 이름 입력(placeholder="예: 고객문의 챗봇").
    const nameInput = page.getByPlaceholder("예: 고객문의 챗봇");
    await expect(nameInput).toBeVisible();
    await nameInput.fill("e2e 데모 앱");
    // "다음 단계" 버튼이 존재.
    await expect(page.getByRole("button", { name: /다음 단계/ })).toBeVisible();
  });

  test("금지 용어(AWS 내부 용어)가 사용자 화면에 노출되지 않는다", async ({ page }) => {
    const ok = await loginMock(page, "user");
    test.skip(!ok, "실서비스 모드 — skip");
    await goHash(page, "/");
    await page.waitForLoadState("networkidle").catch(() => {});
    const body = (await page.locator("body").innerText()).toString();
    // apphub-conventions §6 금지 용어(사용자 화면).
    const forbidden = ["ECS", "Fargate", "ALB", "CodeBuild", "CodePipeline", "Cognito", "IAM", "Target Group"];
    for (const term of forbidden) {
      expect(body, `사용자 화면에 금지 용어 '${term}' 노출`).not.toContain(term);
    }
  });

  test("앱 상세 → 로그 뷰어/삭제 액션 접근", async ({ page }) => {
    const ok = await loginMock(page, "user");
    test.skip(!ok, "실서비스 모드 — skip");
    // 대시보드에서 앱 카드가 있으면 상세로. 없으면(목 데이터 없음) 이 케이스는 데이터 의존이라 skip.
    await goHash(page, "/");
    const firstCard = page.locator("[data-app-id], a[href*='#/apps/']").first();
    test.skip((await firstCard.count()) === 0, "표시할 앱이 없어 상세 흐름 skip(목 데이터 없음)");
    await firstCard.click();
    // 상세 화면에 로그/삭제 관련 액션이 존재하는지(문구 기반).
    await expect(page.getByText(/로그|삭제/).first()).toBeVisible();
  });
});
