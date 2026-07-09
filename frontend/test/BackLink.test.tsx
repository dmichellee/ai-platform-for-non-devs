import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BackLink } from "../src/components/common.js";

/**
 * "내 앱으로" 등 뒤로가기 링크 (작업 3).
 * 라벨을 텍스트로 노출하고, 아이콘 pill(SVG)을 포함하며, 클릭 시 onClick 을 호출한다.
 * 이모지 금지 → Lucide SVG 만 사용.
 */
describe("BackLink", () => {
  it("라벨을 버튼 텍스트로 노출한다", () => {
    render(<BackLink label="내 앱으로" onClick={() => undefined} />);
    expect(screen.getByRole("button", { name: /내 앱으로/ })).toBeInTheDocument();
  });

  it("클릭하면 onClick 을 호출한다", () => {
    const onClick = vi.fn();
    render(<BackLink label="앱 상세로" onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: /앱 상세로/ }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("SVG 아이콘 pill 을 포함하고 이모지를 쓰지 않는다", () => {
    const { container } = render(<BackLink label="내 앱으로" onClick={() => undefined} />);
    expect(container.querySelector(".back-link-ico svg")).not.toBeNull();
    // 이모지(간단한 검출): 텍스트는 라벨뿐
    expect((screen.getByRole("button").textContent ?? "").trim()).toBe("내 앱으로");
  });
});
