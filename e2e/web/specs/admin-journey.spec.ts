/**
 * 시나리오 5 (관리자 여정) — TEST-STRATEGY L4.
 *  관리자 로그인 → 프리셋 생성 → 사용자 화면(마법사 크기 선택)에 반영 확인.
 *
 * 목 모드에서는 우회 버튼으로 관리자 화면 접근/탭 렌더링을 검증한다. 실서비스 모드(D21 자체 로그인)는
 * E2E_ADMIN_USERNAME/E2E_ADMIN_PASSWORD(사용자 게이팅 검증은 E2E_USERNAME/E2E_PASSWORD)로 로그인한다.
 * 실 백엔드 반영 확인은 실서비스 모드에서만 유효하므로, 데이터 의존 단계는 조건부 skip.
 */
import { test, expect } from "@playwright/test";
import { goHash, login } from "./helpers.js";

test.describe("관리자 여정", () => {
  test("관리자 화면 접근", async ({ page }) => {
    const ok = await login(page, "admin");
    test.skip(!ok, "실서비스 모드 — 관리자 자격(E2E_ADMIN_*) 미지정, skip");
    await goHash(page, "/admin");
    // 관리자 화면은 기술 용어 허용(용어 사전 예외). 관리자 탭/설정이 보이는지.
    await expect(page.getByText(/설정|프리셋|권한|사용자|현황/).first()).toBeVisible();
  });

  test("컴퓨팅 프리셋 탭 열기", async ({ page }) => {
    const ok = await login(page, "admin");
    test.skip(!ok, "실서비스 모드 — 관리자 자격(E2E_ADMIN_*) 미지정, skip");
    // 관리자 탭은 ?tab= 으로 전환(D-M6-01).
    await goHash(page, "/admin?tab=presets");
    // 프리셋 관련 UI(생성 버튼 또는 목록).
    await expect(page.getByText(/프리셋|크기|생성/).first()).toBeVisible();
  });

  test("user 계정은 관리자 화면 접근 시 대시보드로 유도된다", async ({ page }) => {
    const ok = await login(page, "user");
    test.skip(!ok, "실서비스 모드 — 사용자 자격(E2E_USERNAME/E2E_PASSWORD) 미지정, skip");
    await goHash(page, "/admin");
    // D-M6-03: user 가 /admin 접근 시 대시보드로 게이팅. 관리자 전용 UI 가 보이면 안 됨.
    await page.waitForTimeout(500);
    // 대시보드 CTA 로 돌아왔는지(느슨한 검증 — 라우팅 구현 의존).
    const onDashboard = await page.getByText(/앱 만들기/).first().isVisible().catch(() => false);
    expect(onDashboard, "user 는 관리자 화면 대신 대시보드로 유도돼야 함").toBeTruthy();
  });

  test("프리셋 생성 → 사용자 마법사 크기 선택에 반영(실 백엔드 연결 시)", async ({ page }) => {
    // 이 시나리오는 실 백엔드 왕복이 필요하다. 목 모드/자격 미지정이면 skip.
    const hasAdminCreds = Boolean(process.env.E2E_ADMIN_USERNAME && process.env.E2E_ADMIN_PASSWORD);
    test.skip(!hasAdminCreds, "실 관리자 자격(E2E_ADMIN_*) 미지정 — 백엔드 반영 검증 skip");

    const ok = await login(page, "admin");
    test.skip(!ok, "관리자 로그인 불가 — skip");

    // NOTE: 로그인은 자체 로그인 화면(D21)으로 처리됨. 프리셋 폼 필드 상호작용은
    //  라이브 화면에 맞춰 채워야 한다. 여기서는 흐름의 뼈대만 둔다(라이브에서 구체화).
    await goHash(page, "/admin?tab=presets");
    await expect(page.getByText(/프리셋/).first()).toBeVisible();
    // TODO(live): 프리셋 생성 폼 채우기 → 저장 → 사용자 마법사(#/apps/new)의 크기 목록에
    //  새 프리셋 displayName 이 나타나는지 확인.
  });
});
