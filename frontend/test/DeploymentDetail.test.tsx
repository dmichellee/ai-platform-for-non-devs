import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { DeploymentDetail } from "../src/screens/user/DeploymentDetail.js";
import { renderWithProviders, seedSession, setHash } from "./harness.js";
import { MockApiClient } from "../src/mock/mockApi.js";
import { FAILURE_GUIDANCE, failedStepIndex } from "../src/lib/labels.js";
import type { DeploymentLogs, FailureCategory } from "../src/lib/types.js";
import { mockDeployments } from "../src/mock/fixtures.js";

describe("배포 상세 — 실패 유형 → 안내 문구", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
  });

  it("BUILD_FAILED 배포는 해당 한국어 안내(로그 마지막 부분 → Kiro)를 보여준다", async () => {
    // 픽스처: 앱 99887766 의 배포가 BUILD_FAILED
    const dep = mockDeployments["99887766"]![0]!;
    setHash(`/apps/99887766/deployments/${encodeURIComponent(dep.deploymentId)}`);
    renderWithProviders(<DeploymentDetail appId="99887766" deploymentId={dep.deploymentId} />);

    expect(await screen.findByText(FAILURE_GUIDANCE.BUILD_FAILED)).toBeInTheDocument();
    // 단계 진행 표시 존재 — 검사와 빌드는 한 칸(파이프라인 ValidateBuild 스테이지와 일치)
    expect(screen.getByText("검사·빌드")).toBeInTheDocument();
    expect(screen.queryByText("빌드")).not.toBeInTheDocument();
  });

  it("성공 배포는 실패 안내를 보여주지 않는다", async () => {
    const dep = mockDeployments["a1b2c3d4"]![0]!;
    setHash(`/apps/a1b2c3d4/deployments/${encodeURIComponent(dep.deploymentId)}`);
    renderWithProviders(<DeploymentDetail appId="a1b2c3d4" deploymentId={dep.deploymentId} />);

    await screen.findByText("배포 진행 상황");
    expect(screen.queryByText(FAILURE_GUIDANCE.BUILD_FAILED)).not.toBeInTheDocument();
  });
});

// 방침 ③ — 성공한 배포에서 "이 버전으로 되돌리기" + 확인 모달 → rollback 호출.
describe("배포 상세 — 되돌리기(롤백)", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
  });

  it("성공(SUCCEEDED) 배포에는 '이 버전으로 되돌리기' 버튼이 있다", async () => {
    const dep = mockDeployments["a1b2c3d4"]![0]!; // status SUCCEEDED, trigger auto
    setHash(`/apps/a1b2c3d4/deployments/${encodeURIComponent(dep.deploymentId)}`);
    renderWithProviders(<DeploymentDetail appId="a1b2c3d4" deploymentId={dep.deploymentId} />);
    expect(await screen.findByRole("button", { name: /이 버전으로 되돌리기/ })).toBeInTheDocument();
  });

  it("실패 배포에는 되돌리기 버튼이 없다", async () => {
    const dep = mockDeployments["99887766"]![0]!; // status FAILED
    setHash(`/apps/99887766/deployments/${encodeURIComponent(dep.deploymentId)}`);
    renderWithProviders(<DeploymentDetail appId="99887766" deploymentId={dep.deploymentId} />);
    await screen.findByText("배포 진행 상황");
    expect(screen.queryByRole("button", { name: /이 버전으로 되돌리기/ })).not.toBeInTheDocument();
  });

  it("되돌리기 버튼 → 확인 모달 → '되돌리기'가 rollback(deploymentId)을 호출한다", async () => {
    const dep = mockDeployments["a1b2c3d4"]![0]!;
    const client = new MockApiClient();
    const rollbackSpy = vi.spyOn(client, "rollback");
    setHash(`/apps/a1b2c3d4/deployments/${encodeURIComponent(dep.deploymentId)}`);
    renderWithProviders(
      <DeploymentDetail appId="a1b2c3d4" deploymentId={dep.deploymentId} />,
      client,
    );

    fireEvent.click(await screen.findByRole("button", { name: /이 버전으로 되돌리기/ }));
    // 확인 모달 노출
    await screen.findByText("이 버전으로 되돌릴까요?");
    // 모달 안의 '되돌리기' 실행 버튼(모달 액션)
    const confirmBtn = screen
      .getAllByRole("button", { name: "되돌리기" })
      .at(-1)!;
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(rollbackSpy).toHaveBeenCalledWith("a1b2c3d4", dep.deploymentId));
  });
});

// QA F-L1 — 실패 배포의 실패 칸은 failureCategory(→ 배포 로그 stage → 첫 칸)로 정하고, 이전 칸은 완료.
describe("배포 상세 — 실패 칸 위치", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
  });

  const STEP_LABELS = ["가져오기", "검사·빌드", "배포", "확인"];

  async function renderFailed(
    failureCategory: FailureCategory | undefined,
    stage: DeploymentLogs["stage"],
  ): Promise<string[]> {
    const base = mockDeployments["99887766"]![0]!;
    const client = new MockApiClient();
    const { failureCategory: _omit, ...rest } = base;
    vi.spyOn(client, "listDeployments").mockResolvedValue([
      { ...rest, status: "FAILED", ...(failureCategory ? { failureCategory } : {}) },
    ]);
    vi.spyOn(client, "getDeploymentLogs").mockResolvedValue({
      events: [{ timestamp: 1, message: "x" }],
      source: "validate-build",
      ...(stage ? { stage } : {}),
    });
    setHash(`/apps/99887766/deployments/${encodeURIComponent(base.deploymentId)}`);
    renderWithProviders(
      <DeploymentDetail appId="99887766" deploymentId={base.deploymentId} />,
      client,
    );
    await screen.findByText("배포 진행 상황");
    await screen.findByRole("log");
    const steps = within(screen.getByLabelText("배포 단계"));
    return STEP_LABELS.map((l) => steps.getByText(l).className.replace("dstep", "").trim());
  }

  it.each<[FailureCategory, string[]]>([
    ["SOURCE_UNAVAILABLE", ["failed", "", "", ""]],
    ["DOCKERFILE_MISSING", ["done", "failed", "", ""]],
    ["DOCKERFILE_INVALID", ["done", "failed", "", ""]],
    ["BUILD_FAILED", ["done", "failed", "", ""]],
    ["HEALTHCHECK_FAILED", ["done", "failed", "", ""]],
    ["DEPLOY_FAILED", ["done", "done", "failed", ""]],
  ])("%s → 실패 칸 위치", async (cat, expected) => {
    // stage 는 분류와 어긋나게 줘도 분류가 우선한다.
    expect(await renderFailed(cat, cat === "DEPLOY_FAILED" ? "VALIDATING" : "DEPLOYING")).toEqual(
      expected,
    );
  });

  it("INTERNAL_ERROR 는 배포 로그 stage 로 실패 칸을 정한다", async () => {
    expect(await renderFailed("INTERNAL_ERROR", "DEPLOYING")).toEqual(["done", "done", "failed", ""]);
  });

  it("분류 없음 + stage VALIDATING → 검사·빌드", async () => {
    expect(await renderFailed(undefined, "VALIDATING")).toEqual(["done", "failed", "", ""]);
  });

  it("분류도 stage 도 없으면 첫 칸", async () => {
    expect(await renderFailed(undefined, undefined)).toEqual(["failed", "", "", ""]);
  });
});

describe("failedStepIndex", () => {
  it("분류 > stage > 첫 칸 순으로 정한다", () => {
    expect(failedStepIndex("BUILD_FAILED", "DEPLOYING")).toBe(1);
    expect(failedStepIndex("DEPLOY_FAILED")).toBe(2);
    expect(failedStepIndex("INTERNAL_ERROR", "VALIDATING")).toBe(1);
    expect(failedStepIndex("INTERNAL_ERROR")).toBe(0);
    expect(failedStepIndex(undefined, undefined)).toBe(0);
  });
});
