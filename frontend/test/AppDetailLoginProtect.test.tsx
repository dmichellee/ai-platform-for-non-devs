import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { AppDetail } from "../src/screens/user/AppDetail.js";
import { MOCK_CONFIG, renderWithProviders, seedSession, setHash } from "./harness.js";
import { MockApiClient } from "../src/mock/mockApi.js";
import { ApiError } from "../src/lib/api.js";
import { setConfigForTest } from "../src/lib/config.js";
import type { PatchAppRequest, PatchAppResponse } from "../src/lib/types.js";

/**
 * QA N1 — 앱 로그인 보호(cognitoProtect, D16).
 * - 토글 근처에 "한 번 더 로그인" 안내 문구.
 * - private 설치(config.frontendMode="private")면 토글 비활성 + 사유 안내.
 * - 서버 400 COGNITO_PROTECT_UNAVAILABLE 이면 그 message 를 보여준다.
 * - 화면에 금지 용어(Cognito 등)가 없다.
 */

const APP_ID = "a1b2c3d4"; // 픽스처: cognitoProtect=false
const PRIVATE_CONFIG = { ...MOCK_CONFIG, frontendMode: "private" as const };
const FORBIDDEN = ["Cognito", "ALB", "리스너", "Hosted UI", "ECS", "internet-facing", "internal", "IAM"];

async function openSettings(): Promise<HTMLElement> {
  await screen.findByText("고객문의 챗봇");
  fireEvent.click(screen.getByRole("tab", { name: "설정" }));
  return screen.findByRole("switch", { name: "로그인 보호" });
}

describe("N1 — 로그인 보호 토글", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
    setHash(`/apps/${APP_ID}`);
    setConfigForTest(MOCK_CONFIG);
  });

  it("토글 근처에 '한 번 더 로그인' 안내가 보이고 금지 용어가 없다", async () => {
    renderWithProviders(<AppDetail appId={APP_ID} />);
    const toggle = await openSettings();
    expect(toggle).not.toBeDisabled();
    expect(screen.getByText("켜면 앱에 들어갈 때 회사 계정으로 한 번 더 로그인해요.")).toBeInTheDocument();
    expect(screen.getByText(/별도의 로그인 화면이 한 번 더 나타나요/)).toBeInTheDocument();
    expect(screen.queryByText("사내 전용 설치에서는 로그인 보호를 쓸 수 없어요.")).not.toBeInTheDocument();
    const text = document.body.textContent ?? "";
    for (const t of FORBIDDEN) expect(text.includes(t), `금지 용어 '${t}'`).toBe(false);
  });

  it("private 설치에서는 토글이 비활성이고 사유를 안내한다", async () => {
    renderWithProviders(<AppDetail appId={APP_ID} />, undefined, PRIVATE_CONFIG);
    const toggle = await openSettings();
    expect(toggle).toBeDisabled();
    const reason = screen.getByText("사내 전용 설치에서는 로그인 보호를 쓸 수 없어요.");
    expect(toggle).toHaveAttribute("aria-describedby", reason.id);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    const text = document.body.textContent ?? "";
    for (const t of FORBIDDEN) expect(text.includes(t), `금지 용어 '${t}'`).toBe(false);
  });

  it("config.json 에 frontendMode 가 없으면 public 으로 간주(토글 활성)", async () => {
    const { frontendMode: _m, ...noMode } = PRIVATE_CONFIG;
    void _m;
    renderWithProviders(<AppDetail appId={APP_ID} />, undefined, noMode);
    const toggle = await openSettings();
    expect(toggle).not.toBeDisabled();
  });

  it("mock: private 설치에서 로그인 보호를 켜면 400 COGNITO_PROTECT_UNAVAILABLE", async () => {
    setConfigForTest(PRIVATE_CONFIG);
    const client = new MockApiClient();
    await expect(client.patchApp(APP_ID, { cognitoProtect: true })).rejects.toMatchObject({
      code: "COGNITO_PROTECT_UNAVAILABLE",
      httpStatus: 400,
    });
    setConfigForTest(MOCK_CONFIG);
    await expect(client.patchApp(APP_ID, { cognitoProtect: true })).resolves.toBeTruthy();
  });

  it("서버가 COGNITO_PROTECT_UNAVAILABLE 을 주면 그 message 를 토글 아래에 보여준다", async () => {
    const client = new MockApiClient();
    const serverMsg = "이 설치 환경에서는 로그인 보호를 켤 수 없어요. 관리자에게 문의해주세요.";
    vi.spyOn(client, "patchApp").mockImplementation(
      async (_id: string, _b: PatchAppRequest): Promise<PatchAppResponse> => {
        throw new ApiError("COGNITO_PROTECT_UNAVAILABLE", serverMsg, 400);
      },
    );
    renderWithProviders(<AppDetail appId={APP_ID} />, client);
    const toggle = await openSettings();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: /변경 사항 저장/ }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(serverMsg);
    // 같은 오류가 두 번(토글 아래 + 하단) 뜨지 않는다.
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1));
    // 토글이 속한 패널 안에 표시된다(필드 근처 오류).
    const panel = toggle.closest(".panel") as HTMLElement;
    expect(within(panel).getByRole("alert")).toBe(alert);
  });
});
