import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, screen, fireEvent, waitFor } from "@testing-library/react";
import { AppDetail } from "../src/screens/user/AppDetail.js";
import { DeploymentDetail } from "../src/screens/user/DeploymentDetail.js";
import { renderWithProviders, seedSession, setHash } from "./harness.js";
import { MockApiClient } from "../src/mock/mockApi.js";
import type { App, Deployment, DeploymentLogs, LogEvent } from "../src/lib/types.js";
import { mockApps, mockDeployments } from "../src/mock/fixtures.js";
import { DEPLOYMENT_LOG_EMPTY, FAILURE_GUIDANCE } from "../src/lib/labels.js";

/**
 * QA M6 — 로그 뷰어·배포 상세 빌드 로그.
 * 앱 실행 로그: 서버가 최신부터 준다 → 최신이 위, "이전 로그 더 보기"(nextToken), 빈 결과 안내.
 * 배포 상세: 앱 실행 로그가 아니라 신설 GET /apps/{id}/deployments/{deploymentId}/logs 를 쓴다.
 *  - source 는 사용자 용어로("검사·빌드 로그"/"배포 로그"), 빈 결과는 안내, 진행 중이면 5초 폴링.
 */

const FORBIDDEN = ["CodeBuild", "CodePipeline", "파이프라인", "ECS", "Fargate", "컨테이너", "ALB", "validate-build", "provisioner"];
function assertNoForbidden(): void {
  const text = document.body.textContent ?? "";
  for (const t of FORBIDDEN) expect(text.includes(t), `금지 용어 '${t}' 노출`).toBe(false);
}

const T0 = Date.now();
const RUNNING: App = { ...mockApps[0]!, appId: "log-app1", status: "ACTIVE", runtimeState: "RUNNING" };

class LogStub extends MockApiClient {
  pages: Record<string, { events: LogEvent[]; nextToken?: string }> = {};
  override async getApp(): Promise<App> {
    return JSON.parse(JSON.stringify(RUNNING)) as App;
  }
  override async listDeployments(): Promise<Deployment[]> {
    return [];
  }
  override async getLogs(
    _appId: string,
    opts?: { limit?: number; nextToken?: string },
  ): Promise<{ events: LogEvent[]; nextToken?: string }> {
    return this.pages[opts?.nextToken ?? "first"] ?? { events: [] };
  }
}

async function openRuntimeLogs(client: LogStub): Promise<void> {
  setHash("/apps/log-app1?tab=deployments");
  renderWithProviders(<AppDetail appId="log-app1" />, client);
  fireEvent.click(await screen.findByRole("button", { name: /실행 로그 보기/ }));
}

function lineTexts(): string[] {
  return Array.from(document.querySelectorAll(".log-line")).map((el) => el.textContent ?? "");
}

describe("M6 — 앱 실행 로그(최신이 위)", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
  });

  it("서버가 준 최신순 그대로 최신 로그가 맨 위에 보인다", async () => {
    const client = new LogStub();
    client.pages.first = {
      events: [
        { timestamp: T0 - 1_000, message: "세 번째(최신)" },
        { timestamp: T0 - 2_000, message: "두 번째" },
        { timestamp: T0 - 3_000, message: "첫 번째(가장 오래됨)" },
      ],
    };
    await openRuntimeLogs(client);
    await screen.findByText(/세 번째\(최신\)/);
    const lines = lineTexts();
    expect(lines[0]).toContain("세 번째(최신)");
    expect(lines[2]).toContain("첫 번째(가장 오래됨)");
    // 다음 페이지가 없으면 더 보기 버튼도 없다
    expect(screen.queryByRole("button", { name: "이전 로그 더 보기" })).not.toBeInTheDocument();
  });

  it("'이전 로그 더 보기'는 nextToken 으로 더 오래된 로그를 아래에 이어 붙인다", async () => {
    const client = new LogStub();
    client.pages.first = {
      events: [
        { timestamp: T0 - 1_000, message: "최신 줄" },
        { timestamp: T0 - 2_000, message: "그 전 줄" },
      ],
      nextToken: "tok-2",
    };
    client.pages["tok-2"] = {
      events: [
        { timestamp: T0 - 60_000, message: "1분 전 줄" },
        { timestamp: T0 - 120_000, message: "2분 전 줄" },
      ],
    };
    const spy = vi.spyOn(client, "getLogs");
    await openRuntimeLogs(client);
    fireEvent.click(await screen.findByRole("button", { name: "이전 로그 더 보기" }));
    await screen.findByText(/2분 전 줄/);
    expect(spy).toHaveBeenCalledWith("log-app1", expect.objectContaining({ nextToken: "tok-2" }));
    const lines = lineTexts();
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("최신 줄");
    expect(lines[3]).toContain("2분 전 줄");
    // 마지막 페이지를 받으면 버튼이 사라진다
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "이전 로그 더 보기" })).not.toBeInTheDocument(),
    );
  });

  it("로그가 없으면 '최근 1시간 동안 기록된 로그가 없어요' 안내(오류 아님)", async () => {
    const client = new LogStub();
    await openRuntimeLogs(client);
    expect(await screen.findByText("최근 1시간 동안 기록된 로그가 없어요.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("M6 — 앱 실행 로그 10초 자동 새로고침(F2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    seedSession("user");
  });
  afterEach(() => vi.useRealTimers());

  it("열려 있으면 10초마다 새 줄만 다시 받는다", async () => {
    const client = new LogStub();
    client.pages.first = { events: [{ timestamp: T0, message: "한 줄" }] };
    const spy = vi.spyOn(client, "getLogs");
    setHash("/apps/log-app1?tab=deployments");
    renderWithProviders(<AppDetail appId="log-app1" />, client);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByRole("button", { name: /실행 로그 보기/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(spy).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(spy).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith("log-app1", expect.objectContaining({ startTime: T0 + 1 }));
  });
});

// ── 배포 상세 — 배포 단계 로그 ──
const FAILED_DEP = mockDeployments["99887766"]![0]!; // BUILD_FAILED
const DEPLOYING_DEP = mockDeployments["c9d0e1f2"]![0]!; // DEPLOYING

class DepLogStub extends MockApiClient {
  constructor(private readonly result: DeploymentLogs) {
    super();
  }
  override async getDeploymentLogs(): Promise<DeploymentLogs> {
    return JSON.parse(JSON.stringify(this.result)) as DeploymentLogs;
  }
}

describe("M6 — 배포 상세는 배포 단계 로그 엔드포인트를 쓴다", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
  });

  it("실패 배포: 새 엔드포인트를 (appId, deploymentId) 로 호출하고 앱 실행 로그는 부르지 않는다", async () => {
    const client = new MockApiClient();
    const depSpy = vi.spyOn(client, "getDeploymentLogs");
    const appSpy = vi.spyOn(client, "getLogs");
    setHash(`/apps/99887766/deployments/${encodeURIComponent(FAILED_DEP.deploymentId)}`);
    renderWithProviders(<DeploymentDetail appId="99887766" deploymentId={FAILED_DEP.deploymentId} />, client);

    expect(await screen.findByText(FAILURE_GUIDANCE.BUILD_FAILED)).toBeInTheDocument();
    // 실패 안내가 가리키는 "아래 로그" = 검사·빌드 로그
    expect(await screen.findByText("검사·빌드 로그")).toBeInTheDocument();
    expect(await screen.findByText(/npm ERR! code ERESOLVE/)).toBeInTheDocument();
    expect(depSpy).toHaveBeenCalledWith("99887766", FAILED_DEP.deploymentId, expect.objectContaining({ limit: 200 }));
    expect(appSpy).not.toHaveBeenCalled();
    // 계약: 최신이 [0] → 화면도 최신(실패 원인 줄)이 맨 위
    const lines = lineTexts();
    expect(lines[0]).toContain("returned a non-zero code: 1");
    expect(lines.at(-1)).toContain("RUN npm install");
    // 복사 버튼 제공
    expect(screen.getByRole("button", { name: "마지막 부분 복사" })).toBeInTheDocument();
    assertNoForbidden();
  });

  it("'이전 로그 더 보기'는 nextToken 으로 더 오래된 배포 로그를 아래에 잇는다", async () => {
    const client = new MockApiClient();
    vi.spyOn(client, "getDeploymentLogs").mockImplementation(async (_a, _d, opts) =>
      opts?.nextToken === "older-1"
        ? { events: [{ timestamp: T0 - 90_000, message: "오래된 빌드 줄\n" }], source: "validate-build", stage: "VALIDATING" }
        : {
            events: [{ timestamp: T0 - 1_000, message: "최근 빌드 줄\n" }],
            nextToken: "older-1",
            source: "validate-build",
            stage: "VALIDATING",
          },
    );
    setHash(`/apps/99887766/deployments/${encodeURIComponent(FAILED_DEP.deploymentId)}`);
    renderWithProviders(<DeploymentDetail appId="99887766" deploymentId={FAILED_DEP.deploymentId} />, client);
    fireEvent.click(await screen.findByRole("button", { name: "이전 로그 더 보기" }));
    await screen.findByText(/오래된 빌드 줄/);
    const lines = lineTexts();
    expect(lines[0]).toContain("최근 빌드 줄");
    expect(lines[1]).toContain("오래된 빌드 줄");
    // 줄 끝 개행은 잘라 빈 줄을 만들지 않는다
    expect(lines[0]!.endsWith("\n")).toBe(false);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "이전 로그 더 보기" })).not.toBeInTheDocument(),
    );
  });

  it("source=deploy 는 '배포 로그'로 표시한다", async () => {
    const client = new DepLogStub({
      events: [{ timestamp: T0, message: "새 버전 적용 완료" }],
      source: "deploy",
      stage: "DEPLOYING",
    });
    const dep = mockDeployments["a1b2c3d4"]![0]!;
    setHash(`/apps/a1b2c3d4/deployments/${encodeURIComponent(dep.deploymentId)}`);
    renderWithProviders(<DeploymentDetail appId="a1b2c3d4" deploymentId={dep.deploymentId} />, client);
    expect(await screen.findByText("배포 로그")).toBeInTheDocument();
    expect(screen.queryByText("검사·빌드 로그")).not.toBeInTheDocument();
    assertNoForbidden();
  });

  it("source=provisioner 도 내부 이름 대신 사용자 용어로 표시한다", async () => {
    const client = new DepLogStub({
      events: [{ timestamp: T0, message: "준비 중" }],
      source: "provisioner",
    });
    setHash(`/apps/99887766/deployments/${encodeURIComponent(FAILED_DEP.deploymentId)}`);
    renderWithProviders(<DeploymentDetail appId="99887766" deploymentId={FAILED_DEP.deploymentId} />, client);
    expect(await screen.findByText("앱 준비 로그")).toBeInTheDocument();
    assertNoForbidden();
  });

  it("로그가 아직 없으면 '아직 기록된 로그가 없어요' 안내", async () => {
    const client = new DepLogStub({ events: [], source: "validate-build", stage: "VALIDATING" });
    setHash(`/apps/99887766/deployments/${encodeURIComponent(FAILED_DEP.deploymentId)}`);
    renderWithProviders(<DeploymentDetail appId="99887766" deploymentId={FAILED_DEP.deploymentId} />, client);
    expect(await screen.findByText(DEPLOYMENT_LOG_EMPTY)).toBeInTheDocument();
    assertNoForbidden();
  });
});

describe("M6 — 진행 중 배포는 로그를 5초마다 다시 불러온다", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    seedSession("user");
  });
  afterEach(() => vi.useRealTimers());

  // 목 응답 → 렌더 → 다음 요청 예약이 이어지므로 act 단위를 잘게 나눠 시계를 진행한다.
  async function flush(ms: number): Promise<void> {
    for (let t = 0; t < ms; t += 100) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
    }
  }

  it("DEPLOYING 배포: 5초 뒤 배포 단계 로그를 다시 요청한다", async () => {
    const client = new MockApiClient();
    const spy = vi.spyOn(client, "getDeploymentLogs");
    setHash(`/apps/c9d0e1f2/deployments/${encodeURIComponent(DEPLOYING_DEP.deploymentId)}`);
    renderWithProviders(<DeploymentDetail appId="c9d0e1f2" deploymentId={DEPLOYING_DEP.deploymentId} />, client);
    await flush(2_000); // 목 지연(배포 목록 → 로그, 각 ≈200ms) 소화
    expect(screen.getByText("배포 로그")).toBeInTheDocument();
    const base = spy.mock.calls.length;
    expect(base).toBeGreaterThanOrEqual(1);
    await flush(5_500);
    expect(spy.mock.calls.length).toBeGreaterThan(base);
  });

  it("끝난(실패) 배포는 다시 요청하지 않는다", async () => {
    const client = new MockApiClient();
    const spy = vi.spyOn(client, "getDeploymentLogs");
    setHash(`/apps/99887766/deployments/${encodeURIComponent(FAILED_DEP.deploymentId)}`);
    renderWithProviders(<DeploymentDetail appId="99887766" deploymentId={FAILED_DEP.deploymentId} />, client);
    await flush(2_000);
    expect(screen.getByText("검사·빌드 로그")).toBeInTheDocument();
    const base = spy.mock.calls.length;
    expect(base).toBeGreaterThanOrEqual(1);
    await flush(30_000);
    expect(spy.mock.calls.length).toBe(base);
  });
});
