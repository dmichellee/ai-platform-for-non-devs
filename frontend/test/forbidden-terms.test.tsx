import { describe, it, expect, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Dashboard } from "../src/screens/user/Dashboard.js";
import { AppDetail } from "../src/screens/user/AppDetail.js";
import { Connections } from "../src/screens/user/Connections.js";
import { renderWithProviders, seedSession, setHash } from "./harness.js";

/**
 * 용어 사전 위반 검출 (apphub-conventions §6).
 * 사용자 화면 DOM 텍스트에 AWS 내부 용어가 노출되면 실패한다.
 * 관리자 화면은 예외이므로 제외한다. Dockerfile은 예외(Kiro 전달용) — 제외.
 *
 * 예외: "CodeCommit" — 저장소 provider는 GitHub/GitLab을 실제 브랜드명으로 노출하므로
 * 일관성을 위해 CodeCommit도 "AWS 저장소(CodeCommit)"로 고유명사 노출하기로 결정(사용자 승인).
 * 나머지 AWS 인프라 용어(ECS/ALB/Fargate 등)는 여전히 금지.
 */
const FORBIDDEN = [
  "ECS",
  "Fargate",
  "컨테이너",
  "ALB",
  "Target Group",
  "리스너",
  "CodeBuild",
  "CodePipeline",
  "파이프라인",
  "Cognito",
  "internet-facing",
  "internal",
  "IAM",
  "desiredCount",
  "scale-in",
];

function assertNoForbidden(): void {
  const text = document.body.textContent ?? "";
  for (const term of FORBIDDEN) {
    expect(text.includes(term), `사용자 화면에 금지 용어 '${term}'가 노출됨`).toBe(false);
  }
}

describe("사용자 화면 금지 용어 노출 검출", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
  });

  it("대시보드에 AWS 용어가 없다", async () => {
    setHash("/");
    renderWithProviders(<Dashboard />);
    await screen.findByText("고객문의 챗봇");
    assertNoForbidden();
  });

  it("앱 상세(RUNNING 앱)에 AWS 용어가 없다", async () => {
    setHash("/apps/a1b2c3d4");
    renderWithProviders(<AppDetail appId="a1b2c3d4" />);
    await waitFor(() => expect(screen.getByText("고객문의 챗봇")).toBeInTheDocument());
    assertNoForbidden();
  });

  it("저장소 연결 관리에 AWS 용어(및 OAuth/CodeConnections)가 없다", async () => {
    setHash("/connections");
    renderWithProviders(<Connections />);
    await screen.findByText("회사 GitHub");
    const text = document.body.textContent ?? "";
    assertNoForbidden();
    expect(text.includes("CodeConnections")).toBe(false);
    expect(text.includes("OAuth")).toBe(false);
    // PENDING 연결의 사용자 안내는 '승인 대기 중'으로 노출 (배지 + 본문에 등장)
    expect(screen.getAllByText(/승인 대기 중/).length).toBeGreaterThan(0);
  });
});
