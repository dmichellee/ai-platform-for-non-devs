import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { AdminPresets } from "../src/screens/admin/AdminPresets.js";
import { AdminPermTemplates } from "../src/screens/admin/AdminPermTemplates.js";
import { renderWithProviders, seedSession } from "./harness.js";
import { MockApiClient } from "../src/mock/mockApi.js";

/**
 * QA M3 — 사용 중인 프리셋·권한 템플릿 삭제 시 409 IN_USE.
 * - 삭제 버튼 → 확인 모달 → 확인 후 호출.
 * - 409 이면 서버 message 를 오류로 보여주고 목록은 그대로(행이 남는다).
 * - 사용 중이 아니면 삭제되고 목록에서 사라진다.
 */

function rowOf(name: string): HTMLElement {
  return screen.getByText(name).closest("tr") as HTMLElement;
}

describe("M3 — 프리셋 삭제", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("admin");
  });

  it("mock: 앱이 쓰는 프리셋 삭제는 409 IN_USE", async () => {
    const client = new MockApiClient();
    await expect(client.adminDeletePreset("preset-medium")).rejects.toMatchObject({
      code: "IN_USE",
      httpStatus: 409,
    });
    const created = await client.adminCreatePreset({ displayName: "임시", cpu: 512, memory: 1024 });
    await expect(client.adminDeletePreset(created.presetId)).resolves.toBeUndefined();
  });

  it("삭제는 확인 모달을 거치고, 취소하면 호출하지 않는다", async () => {
    const client = new MockApiClient();
    const spy = vi.spyOn(client, "adminDeletePreset");
    renderWithProviders(<AdminPresets />, client);
    await screen.findByText("보통");
    fireEvent.click(within(rowOf("보통")).getByRole("button", { name: "삭제" }));
    const dialog = await screen.findByRole("dialog", { name: "프리셋을 삭제할까요?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("사용 중(409 IN_USE)이면 서버 message 를 보여주고 목록은 그대로 둔다", async () => {
    const client = new MockApiClient();
    renderWithProviders(<AdminPresets />, client);
    await screen.findByText("보통");
    fireEvent.click(within(rowOf("보통")).getByRole("button", { name: "삭제" }));
    const dialog = await screen.findByRole("dialog", { name: "프리셋을 삭제할까요?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "삭제" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("이 프리셋을 사용 중인 앱('고객문의 챗봇')이 있어요.");
    // 목록 유지 — 모달을 닫아도 행이 남아 있다.
    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("보통")).toBeInTheDocument();
    expect((await client.adminListPresets()).some((p) => p.presetId === "preset-medium")).toBe(true);
  });

  it("사용 중이 아니면 삭제되고 목록에서 사라진다", async () => {
    const client = new MockApiClient();
    await client.adminCreatePreset({ displayName: "안쓰는 프리셋", cpu: 512, memory: 1024 });
    renderWithProviders(<AdminPresets />, client);
    await screen.findByText("안쓰는 프리셋");
    fireEvent.click(within(rowOf("안쓰는 프리셋")).getByRole("button", { name: "삭제" }));
    const dialog = await screen.findByRole("dialog", { name: "프리셋을 삭제할까요?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(screen.queryByText("안쓰는 프리셋")).not.toBeInTheDocument());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("M3 — 권한 템플릿 삭제", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("admin");
  });

  it("mock: 앱이 쓰는 권한 템플릿 삭제는 409 IN_USE", async () => {
    const client = new MockApiClient();
    await expect(client.adminDeletePermTemplate("perm-basic")).rejects.toMatchObject({
      code: "IN_USE",
      httpStatus: 409,
    });
  });

  it("사용 중(409 IN_USE)이면 서버 message 를 보여주고 목록은 그대로 둔다", async () => {
    const client = new MockApiClient();
    const listSpy = vi.spyOn(client, "adminListPermTemplates");
    renderWithProviders(<AdminPermTemplates />, client);
    const row = (await screen.findByText("perm-ai")).closest("tr") as HTMLElement;
    const callsBefore = listSpy.mock.calls.length;
    fireEvent.click(within(row).getByRole("button", { name: "삭제" }));
    const dialog = await screen.findByRole("dialog", { name: "권한 템플릿을 삭제할까요?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "삭제" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("이 권한 템플릿을 사용 중인 앱");
    expect(screen.getByText("perm-ai")).toBeInTheDocument();
    // 실패 시 목록 재조회도 하지 않는다(그대로 둔다).
    expect(listSpy.mock.calls.length).toBe(callsBefore);
  });
});
