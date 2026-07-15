import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { AdminSettingsTab } from "../src/screens/admin/AdminSettings.js";
import { renderWithProviders, seedSession } from "./harness.js";
import { MockApiClient } from "../src/mock/mockApi.js";
import type { AdminSettings } from "../src/lib/types.js";

/**
 * 죽은 UI 제거 (방침 ①·⑥) — 관리자 플랫폼 설정.
 * ① 네트워크(VPC) 등록 섹션 제거(플랫폼 자동 배치).
 * ⑥ 로그 보존 기간(logRetentionDays) 제거(미사용).
 */
describe("관리자 설정 — VPC 등록·로그 보존 UI 제거", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("admin");
  });

  it("'등록된 VPC' 섹션과 'VPC 추가' 버튼이 없다", async () => {
    renderWithProviders(<AdminSettingsTab />);
    await screen.findByText("소스 제공자 활성화");
    expect(screen.queryByText("등록된 VPC")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /VPC 추가/ })).not.toBeInTheDocument();
  });

  it("'로그 보존 기간' 입력이 없다", async () => {
    renderWithProviders(<AdminSettingsTab />);
    await screen.findByText("소스 제공자 활성화");
    expect(screen.queryByLabelText(/로그 보존 기간/)).not.toBeInTheDocument();
  });

  it("설정 저장 시 body 에 registeredVpcs·logRetentionDays 를 싣지 않는다", async () => {
    const client = new MockApiClient();
    const putSpy = vi.spyOn(client, "adminPutSettings");
    renderWithProviders(<AdminSettingsTab />, client);
    await screen.findByText("소스 제공자 활성화");
    // 쿼터를 바꿔 저장을 유의미하게 만든다.
    fireEvent.change(screen.getByLabelText("사용자당 앱 쿼터"), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: /설정 저장/ }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    const body = putSpy.mock.calls[0]![0] as Partial<AdminSettings> & Record<string, unknown>;
    expect("registeredVpcs" in body).toBe(false);
    expect("logRetentionDays" in body).toBe(false);
    expect(body.userAppQuota).toBe(9);
  });
});
