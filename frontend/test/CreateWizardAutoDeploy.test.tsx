import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { CreateWizard } from "../src/screens/user/CreateWizard.js";
import { renderWithProviders, seedSession, setHash } from "./harness.js";
import { MockApiClient } from "../src/mock/mockApi.js";
import type { CreateAppRequest } from "../src/lib/types.js";

/**
 * 자동 배포 선택 — 마법사 6단계(가동 방식).
 * 이전에는 마법사에 자동배포 선택이 없어 항상 서버 기본(true)으로 생성됐다.
 * 이제 '가동 방식' 단계에 자동 배포 토글을 두고, 선택값을 POST /apps body 에 실어 보낸다.
 * 계약(api-contract.md): autoDeployEnabled?: boolean (기본 true).
 */

// 6단계(가동 방식)까지 진입 — 기존 마법사 테스트와 동일한 경로.
async function gotoSleepStep(): Promise<void> {
  fireEvent.click(await screen.findByText("회사 GitHub"));
  fireEvent.change(screen.getByPlaceholderText(/https:\/\/github.com/), {
    target: { value: "https://github.com/example/x" },
  });
  fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
  await screen.findByText("앱 이름과 접속 범위를 정해주세요");
  fireEvent.change(screen.getByLabelText("앱 이름"), { target: { value: "자동배포 앱" } });
  fireEvent.change(screen.getByLabelText("접속 주소"), { target: { value: "auto-deploy" } });
  await screen.findByText("사용할 수 있는 주소예요");
  await waitFor(() => expect(screen.getByRole("button", { name: /다음 단계/ })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
  fireEvent.click((await screen.findAllByText(/최소 .*대/))[0]!.closest("button")!);
  fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
  await screen.findByText("어떤 기능을 사용하는 앱인가요?");
  fireEvent.click((await screen.findAllByRole("button")).find((b) => b.className.includes("choice"))!);
  fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
  await screen.findByText("앱에 전달할 설정값이 있나요?");
  fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
  await screen.findByText("앱을 언제 켜둘까요?");
}

describe("마법사 — 자동 배포 선택(가동 방식 단계)", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
    setHash("/apps/new");
  });

  it("가동 방식 단계에 '자동 배포' 토글이 있고 기본으로 켜져 있다", async () => {
    renderWithProviders(<CreateWizard />, new MockApiClient());
    await gotoSleepStep();
    const toggle = screen.getByRole("switch", { name: "자동 배포" });
    expect(toggle).toBeInTheDocument();
    // 기본값: 켜짐(계약 기본 true 와 일치).
    expect(toggle).toHaveAttribute("aria-checked", "true");
    // 비개발자 친화 설명 문구가 노출된다.
    expect(screen.getByText(/코드를 올릴\(push\) 때마다 자동으로 다시 배포/)).toBeInTheDocument();
  });

  it("토글을 끄지 않으면 body 에 autoDeployEnabled: true 로 전송된다", async () => {
    const client = new MockApiClient();
    const createSpy = vi.spyOn(client, "createApp");
    renderWithProviders(<CreateWizard />, client);
    await gotoSleepStep();
    fireEvent.click(screen.getByRole("button", { name: /앱 만들기/ }));
    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    const body = createSpy.mock.calls[0]![0] as CreateAppRequest;
    expect(body.autoDeployEnabled).toBe(true);
  });

  it("토글을 끄면 body 에 autoDeployEnabled: false 로 전송된다", async () => {
    const client = new MockApiClient();
    const createSpy = vi.spyOn(client, "createApp");
    renderWithProviders(<CreateWizard />, client);
    await gotoSleepStep();
    // 자동 배포 끄기.
    fireEvent.click(screen.getByRole("switch", { name: "자동 배포" }));
    expect(screen.getByRole("switch", { name: "자동 배포" })).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("button", { name: /앱 만들기/ }));
    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    const body = createSpy.mock.calls[0]![0] as CreateAppRequest;
    expect(body.autoDeployEnabled).toBe(false);
  });

});
