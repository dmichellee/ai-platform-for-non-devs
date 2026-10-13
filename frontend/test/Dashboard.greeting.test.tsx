/**
 * 대시보드 인사말/이니셜 폴백 검증.
 * - name 있음 → "OOO님", 이니셜 = name 첫 글자
 * - name 없음(email만) → email 로컬파트로 폴백, 이니셜 = 로컬파트 첫 글자
 * - name·email 둘 다 없음 → "님" 단독, 이니셜 = "나"
 * 표시명 계산은 sessionDisplayName/sessionInitial(auth/tokens) 순수 함수로 단일화.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { Dashboard } from "../src/screens/user/Dashboard.js";
import { renderWithProviders, seedSession, setHash } from "./harness.js";
import {
  sessionDisplayName,
  sessionInitial,
  type UserSession,
} from "../src/auth/tokens.js";

function avatarText(): string {
  const el = document.querySelector(".avatar");
  return el?.textContent ?? "";
}

const base: Omit<UserSession, "name" | "email"> = {
  sub: "user-0001",
  groups: ["user"],
  idToken: "x.y.",
  expiresAt: Date.now() + 3_600_000,
};

describe("표시명/이니셜 헬퍼 (auth/tokens)", () => {
  it("name이 있으면 name을 그대로 표시명으로 쓴다", () => {
    const s: UserSession = { ...base, name: "이다은", email: "someone@example.com" };
    expect(sessionDisplayName(s)).toBe("이다은");
    expect(sessionInitial(s)).toBe("이");
  });

  it("name이 없으면 email의 로컬파트(@ 앞)로 폴백한다", () => {
    const s: UserSession = { ...base, email: "jiwoo@example.com" };
    expect(sessionDisplayName(s)).toBe("jiwoo");
    expect(sessionInitial(s)).toBe("j");
  });

  it("공백뿐인 name은 무시하고 email 로컬파트로 폴백한다", () => {
    const s: UserSession = { ...base, name: "   ", email: "abc@example.com" };
    expect(sessionDisplayName(s)).toBe("abc");
  });

  it("name·email 둘 다 없으면 표시명은 null, 이니셜은 '나'", () => {
    const s: UserSession = { ...base, email: "" };
    expect(sessionDisplayName(s)).toBeNull();
    expect(sessionInitial(s)).toBe("나");
  });

  it("세션 자체가 없으면 표시명 null, 이니셜 '나'", () => {
    expect(sessionDisplayName(null)).toBeNull();
    expect(sessionInitial(null)).toBe("나");
  });
});

describe("대시보드 인사말 — 세션 표시명 폴백", () => {
  beforeEach(() => {
    localStorage.clear();
    setHash("/");
  });

  it("name이 있으면 'OOO님'으로 인사하고 이니셜은 name 첫 글자", async () => {
    seedSession("user", { name: "이다은", email: "daeun@example.com" });
    renderWithProviders(<Dashboard />);
    expect(await screen.findByRole("heading", { name: /안녕하세요, 이다은님/ })).toBeInTheDocument();
    expect(avatarText()).toBe("이");
  });

  it("name이 없고 email만 있으면 로컬파트로 인사한다(님 한 번만)", async () => {
    seedSession("user", { name: null, email: "jiwoo@example.com" });
    renderWithProviders(<Dashboard />);
    const h = await screen.findByRole("heading", { name: /안녕하세요, jiwoo님/ });
    expect(h).toBeInTheDocument();
    // "님"이 중복되지 않는다 ("jiwoo님님" 아님)
    expect(h.textContent).not.toContain("님님");
    expect(avatarText()).toBe("j");
  });

  it("name·email 둘 다 없으면 '안녕하세요, 님'으로 뜨고 이니셜은 '나'", async () => {
    seedSession("user", { name: null, email: null });
    renderWithProviders(<Dashboard />);
    const h = await screen.findByRole("heading", { name: /안녕하세요, 님/ });
    expect(h).toBeInTheDocument();
    expect(h.textContent).not.toContain("님님");
    expect(avatarText()).toBe("나");
  });
});
