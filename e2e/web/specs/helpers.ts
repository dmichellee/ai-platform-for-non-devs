/**
 * Playwright 공용 헬퍼 — 로그인/우회, 라우팅.
 *
 * SPA는 두 모드로 동작한다(D-M6-03):
 *  - 실서비스: config.json 있음 → "회사 계정으로 로그인"(Cognito Hosted UI).
 *  - 목/데모:  config.json 없음/불완전 → "사용자로 둘러보기 / 관리자로 둘러보기" 우회 버튼.
 *
 * E2E는 목 우회를 우선 시도하고(백엔드 없이 화면 흐름 검증), 우회 버튼이 없으면
 * (실서비스 모드) 실 로그인 경로를 안내하며 skip 한다.
 */
import { type Page, expect } from "@playwright/test";

/** 해시 라우터 경로로 이동(D-M6-01). */
export async function goHash(page: Page, hash: string): Promise<void> {
  const target = hash.startsWith("#") ? hash : `#${hash}`;
  await page.goto(`/${target}`);
}

/**
 * 목 모드 우회 로그인. 우회 버튼이 있으면 클릭해 세션을 만들고 true 반환.
 * 없으면(실서비스 모드) false 반환 — 호출부가 skip 처리.
 */
export async function loginMock(page: Page, role: "user" | "admin"): Promise<boolean> {
  await goHash(page, "/login");
  const label = role === "user" ? "사용자로 둘러보기" : "관리자로 둘러보기";
  const btn = page.getByRole("button", { name: label });
  if (await btn.count() === 0) {
    return false; // 실서비스 모드 — 우회 버튼 없음.
  }
  await btn.first().click();
  return true;
}

/** 로그인 화면이 떴는지(브랜드 + 문구). */
export async function expectLoginScreen(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "AppHub" })).toBeVisible();
}
