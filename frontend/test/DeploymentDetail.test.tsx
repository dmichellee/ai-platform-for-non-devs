import { describe, it, expect, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { DeploymentDetail } from "../src/screens/user/DeploymentDetail.js";
import { renderWithProviders, seedSession, setHash } from "./harness.js";
import { FAILURE_GUIDANCE } from "../src/lib/labels.js";
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
    // 단계 진행 표시 존재
    expect(screen.getByText("빌드")).toBeInTheDocument();
  });

  it("성공 배포는 실패 안내를 보여주지 않는다", async () => {
    const dep = mockDeployments["a1b2c3d4"]![0]!;
    setHash(`/apps/a1b2c3d4/deployments/${encodeURIComponent(dep.deploymentId)}`);
    renderWithProviders(<DeploymentDetail appId="a1b2c3d4" deploymentId={dep.deploymentId} />);

    await screen.findByText("배포 진행 상황");
    expect(screen.queryByText(FAILURE_GUIDANCE.BUILD_FAILED)).not.toBeInTheDocument();
  });
});
