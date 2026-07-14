/**
 * 대시보드 카드 — 실패 앱 배지에 사유 tooltip.
 * 픽스처의 99887766(재고 알림봇)은 status=FAILED + failureReason 을 갖는다.
 * 상세 진입 전에도 배지 tooltip(title)으로 사유 힌트를 노출한다.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { Dashboard } from "../src/screens/user/Dashboard.js";
import { renderWithProviders, seedSession, setHash } from "./harness.js";
import { mockApps } from "../src/mock/fixtures.js";

const FAILED_APP = mockApps.find((a) => a.status === "FAILED")!;

describe("대시보드 — 실패 앱 배지 tooltip", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
    setHash("/");
  });

  it("실패 앱 배지에 failureReason 이 title 로 붙는다", async () => {
    renderWithProviders(<Dashboard />);
    // 실패 앱 카드가 렌더될 때까지 대기
    await screen.findByText(FAILED_APP.name);

    const badge = screen.getByText("실패");
    // 배지를 감싼 span(title 보유)을 찾는다.
    const titled = badge.closest("[title]");
    expect(titled).not.toBeNull();
    expect(titled!.getAttribute("title")).toBe(FAILED_APP.failureReason);
  });
});
