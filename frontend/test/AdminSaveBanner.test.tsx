import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { AdminSettingsTab } from "../src/screens/admin/AdminSettings.js";
import { AdminPresets } from "../src/screens/admin/AdminPresets.js";
import { renderWithProviders, seedSession } from "./harness.js";
import { MockApiClient } from "../src/mock/mockApi.js";
import { ApiError } from "../src/lib/api.js";

/**
 * 이슈 1 회귀 방지 — 관리자 저장 성공 시 "저장했어요" 배너가 몇 초 표시되고 자동으로 사라진다.
 * 실패 시에는 배너가 뜨지 않고 기존 에러 표시가 유지된다.
 */

describe("이슈 1 — 플랫폼 설정 저장 성공 피드백", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("admin");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("설정 저장 성공 시 '저장했어요' 배너가 뜬다", async () => {
    renderWithProviders(<AdminSettingsTab />);
    // 로드 완료(입력 필드 등장) 후 저장 버튼 클릭
    const saveBtn = await screen.findByRole("button", { name: /설정 저장/ });
    fireEvent.click(saveBtn);
    expect(await screen.findByText("저장했어요")).toBeInTheDocument();
  });

  it("저장 성공 배너는 몇 초 후 자동으로 사라진다", async () => {
    renderWithProviders(<AdminSettingsTab />);
    const saveBtn = await screen.findByRole("button", { name: /설정 저장/ });
    fireEvent.click(saveBtn);
    const banner = await screen.findByText("저장했어요");
    expect(banner).toBeInTheDocument();
    // 기본 3초 후 사라짐 (fake timer 없이 실제 대기: duration 초과까지 폴링)
    await waitFor(() => expect(screen.queryByText("저장했어요")).not.toBeInTheDocument(), {
      timeout: 4000,
    });
  }, 6000);

  it("저장 실패 시 성공 배너 대신 에러가 표시된다", async () => {
    const client = new MockApiClient();
    vi.spyOn(client, "adminPutSettings").mockRejectedValue(
      new ApiError("INTERNAL_ERROR", "저장에 실패했어요", 500),
    );
    renderWithProviders(<AdminSettingsTab />, client);
    const saveBtn = await screen.findByRole("button", { name: /설정 저장/ });
    fireEvent.click(saveBtn);
    expect(await screen.findByText("저장에 실패했어요")).toBeInTheDocument();
    expect(screen.queryByText("저장했어요")).not.toBeInTheDocument();
  });

  it("프리셋 추가 성공 시에도 목록 화면에 '저장했어요' 배너가 뜬다", async () => {
    renderWithProviders(<AdminPresets />);
    fireEvent.click(await screen.findByRole("button", { name: /프리셋 추가/ }));
    fireEvent.change(await screen.findByLabelText("표시명 (사용자에게 보임)"), {
      target: { value: "큰 것" },
    });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    // 저장(≈220ms) 후 목록 리로드(≈220ms) 사이 스켈레톤이 잠깐 끼므로 interval 폴링으로 확인한다.
    await waitFor(() => expect(screen.getByText("저장했어요")).toBeInTheDocument(), {
      timeout: 3000,
      interval: 100,
    });
  });
});
