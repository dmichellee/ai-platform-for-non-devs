/**
 * 시나리오 5 (사용자 여정) — TEST-STRATEGY L4.
 *  로그인 → 마법사로 앱 생성 → 대시보드 상태 변화 → 로그 뷰어 표시 → 삭제.
 *
 * 목 모드에서는 우회 버튼으로 백엔드 없이 화면 흐름/용어/상태 배지 렌더링을 검증한다.
 * 실서비스 모드(D21 자체 로그인)에서는 E2E_USERNAME/E2E_PASSWORD 로 로그인 화면에서 직접 로그인한다.
 * 자격이 없으면 test.skip.
 */
import { test, expect } from "@playwright/test";
import { goHash, login, detectLoginMode, expectLoginScreen, expectRealLoginForm } from "./helpers.js";

test.describe("사용자 여정", () => {
  test("로그인 화면이 표시된다", async ({ page }) => {
    await goHash(page, "/login");
    await expectLoginScreen(page);
  });

  test("실서비스 로그인 화면은 이메일/비밀번호 폼이다(다른 페이지로 이동하지 않음)", async ({ page }) => {
    const mode = await detectLoginMode(page, "user");
    test.skip(mode !== "real", "목 모드 — 실서비스 로그인 폼 없음, skip");
    await expectRealLoginForm(page);
    // D21: 로그인 화면이 SPA 안에 있다(Hosted UI 로 리다이렉트하지 않음).
    expect(page.url()).not.toContain("amazoncognito.com");
  });

  test("잘못된 비밀번호는 화면 안에서 안내된다", async ({ page }) => {
    const mode = await detectLoginMode(page, "user");
    const user = process.env.E2E_USERNAME;
    test.skip(mode !== "real" || !user, "실서비스 모드 + E2E_USERNAME 필요, skip");
    await page.getByLabel("회사 이메일").fill(user!);
    await page.getByLabel("비밀번호", { exact: true }).fill(`wrong-${Date.now()}`);
    await page.getByRole("button", { name: "로그인", exact: true }).click();
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    // 용어 사전: 오류 문구에 내부 서비스명 노출 금지.
    await expect(alert).not.toContainText("Cognito");
  });

  test("로그인 → 대시보드 진입", async ({ page }) => {
    const ok = await login(page, "user");
    test.skip(!ok, "실서비스 모드인데 E2E_USERNAME/E2E_PASSWORD 미지정 — skip");
    // 대시보드로 이동(로그인 후 자동 이동 또는 명시 이동).
    await goHash(page, "/");
    // 대시보드 진입 확인: "새 앱 만들기" 또는 "첫 앱 만들기" 액션이 보여야 함.
    const cta = page.getByText(/앱 만들기/);
    await expect(cta.first()).toBeVisible();
  });

  test("앱 생성 마법사 열기 → 단계 진행 UI", async ({ page }) => {
    const ok = await login(page, "user");
    test.skip(!ok, "실서비스 자격(E2E_USERNAME/E2E_PASSWORD) 미지정 — skip");
    await goHash(page, "/apps/new");
    // 마법사 단계 진행 표시(aria-label="단계 진행").
    await expect(page.getByLabel("단계 진행")).toBeVisible();
    // 1단계는 저장소 선택(이름·공개 범위는 2단계) — 연결이 없는 사용자도 이 화면은 보인다.
    await expect(page.getByRole("heading", { name: "어떤 코드 저장소를 배포할까요?" })).toBeVisible();
    // "다음 단계" 버튼이 존재(저장소를 고르기 전에는 비활성).
    await expect(page.getByRole("button", { name: /다음 단계/ })).toBeVisible();
  });

  test("금지 용어(AWS 내부 용어)가 사용자 화면에 노출되지 않는다", async ({ page }) => {
    const ok = await login(page, "user");
    test.skip(!ok, "실서비스 자격(E2E_USERNAME/E2E_PASSWORD) 미지정 — skip");
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
    const ok = await login(page, "user");
    test.skip(!ok, "실서비스 자격(E2E_USERNAME/E2E_PASSWORD) 미지정 — skip");
    // 대시보드에서 앱 카드가 있으면 상세로. 없으면(목 데이터 없음) 이 케이스는 데이터 의존이라 skip.
    await goHash(page, "/");
    const firstCard = page.locator("[data-app-id], a[href*='#/apps/']").first();
    test.skip((await firstCard.count()) === 0, "표시할 앱이 없어 상세 흐름 skip(목 데이터 없음)");
    await firstCard.click();
    // 상세 화면에 로그/삭제 관련 액션이 존재하는지(문구 기반).
    await expect(page.getByText(/로그|삭제/).first()).toBeVisible();
  });
});
