import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThemeToggle, applyStoredTheme } from "../src/components/ThemeToggle.js";

describe("라이트/다크 토글", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("기본은 다크 (저장값·시스템 선호 없을 때)", () => {
    applyStoredTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("라이트 버튼 클릭 시 data-theme=light 로 바뀌고 localStorage에 저장된다", () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByLabelText("라이트 모드"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("apphub-theme")).toBe("light");
  });

  it("다크 버튼 클릭 시 data-theme=dark 로 되돌아온다", () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByLabelText("라이트 모드"));
    fireEvent.click(screen.getByLabelText("다크 모드"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("apphub-theme")).toBe("dark");
  });

  it("저장된 라이트 선택을 부팅 시 복원한다", () => {
    localStorage.setItem("apphub-theme", "light");
    applyStoredTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
