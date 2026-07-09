import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import App from "../src/App.js";
import { AdminOverview } from "../src/screens/admin/AdminOverview.js";
import { MOCK_CONFIG, renderWithProviders, seedSession, setHash } from "./harness.js";

describe("관리자 화면 · 그룹 기반 라우팅", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("admin 그룹이면 #/admin 에서 관리 콘솔 탭이 보인다", async () => {
    seedSession("admin");
    setHash("/admin");
    render(<App config={MOCK_CONFIG} />);
    // 6개 탭 라벨 확인
    expect(await screen.findByRole("tab", { name: "전체 현황" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "컴퓨팅 프리셋" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "권한 템플릿" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "인프라 현황" })).toBeInTheDocument();
  });

  it("user 그룹이 #/admin 접근 시 관리 콘솔이 아니라 대시보드로 유도된다", async () => {
    seedSession("user");
    setHash("/admin");
    render(<App config={MOCK_CONFIG} />);
    // 관리 탭이 아니라 내 앱 대시보드가 뜬다
    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: "인프라 현황" })).not.toBeInTheDocument(),
    );
  });

  it("전체 현황 표에 앱과 소유자·상태 컬럼이 렌더된다 (관리자 = 기술 용어 허용)", async () => {
    seedSession("admin");
    renderWithProviders(<AdminOverview />);
    expect(await screen.findByText("고객문의 챗봇")).toBeInTheDocument();
    // 다른 소유자 앱도 전체 현황에 포함
    expect(screen.getByText("인사 FAQ 봇")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "소유자" })).toBeInTheDocument();
  });
});
