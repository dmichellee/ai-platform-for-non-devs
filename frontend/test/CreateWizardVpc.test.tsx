import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { CreateWizard } from "../src/screens/user/CreateWizard.js";
import { renderWithProviders, seedSession, setHash } from "./harness.js";
import { MockApiClient } from "../src/mock/mockApi.js";
import type { CreateAppRequest } from "../src/lib/types.js";

/**
 * 네트워크(VPC) UI 제거 검증 (확정 방침 ①).
 * 결정: 앱은 플랫폼 VPC 에 자동 배치된다. 마법사에는 네트워크 선택 UI가 없고,
 *       POST /apps body 에 vpcId 를 싣지 않는다(계약: vpcId optional, 서버 기본값 처리).
 * 과거(이슈 5)의 listVpcs 기반 드롭다운/자동선택 로직은 죽은 기능으로 제거됨.
 */

// 2단계(이름·공개 범위)까지 진입.
async function gotoNameStep(): Promise<void> {
  fireEvent.click(await screen.findByText("회사 GitHub"));
  fireEvent.change(screen.getByPlaceholderText(/https:\/\/github.com/), {
    target: { value: "https://github.com/example/x" },
  });
  fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
  await screen.findByText("앱 이름과 접속 범위를 정해주세요");
}

describe("① 네트워크(VPC) UI 제거", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
    setHash("/apps/new");
  });
  afterEach(() => vi.useRealTimers());

  it("2단계(이름·공개 범위)에 '네트워크' 선택 UI가 없다", async () => {
    renderWithProviders(<CreateWizard />);
    await gotoNameStep();
    expect(screen.queryByLabelText("네트워크")).not.toBeInTheDocument();
    // 과거 안내 문구도 노출되지 않아야 한다.
    expect(screen.queryByText(/관리자가 아직 네트워크를 준비하지 않았어요/)).not.toBeInTheDocument();
  });

  it("네트워크 선택 없이도 이름·주소만으로 다음 단계로 진행할 수 있다", async () => {
    renderWithProviders(<CreateWizard />);
    await gotoNameStep();
    fireEvent.change(screen.getByLabelText("앱 이름"), { target: { value: "네트워크 없는 앱" } });
    fireEvent.change(screen.getByLabelText("접속 주소"), { target: { value: "no-net-ui" } });
    await screen.findByText("사용할 수 있는 주소예요");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /다음 단계/ })).not.toBeDisabled(),
    );
  });

  it("createApp body 에 vpcId 를 싣지 않는다(플랫폼 자동 배치)", async () => {
    const client = new MockApiClient();
    const createSpy = vi.spyOn(client, "createApp");
    renderWithProviders(<CreateWizard />, client);
    await gotoNameStep();
    fireEvent.change(screen.getByLabelText("앱 이름"), { target: { value: "자동 배치 앱" } });
    fireEvent.change(screen.getByLabelText("접속 주소"), { target: { value: "auto-vpc" } });
    await screen.findByText("사용할 수 있는 주소예요");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /다음 단계/ })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
    // 3~6단계 최소 진행
    fireEvent.click((await screen.findAllByText(/최소 .*대/))[0]!.closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
    await screen.findByText("어떤 기능을 사용하는 앱인가요?");
    fireEvent.click((await screen.findAllByRole("button")).find((b) => b.className.includes("choice"))!);
    fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
    await screen.findByText("앱에 전달할 설정값이 있나요?");
    fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
    await screen.findByText("앱을 언제 켜둘까요?");
    fireEvent.click(screen.getByRole("button", { name: /앱 만들기/ }));
    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    const body = createSpy.mock.calls[0]![0] as CreateAppRequest;
    // 프론트는 vpcId 키 자체를 보내지 않는다.
    expect("vpcId" in body).toBe(false);
  });
});
