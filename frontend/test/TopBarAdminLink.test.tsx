/**
 * 탑바 관리자 진입점 — admin 그룹에게만 "관리자" 링크가 보이고, 클릭 시 #/admin 으로 이동한다.
 * user 그룹에게는 렌더되지 않는다. (진입점만 검증 — 라우팅/권한 보호 로직은 App.tsx가 담당)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { TopBar } from "../src/components/common.js";
import { renderWithProviders, seedSession } from "./harness.js";

describe("탑바 · 관리자 진입점", () => {
  beforeEach(() => {
    localStorage.clear();
    window.location.hash = "#/";
  });

  it("admin 그룹이면 '관리자' 링크가 탑바에 렌더된다", async () => {
    seedSession("admin");
    renderWithProviders(<TopBar userInitial="관" onLogout={() => {}} />);
    expect(
      await screen.findByRole("button", { name: /관리자/ }),
    ).toBeInTheDocument();
  });

  it("admin 그룹이 '관리자' 링크를 누르면 #/admin 으로 이동한다", async () => {
    seedSession("admin");
    renderWithProviders(<TopBar userInitial="관" onLogout={() => {}} />);
    const link = await screen.findByRole("button", { name: /관리자/ });
    fireEvent.click(link);
    await waitFor(() => expect(window.location.hash).toBe("#/admin"));
  });

  it("user 그룹에게는 '관리자' 링크가 렌더되지 않는다", async () => {
    seedSession("user");
    renderWithProviders(<TopBar userInitial="이" onLogout={() => {}} />);
    // 다른 메뉴는 뜨지만 관리자 링크는 없다
    expect(await screen.findByRole("button", { name: /내 앱/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /관리자/ })).not.toBeInTheDocument();
  });
});
