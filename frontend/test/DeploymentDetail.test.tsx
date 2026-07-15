import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { DeploymentDetail } from "../src/screens/user/DeploymentDetail.js";
import { renderWithProviders, seedSession, setHash } from "./harness.js";
import { MockApiClient } from "../src/mock/mockApi.js";
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
