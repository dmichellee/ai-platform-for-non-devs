import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppStatusBadge } from "../src/components/StatusBadge.js";

describe("상태 배지 렌더 (status/runtimeState → 한국어 라벨)", () => {
  it("ACTIVE + RUNNING → '실행 중'", () => {
    render(<AppStatusBadge status="ACTIVE" runtimeState="RUNNING" />);
    expect(screen.getByText("실행 중")).toBeInTheDocument();
  });

  it("ACTIVE + WAKING → '깨우는 중'", () => {
    render(<AppStatusBadge status="ACTIVE" runtimeState="WAKING" />);
    expect(screen.getByText("깨우는 중")).toBeInTheDocument();
  });

  it("ACTIVE + SLEEPING → '잠자는 중'", () => {
    render(<AppStatusBadge status="ACTIVE" runtimeState="SLEEPING" />);
    expect(screen.getByText("잠자는 중")).toBeInTheDocument();
  });

  it("FAILED → runtimeState와 무관하게 '실패'", () => {
    render(<AppStatusBadge status="FAILED" runtimeState="RUNNING" />);
    expect(screen.getByText("실패")).toBeInTheDocument();
    expect(screen.queryByText("실행 중")).not.toBeInTheDocument();
  });

  it("CREATING → '만드는 중'", () => {
    render(<AppStatusBadge status="CREATING" runtimeState="SLEEPING" />);
    expect(screen.getByText("만드는 중")).toBeInTheDocument();
  });

  it("DELETING → '삭제 중'", () => {
    render(<AppStatusBadge status="DELETING" runtimeState="SLEEPING" />);
    expect(screen.getByText("삭제 중")).toBeInTheDocument();
  });

  it("배지에는 시각적 점(dot)이 함께 렌더된다", () => {
    const { container } = render(<AppStatusBadge status="ACTIVE" runtimeState="RUNNING" />);
    expect(container.querySelector(".dot")).toBeTruthy();
  });
});
