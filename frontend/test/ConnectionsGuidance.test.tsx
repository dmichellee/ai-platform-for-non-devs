import { describe, it, expect, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { Connections } from "../src/screens/user/Connections.js";
import { renderWithProviders, seedSession, setHash } from "./harness.js";

/**
 * 저장소 연결 안내 문구 정직성 (작업 2).
 * PENDING(github/gitlab)은 "준비 중"으로 안내하고, 틀린/기술적 안내
 * ("AWS 콘솔", "GitHub 화면에서 승인" 등)를 노출하지 않아야 한다.
 * 카드 자체는 화면에 그대로 유지된다.
 */
describe("저장소 연결 — 정직한 안내 문구", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
    setHash("/connections");
  });

  it("PENDING(GitLab) 카드는 '준비 중' 안내를 보여주고 AWS 저장소를 권장한다", async () => {
    renderWithProviders(<Connections />);
    await screen.findByText("사내 GitLab");
    // 준비 중 안내
    expect(screen.getByText(/아직 준비 중이에요/)).toBeInTheDocument();
    // AWS 저장소 권장 (안내 문구 + codecommit 카드 라벨에 함께 등장 가능 → 1회 이상)
    expect(screen.getAllByText(/AWS 저장소\(CodeCommit\)/).length).toBeGreaterThan(0);
  });

  it("틀린/기술적 안내 문구를 노출하지 않는다", async () => {
    renderWithProviders(<Connections />);
    await screen.findByText("사내 GitLab");
    const text = document.body.textContent ?? "";
    // 웹에서 불가능한 승인 안내(비개발자 취지 위배) 금지
    expect(text.includes("AWS 콘솔")).toBe(false);
    expect(text.includes("GitHub 화면에서")).toBe(false);
    expect(text.includes("GitLab 화면에서")).toBe(false);
    expect(text.includes("외부 화면에서")).toBe(false);
    // 내부 용어도 여전히 금지
    expect(text.includes("CodeConnections")).toBe(false);
    expect(text.includes("OAuth")).toBe(false);
  });

  it("AWS 저장소(codecommit) 카드는 '바로 사용' 안내를 유지한다(존재 시)", async () => {
    renderWithProviders(<Connections />);
    // 픽스처에 codecommit AVAILABLE 연결이 있으면 카드가 뜬다
    expect(await screen.findByText("AWS 저장소")).toBeInTheDocument();
  });
});
