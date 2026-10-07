import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { AdminOverview } from "../src/screens/admin/AdminOverview.js";
import { renderWithProviders, seedSession } from "./harness.js";
import { MockApiClient } from "../src/mock/mockApi.js";

/**
 * ⑤ 관리자 전체 현황 — 강제 중지(재우기) + 타인 앱 삭제.
 * 강제 중지: POST /admin/apps/{id}/stop, 삭제: DELETE /admin/apps/{id}.
 * 둘 다 확인 모달을 거친다(강제 중지는 즉시 확인, 삭제는 이름 입력 일치).
 */

// '고객문의 챗봇'(a1b2c3d4)은 ACTIVE·RUNNING → 재우기 가능.
async function row(name: string): Promise<HTMLElement> {
  const cell = await screen.findByText(name);
  return cell.closest("tr")!;
}

describe("⑤ 관리자 — 강제 중지(재우기)", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("admin");
  });

  it("실행 중 앱의 '재우기'를 누르면 확인 모달이 뜨고, 확인 시 adminStopApp 을 호출한다", async () => {
    const client = new MockApiClient();
    const stopSpy = vi.spyOn(client, "adminStopApp");
    renderWithProviders(<AdminOverview />, client);

    const tr = await row("고객문의 챗봇");
    fireEvent.click(within(tr).getByRole("button", { name: /재우기/ }));

    // 확인 모달
    await screen.findByText("이 앱을 강제로 재울까요?");
    // 모달 안 '재우기' 실행 버튼(마지막 매칭)
    fireEvent.click(screen.getAllByRole("button", { name: /재우기/ }).at(-1)!);
    await waitFor(() => expect(stopSpy).toHaveBeenCalledWith("a1b2c3d4"));
  });

  it("잠자는 중 앱은 '재우기' 버튼이 비활성이다", async () => {
    renderWithProviders(<AdminOverview />, new MockApiClient());
    // '매출 대시보드'(e5f6a7b8): ACTIVE·SLEEPING → 재울 필요 없음(비활성)
    const tr = await row("매출 대시보드");
    expect(within(tr).getByRole("button", { name: /재우기/ })).toBeDisabled();
  });
});

describe("⑤ 관리자 — 타인 앱 삭제", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("admin");
  });

  it("삭제는 이름을 정확히 입력해야 활성화되고, 확인 시 adminDeleteApp 을 호출한다", async () => {
    const client = new MockApiClient();
    const delSpy = vi.spyOn(client, "adminDeleteApp");
    renderWithProviders(<AdminOverview />, client);

    // 다른 소유자 앱(인사 FAQ 봇, 77aa88bb, user-0002)
    const tr = await row("인사 FAQ 봇");
    fireEvent.click(within(tr).getByRole("button", { name: "인사 FAQ 봇 삭제" }));

    await screen.findByText("이 앱을 삭제할까요?");
    const confirm = screen.getByRole("button", { name: /삭제할게요/ });
    // 이름 입력 전에는 비활성
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("삭제 확인 이름"), { target: { value: "인사 FAQ 봇" } });
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(delSpy).toHaveBeenCalledWith("77aa88bb"));
  });

  it("생성 중 앱은 삭제 버튼이 비활성이다", async () => {
    renderWithProviders(<AdminOverview />, new MockApiClient());
    // '외부 랜딩 페이지'(11223344): status=CREATING → 삭제 불가
    const tr = await row("외부 랜딩 페이지");
    expect(within(tr).getByRole("button", { name: "외부 랜딩 페이지 삭제" })).toBeDisabled();
  });
});

describe("⑤ mockApi 상태 전이", () => {
  it("adminStopApp: ACTIVE·RUNNING → SLEEPING", async () => {
    const client = new MockApiClient();
    const res = await client.adminStopApp("a1b2c3d4");
    expect(res).toEqual({ appId: "a1b2c3d4", runtimeState: "SLEEPING", stopped: true });
    const after = (await client.adminListAllApps()).find((a) => a.appId === "a1b2c3d4");
    expect(after?.runtimeState).toBe("SLEEPING");
  });

  it("adminDeleteApp: 타인 앱 → DELETING", async () => {
    const client = new MockApiClient();
    const res = await client.adminDeleteApp("77aa88bb");
    expect(res.status).toBe("DELETING");
  });
});
