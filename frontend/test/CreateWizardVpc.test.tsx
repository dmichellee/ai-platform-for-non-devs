import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { CreateWizard } from "../src/screens/user/CreateWizard.js";
import { renderWithProviders, seedSession, setHash } from "./harness.js";
import { MockApiClient } from "../src/mock/mockApi.js";
import type { CreateAppRequest } from "../src/lib/types.js";

/**
 * 이슈 5 회귀 방지 — 마법사 네트워크(VPC) 선택.
 * 원인: `vpcId: "vpc-01"` 하드코딩 → 관리자 등록 VPC와 불일치 → VPC_NOT_REGISTERED.
 * 수정: listVpcs() 로 등록 네트워크를 읽어 1개면 자동선택(UI 숨김) / 2개↑ 드롭다운 / 0개 안내+진행불가.
 * 용어: 사용자 화면에서는 "네트워크"(VPC 미노출).
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

describe("이슈 5 — 네트워크 1개: 자동선택 + UI 미노출", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
    setHash("/apps/new");
  });
  afterEach(() => vi.useRealTimers());

  it("등록 네트워크가 1개면 '네트워크' 드롭다운을 노출하지 않는다", async () => {
    // 목 기본 registeredVpcs 는 1개(vpc-01).
    renderWithProviders(<CreateWizard />);
    await gotoNameStep();
    // "네트워크" 라벨 select 가 없어야 한다(자동선택).
    expect(screen.queryByLabelText("네트워크")).not.toBeInTheDocument();
  });

  it("createApp body.vpcId 는 하드코딩이 아니라 등록된 실제 vpcId 를 쓴다", async () => {
    const client = new MockApiClient();
    // 등록 VPC 를 vpc-01 이 아닌 값으로 바꿔서, 하드코딩(vpc-01)이 아님을 증명.
    vi.spyOn(client, "listVpcs").mockResolvedValue([
      { vpcId: "vpc-0bbe12345", label: "회사 기본 네트워크" },
    ]);
    const createSpy = vi.spyOn(client, "createApp");
    renderWithProviders(<CreateWizard />, client);
    await gotoNameStep();
    fireEvent.change(screen.getByLabelText("앱 이름"), { target: { value: "네트워크 앱" } });
    fireEvent.change(screen.getByLabelText("접속 주소"), { target: { value: "net-app" } });
    await screen.findByText("사용할 수 있는 주소예요");
    // 자동선택 확인 위해 다음 버튼 활성화 대기 후 진행
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /다음 단계/ })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
    // 3~6단계 최소 진행
    fireEvent.click((await screen.findAllByText(/최소 .*대/))[0]!.closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
    await screen.findByText("어떤 기능을 사용하는 앱인가요?");
    const typeCards = await screen.findAllByRole("button");
    fireEvent.click(typeCards.find((b) => b.className.includes("choice"))!);
    fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
    await screen.findByText("앱에 전달할 설정값이 있나요?");
    fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
    await screen.findByText("앱을 언제 켜둘까요?");
    fireEvent.click(screen.getByRole("button", { name: /앱 만들기/ }));
    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    const body = createSpy.mock.calls[0]![0] as CreateAppRequest;
    expect(body.vpcId).toBe("vpc-0bbe12345");
  });
});

describe("이슈 5 — 네트워크 2개↑: 드롭다운 선택", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
    setHash("/apps/new");
  });

  it("등록 네트워크가 2개면 '네트워크' 드롭다운이 label 로 노출되고, 미선택이면 다음 비활성", async () => {
    const client = new MockApiClient();
    vi.spyOn(client, "listVpcs").mockResolvedValue([
      { vpcId: "vpc-a", label: "메인 네트워크" },
      { vpcId: "vpc-b", label: "보조 네트워크" },
    ]);
    renderWithProviders(<CreateWizard />, client);
    await gotoNameStep();
    fireEvent.change(screen.getByLabelText("앱 이름"), { target: { value: "두 네트워크" } });
    fireEvent.change(screen.getByLabelText("접속 주소"), { target: { value: "two-net" } });
    await screen.findByText("사용할 수 있는 주소예요");
    const select = (await screen.findByLabelText("네트워크")) as HTMLSelectElement;
    // label 이 옵션으로 노출
    expect(screen.getByRole("option", { name: "메인 네트워크" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "보조 네트워크" })).toBeInTheDocument();
    // 미선택이면 다음 비활성
    expect(screen.getByRole("button", { name: /다음 단계/ })).toBeDisabled();
    // 선택하면 활성
    fireEvent.change(select, { target: { value: "vpc-b" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /다음 단계/ })).not.toBeDisabled(),
    );
  });
});

describe("이슈 5 — 네트워크 0개: 안내 + 진행 불가", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
    setHash("/apps/new");
  });

  it("등록 네트워크가 0개면 안내가 뜨고 다음이 비활성", async () => {
    const client = new MockApiClient();
    vi.spyOn(client, "listVpcs").mockResolvedValue([]);
    renderWithProviders(<CreateWizard />, client);
    await gotoNameStep();
    fireEvent.change(screen.getByLabelText("앱 이름"), { target: { value: "네트워크 없음" } });
    fireEvent.change(screen.getByLabelText("접속 주소"), { target: { value: "no-net" } });
    await screen.findByText("사용할 수 있는 주소예요");
    expect(
      await screen.findByText(/관리자가 아직 네트워크를 준비하지 않았어요/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /다음 단계/ })).toBeDisabled();
  });
});

describe("이슈 5 — mock listVpcs 는 registeredVpcs 의 {vpcId,label}만 반환", () => {
  it("설정의 registeredVpcs 를 그대로 노출한다", async () => {
    const client = new MockApiClient();
    const items = await client.listVpcs();
    expect(items.length).toBeGreaterThan(0);
    for (const v of items) {
      expect(typeof v.vpcId).toBe("string");
      expect(typeof v.label).toBe("string");
      expect(Object.keys(v).sort()).toEqual(["label", "vpcId"]);
    }
  });
});
