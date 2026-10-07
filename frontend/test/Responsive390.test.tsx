import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { screen } from "@testing-library/react";
import { Dashboard } from "../src/screens/user/Dashboard.js";
import { AppDetail } from "../src/screens/user/AppDetail.js";
import { CreateWizard } from "../src/screens/user/CreateWizard.js";
import { AdminOverview } from "../src/screens/admin/AdminOverview.js";
import { AdminUsers } from "../src/screens/admin/AdminUsers.js";
import { AdminPresets } from "../src/screens/admin/AdminPresets.js";
import { AdminPermTemplates } from "../src/screens/admin/AdminPermTemplates.js";
import { AdminInfra } from "../src/screens/admin/AdminInfra.js";
import { renderWithProviders, seedSession, setHash } from "./harness.js";

/**
 * 390px(모바일) 레이아웃 — 가로 스크롤 없이(scrollWidth ≤ 390) 렌더.
 *
 * jsdom 한계: 레이아웃 엔진이 없어 scrollWidth/getBoundingClientRect 가 항상 0 이라
 * 실제 폭 측정을 단언할 수 없다. 그래서 여기서는 (1) 모바일 미디어 쿼리 규칙이 있는지,
 * (2) 화면이 그 규칙이 걸리는 구조(클래스·래퍼)로 렌더되는지를 단언한다.
 * 실제 폭은 실브라우저(Playwright Chromium, 390×844, 목 모드)로 사용자·관리자 18개 경로 +
 * 상호작용(배포 상세·실행 로그 펼침·삭제 모달·설정 저장·마법사)에서 scrollWidth=390 을 확인했다
 * (2026-10-08, 프론트 QA 결함 수정 2차).
 */

const css = readFileSync(resolve(__dirname, "../src/styles/app.css"), "utf-8");

/** `@media (max-width: 640px) { ... }` 블록 본문(중괄호 짝 맞춰 추출). */
function mobileBlock(): string {
  const start = css.indexOf("@media (max-width: 640px)");
  expect(start, "모바일(≤640px) 미디어 쿼리가 있어야 한다").toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error("미디어 쿼리 블록이 닫히지 않음");
}

/** 블록 안에서 selector 규칙 본문을 찾아 돌려준다. */
function rule(block: string, selector: string): string {
  const re = new RegExp(`(^|[\\s,}])${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m");
  const m = block.match(re);
  expect(m, `모바일 규칙 '${selector}' 가 있어야 한다`).not.toBeNull();
  return m![2]!;
}

describe("390px — 모바일 CSS 규칙", () => {
  const block = mobileBlock();

  it("상단바: 줄바꿈 허용 + 메뉴는 둘째 줄 전체 폭(넘치면 그 줄만 가로 스크롤) + 테마 토글 글자 숨김", () => {
    expect(rule(block, ".app-topbar")).toMatch(/flex-wrap:\s*wrap/);
    const nav = rule(block, ".topbar-nav");
    expect(nav).toMatch(/flex:\s*1 1 100%/);
    expect(nav).toMatch(/overflow-x:\s*auto/);
    expect(rule(block, ".toggle-label")).toMatch(/display:\s*none/);
    // 터치 대상 44px (ui-ux-pro-max touch-target-size)
    expect(rule(block, ".topbar-nav .topbar-link")).toMatch(/min-height:\s*44px/);
  });

  it("카드 그리드 1열, 마법사 단계 축약(연결선 숨김·현재 단계만 이름), 모달 여백 축소", () => {
    expect(rule(block, ".card-grid")).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(rule(block, ".steps .line")).toMatch(/display:\s*none/);
    expect(rule(block, ".step:not(.active) .step-label")).toMatch(/display:\s*none/);
    expect(rule(block, ".scrim")).toMatch(/padding/);
    expect(rule(block, ".modal")).toMatch(/overflow-y:\s*auto/);
  });

  it("표 래퍼는 가로 스크롤 컨테이너다(전역 규칙)", () => {
    expect(css).toMatch(/\.table-scroll\s*\{[^}]*overflow-x:\s*auto/);
  });

  it("데스크톱에서는 메뉴 묶음이 상자를 만들지 않는다(display: contents — 기존 배치 유지)", () => {
    expect(css).toMatch(/\.topbar-nav\s*\{\s*display:\s*contents;?\s*\}/);
  });
});

describe("390px — 화면 구조(모바일 규칙이 걸리는 래퍼)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("대시보드: 메뉴가 nav.topbar-nav 안에, 테마 글자는 .toggle-label, 카드는 .card-grid", async () => {
    seedSession("admin");
    setHash("/");
    renderWithProviders(<Dashboard />);
    await screen.findByText("고객문의 챗봇");
    const nav = screen.getByRole("navigation", { name: "주요 메뉴" });
    expect(nav).toHaveClass("topbar-nav");
    for (const label of ["내 앱", "저장소 연결", "Kiro 설정", "관리자"]) {
      expect(nav.textContent).toContain(label);
    }
    // 로그아웃·테마 토글은 메뉴 줄이 아니라 첫 줄에 남는다
    expect(nav.querySelector("[aria-label='로그아웃']")).toBeNull();
    expect(document.querySelectorAll(".toggle .toggle-label")).toHaveLength(2);
    expect(document.querySelector(".card-grid")).not.toBeNull();
  });

  it("앱 상세: 상단바 메뉴 묶음 + 탭 줄(.tabs) 구조", async () => {
    seedSession("user");
    setHash("/apps/a1b2c3d4");
    renderWithProviders(<AppDetail appId="a1b2c3d4" />);
    await screen.findByText("고객문의 챗봇");
    expect(document.querySelector(".app-topbar .topbar-nav")).not.toBeNull();
    expect(document.querySelector(".tabs[role='tablist']")).not.toBeNull();
  });

  it("앱 생성 마법사: 단계 이름이 .step-label 로 분리돼 있다(좁은 화면에서 현재 단계만 표시)", async () => {
    seedSession("user");
    setHash("/apps/new");
    renderWithProviders(<CreateWizard />);
    await screen.findByLabelText("단계 진행");
    const labels = document.querySelectorAll(".steps .step .step-label");
    expect(labels.length).toBe(7);
    expect(document.querySelector(".step.active .step-label")).not.toBeNull();
  });

  it.each([
    ["전체 현황", AdminOverview, "고객문의 챗봇"],
    ["사용자", AdminUsers, "daeun@example.com"],
    ["컴퓨팅 프리셋", AdminPresets, "작게"],
    ["권한 템플릿", AdminPermTemplates, null],
    ["인프라 현황", AdminInfra, null],
  ] as const)("관리자 %s: 표는 .table-scroll 안에 있다", async (_name, Screen, waitText) => {
    seedSession("admin");
    renderWithProviders(<Screen />);
    if (waitText) await screen.findAllByText(waitText);
    const table = await screen.findByRole("table");
    expect(table.parentElement).toHaveClass("table-scroll");
  });
});
