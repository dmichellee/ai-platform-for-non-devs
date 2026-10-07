/**
 * Playwright 공용 헬퍼 — 로그인(목 우회 / 실서비스 자체 로그인), 라우팅.
 *
 * SPA는 두 모드로 동작한다(D-M6-03, D21):
 *  - 실서비스: config.json 있음(mock=false) → 로그인 화면에서 바로 이메일/비밀번호 입력 →
 *    "로그인" 버튼(InitiateAuth USER_PASSWORD_AUTH). 다른 페이지(Hosted UI)로 이동하지 않는다.
 *  - 목/데모:  config.json 없음/불완전 → "사용자로 둘러보기 / 관리자로 둘러보기" 우회 버튼.
 *
 * 셀렉터는 frontend/src/screens/Login.tsx 의 실제 label/역할 기준:
 *  - 이메일: <label for="login-email">회사 이메일</label>
 *  - 비밀번호: <label for="login-password">비밀번호</label> (옆 토글 버튼 aria-label "비밀번호 보기"와
 *    구분하려고 exact 매칭)
 *  - 제출: button "로그인" (exact — "로그인하는 중…" 로딩 문구와 구분)
 *  - 오류: role=alert, 첫 로그인 새 비밀번호 단계: heading "새 비밀번호를 정해주세요"
 *
 * 실서비스 자격(환경변수 — 하드코딩 금지):
 *  - user:  E2E_USERNAME / E2E_PASSWORD
 *  - admin: E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD
 * 자격이 없으면 login() 은 false 를 반환하고 호출부가 skip 한다.
 */
import { type Page, expect } from "@playwright/test";

export type Role = "user" | "admin";

/** 해시 라우터 경로로 이동(D-M6-01). */
export async function goHash(page: Page, hash: string): Promise<void> {
  const target = hash.startsWith("#") ? hash : `#${hash}`;
  await page.goto(`/${target}`);
}

function mockButtonLabel(role: Role): string {
  return role === "user" ? "사용자로 둘러보기" : "관리자로 둘러보기";
}

/** 환경변수에서 실서비스 자격을 읽는다. 없으면 null. */
export function credentials(role: Role): { username: string; password: string } | null {
  const username = role === "user" ? process.env.E2E_USERNAME : process.env.E2E_ADMIN_USERNAME;
  const password = role === "user" ? process.env.E2E_PASSWORD : process.env.E2E_ADMIN_PASSWORD;
  return username && password ? { username, password } : null;
}

/**
 * 로그인 화면을 열고 모드를 판별한다(config 로딩 후 목 버튼 또는 이메일 입력 중 하나가 뜰 때까지 대기).
 * 반환: "mock" | "real". 이미 세션이 있으면(로그인 화면 대신 앱 화면) "signed-in".
 */
export async function detectLoginMode(page: Page, role: Role = "user"): Promise<"mock" | "real" | "signed-in"> {
  await goHash(page, "/login");
  const mockBtn = page.getByRole("button", { name: mockButtonLabel(role) });
  const email = page.getByLabel("회사 이메일");
  try {
    await mockBtn.or(email).first().waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    return "signed-in";
  }
  return (await mockBtn.count()) > 0 ? "mock" : "real";
}

/**
 * 목 모드 우회 로그인. 우회 버튼이 있으면 클릭해 세션을 만들고 true 반환.
 * 없으면(실서비스 모드) false 반환 — 호출부가 skip 처리.
 */
export async function loginMock(page: Page, role: Role): Promise<boolean> {
  if ((await detectLoginMode(page, role)) !== "mock") return false;
  await page.getByRole("button", { name: mockButtonLabel(role) }).first().click();
  return true;
}

/**
 * 실서비스 자체 로그인 화면(D21)으로 로그인. 성공 시 로그인 폼이 사라진다(App 이 세션 화면 렌더).
 * 오류(role=alert)나 첫 로그인 새 비밀번호 단계가 뜨면 명확한 메시지로 실패시킨다.
 */
export async function loginReal(page: Page, username: string, password: string): Promise<void> {
  await page.getByLabel("회사 이메일").fill(username);
  await page.getByLabel("비밀번호", { exact: true }).fill(password);
  await page.getByRole("button", { name: "로그인", exact: true }).click();

  const form = page.locator("form.login-form");
  const alert = form.getByRole("alert");
  const newPw = page.getByRole("heading", { name: "새 비밀번호를 정해주세요" });
  // 성공(폼 사라짐) / 오류 / 새 비밀번호 단계 중 먼저 오는 것.
  await expect
    .poll(
      async () => {
        if ((await newPw.count()) > 0) return "new-password";
        if ((await alert.count()) > 0) return "error";
        if ((await form.count()) === 0) return "ok";
        return "pending";
      },
      { timeout: 20_000, message: "로그인 결과 대기" },
    )
    .not.toBe("pending");

  if ((await newPw.count()) > 0) {
    throw new Error(
      "테스트 계정이 임시 비밀번호 상태입니다(새 비밀번호 단계). 화면에서 한 번 로그인해 비밀번호를 확정하세요.",
    );
  }
  if ((await alert.count()) > 0) {
    throw new Error(`로그인 실패: ${(await alert.first().innerText()).trim()}`);
  }
}

/**
 * 역할로 로그인 — 목 모드면 우회 버튼, 실서비스면 자격 환경변수로 자체 로그인.
 * 실서비스인데 자격이 없으면 false(호출부 skip).
 */
export async function login(page: Page, role: Role): Promise<boolean> {
  const mode = await detectLoginMode(page, role);
  if (mode === "signed-in") return true;
  if (mode === "mock") {
    await page.getByRole("button", { name: mockButtonLabel(role) }).first().click();
    return true;
  }
  const cred = credentials(role);
  if (!cred) return false;
  await loginReal(page, cred.username, cred.password);
  return true;
}

/** 로그인 화면이 떴는지(브랜드 + 모드별 진입 요소). */
export async function expectLoginScreen(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "AppHub" })).toBeVisible();
  const mockBtn = page.getByRole("button", { name: mockButtonLabel("user") });
  const email = page.getByLabel("회사 이메일");
  await expect(mockBtn.or(email).first()).toBeVisible();
}

/** 실서비스 로그인 폼 요소가 모두 보이는지(이메일·비밀번호·로그인·비밀번호 찾기). */
export async function expectRealLoginForm(page: Page): Promise<void> {
  await expect(page.getByLabel("회사 이메일")).toBeVisible();
  await expect(page.getByLabel("비밀번호", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "로그인", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "비밀번호를 잊으셨나요?" })).toBeVisible();
}
