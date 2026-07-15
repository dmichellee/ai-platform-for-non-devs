import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { AppDetail } from "../src/screens/user/AppDetail.js";
import { renderWithProviders, seedSession, setHash } from "./harness.js";
import { MockApiClient } from "../src/mock/mockApi.js";
import { ApiError } from "../src/lib/api.js";
import type { App, AppMetrics, Deployment, LogEvent, MetricRange } from "../src/lib/types.js";
import { mockApps } from "../src/mock/fixtures.js";

/**
 * 앱 상세 탭 재편(개요 | 배포 이력 | 모니터링 | 설정) 검증.
 * - 4개 탭 렌더/전환
 * - 배포 이력: 성공 + 실패 배포를 모두 노출
 * - 모니터링: 목 시계열로 차트 3개 렌더 / 빈 데이터 안내
 * - 새 탭들에도 AWS 서비스명 금지 용어가 새어나오지 않음
 */

const RUNNING: App = { ...mockApps[0]!, appId: "tab-app-1", status: "ACTIVE", runtimeState: "RUNNING" };

// 성공+실패 배포가 함께 있는 이력을 반환하는 stub.
class TabStub extends MockApiClient {
  constructor(
    private readonly app: App,
    private readonly deps: Deployment[],
    private readonly metrics: AppMetrics,
  ) {
    super();
  }
  override async getApp(): Promise<App> {
    return JSON.parse(JSON.stringify(this.app)) as App;
  }
  override async listDeployments(): Promise<Deployment[]> {
    return JSON.parse(JSON.stringify(this.deps)) as Deployment[];
  }
  override async getMetrics(_appId: string, range: MetricRange): Promise<AppMetrics> {
    return { ...JSON.parse(JSON.stringify(this.metrics)), range };
  }
  override async getLogs(): Promise<{ events: LogEvent[] }> {
    return { events: [{ timestamp: Date.now(), message: "[info] 실행 로그 한 줄" }] };
  }
}

const MIXED_DEPS: Deployment[] = [
  {
    appId: "tab-app-1",
    deploymentId: "2026-07-15T00:00:00.000Z",
    commitSha: "abc1234",
    commitMessage: "기능 추가",
    trigger: "manual",
    status: "SUCCEEDED",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  },
  {
    appId: "tab-app-1",
    deploymentId: "2026-07-14T00:00:00.000Z",
    commitSha: "def5678",
    commitMessage: "빌드 실패한 배포",
    trigger: "auto",
    status: "FAILED",
    failureCategory: "BUILD_FAILED",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  },
];

function metricsWith(points: number): AppMetrics {
  const mk = (base: number): { t: number; v: number }[] =>
    Array.from({ length: points }, (_, i) => ({ t: 1_700_000_000_000 + i * 60_000, v: base + (i % 5) }));
  return { range: "1h", series: { requests: mk(100), cpu: mk(40), memory: mk(55) } };
}
const EMPTY_METRICS: AppMetrics = { range: "1h", series: { requests: [], cpu: [], memory: [] } };

function makeStub(over: Partial<{ app: App; deps: Deployment[]; metrics: AppMetrics }> = {}): TabStub {
  return new TabStub(over.app ?? RUNNING, over.deps ?? MIXED_DEPS, over.metrics ?? metricsWith(30));
}

const FORBIDDEN = ["ECS", "Fargate", "ALB", "CloudWatch", "CodeBuild", "Cognito", "internet-facing", "internal", "IAM"];
function assertNoForbidden(): void {
  const text = document.body.textContent ?? "";
  for (const term of FORBIDDEN) {
    expect(text.includes(term), `모니터링/배포 이력 화면에 금지 용어 '${term}'가 노출됨`).toBe(false);
  }
}

describe("앱 상세 — 탭 재편(개요·배포 이력·모니터링·설정)", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
    setHash("/apps/tab-app-1");
  });

  it("4개 탭(개요·배포 이력·모니터링·설정)이 모두 렌더된다", async () => {
    renderWithProviders(<AppDetail appId="tab-app-1" />, makeStub());
    await screen.findByText(RUNNING.name);
    const tablist = screen.getByRole("tablist");
    for (const name of ["개요", "배포 이력", "모니터링", "설정"]) {
      expect(within(tablist).getByRole("tab", { name })).toBeInTheDocument();
    }
  });

  it("개요 탭은 접속 주소·공개 범위·가동 방식 요약을 보여준다", async () => {
    renderWithProviders(<AppDetail appId="tab-app-1" />, makeStub());
    await screen.findByText(RUNNING.name);
    // 개요가 기본 탭 — 앱 정보 패널
    expect(screen.getByText("접속 주소")).toBeInTheDocument();
    expect(screen.getByText("공개 범위")).toBeInTheDocument();
    expect(screen.getByText("가동 방식")).toBeInTheDocument();
  });

  it("배포 이력 탭은 성공과 실패 배포를 모두 보여준다", async () => {
    renderWithProviders(<AppDetail appId="tab-app-1" />, makeStub());
    await screen.findByText(RUNNING.name);
    fireEvent.click(screen.getByRole("tab", { name: "배포 이력" }));

    expect(await screen.findByText("기능 추가")).toBeInTheDocument();
    expect(screen.getByText("빌드 실패한 배포")).toBeInTheDocument();
    // 상태 배지: 완료 + 실패 둘 다
    expect(screen.getByText("완료")).toBeInTheDocument();
    expect(screen.getByText("실패")).toBeInTheDocument();
  });

  it("배포 이력 탭 하단의 '실행 로그 보기'를 펼치면 로그 뷰어가 나온다", async () => {
    renderWithProviders(<AppDetail appId="tab-app-1" />, makeStub());
    await screen.findByText(RUNNING.name);
    fireEvent.click(screen.getByRole("tab", { name: "배포 이력" }));

    const toggle = await screen.findByText("실행 로그 보기");
    fireEvent.click(toggle);
    expect(await screen.findByText(/실행 로그 한 줄/)).toBeInTheDocument();
  });

  it("모니터링 탭은 목 시계열로 차트 3개(접속량·CPU·메모리)를 렌더한다", async () => {
    renderWithProviders(<AppDetail appId="tab-app-1" />, makeStub());
    await screen.findByText(RUNNING.name);
    fireEvent.click(screen.getByRole("tab", { name: "모니터링" }));

    expect(await screen.findByText("접속량")).toBeInTheDocument();
    expect(screen.getByText("CPU 사용률")).toBeInTheDocument();
    expect(screen.getByText("메모리 사용률")).toBeInTheDocument();
    // SVG 스파크라인 3개 (role="img" + aria-label)
    expect(screen.getByRole("img", { name: /접속량/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /CPU 사용률/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /메모리 사용률/ })).toBeInTheDocument();
  });

  it("모니터링 기간 버튼(1시간/6시간/24시간/7일)이 있고 전환된다", async () => {
    renderWithProviders(<AppDetail appId="tab-app-1" />, makeStub());
    await screen.findByText(RUNNING.name);
    fireEvent.click(screen.getByRole("tab", { name: "모니터링" }));
    await screen.findByText("접속량");

    const group = screen.getByRole("group", { name: "조회 기간" });
    for (const label of ["1시간", "6시간", "24시간", "7일"]) {
      expect(within(group).getByRole("button", { name: label })).toBeInTheDocument();
    }
    fireEvent.click(within(group).getByRole("button", { name: "24시간" }));
    await waitFor(() =>
      expect(within(group).getByRole("button", { name: "24시간" })).toHaveAttribute("aria-pressed", "true"),
    );
    // 전환 후에도 차트가 계속 있다
    expect(await screen.findByText("접속량")).toBeInTheDocument();
  });

  it("데이터가 없으면 '잠자는 중이거나 아직 데이터가 없어요' 안내를 보여준다", async () => {
    renderWithProviders(<AppDetail appId="tab-app-1" />, makeStub({ metrics: EMPTY_METRICS }));
    await screen.findByText(RUNNING.name);
    fireEvent.click(screen.getByRole("tab", { name: "모니터링" }));

    expect(await screen.findByText(/잠자는 중이거나 아직 데이터가 없어요/)).toBeInTheDocument();
    // 빈 데이터면 지표 카드는 렌더되지 않는다
    expect(screen.queryByText("접속량")).not.toBeInTheDocument();
  });

  it("모니터링 탭(데이터 있음)에 AWS 서비스명 금지 용어가 없다", async () => {
    renderWithProviders(<AppDetail appId="tab-app-1" />, makeStub());
    await screen.findByText(RUNNING.name);
    fireEvent.click(screen.getByRole("tab", { name: "모니터링" }));
    await screen.findByText("접속량");
    assertNoForbidden();
  });

  it("배포 이력 탭(로그 펼침 포함)에 AWS 서비스명 금지 용어가 없다", async () => {
    renderWithProviders(<AppDetail appId="tab-app-1" />, makeStub());
    await screen.findByText(RUNNING.name);
    fireEvent.click(screen.getByRole("tab", { name: "배포 이력" }));
    await screen.findByText("기능 추가");
    fireEvent.click(screen.getByText("실행 로그 보기"));
    await screen.findByText(/실행 로그 한 줄/);
    assertNoForbidden();
  });
});

// 방침 ② — 수동 배포/재시작 동작 + 에러 노출 확인.
describe("앱 상세 — 수동 배포/재시작 에러 노출", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
    setHash("/apps/tab-app-1");
  });

  it("'지금 배포'가 deploy(appId) 를 호출한다", async () => {
    const client = makeStub();
    const deploySpy = vi.spyOn(client, "deploy");
    renderWithProviders(<AppDetail appId="tab-app-1" />, client);
    await screen.findByText(RUNNING.name);
    fireEvent.click(screen.getByRole("button", { name: /지금 배포/ }));
    await waitFor(() => expect(deploySpy).toHaveBeenCalledWith("tab-app-1"));
  });

  it("배포 접수가 실패하면 에러 메시지를 화면에 노출한다(조용히 삼키지 않음)", async () => {
    const client = makeStub();
    vi.spyOn(client, "deploy").mockRejectedValue(
      new ApiError("INVALID_STATE", "준비된 앱만 배포할 수 있어요.", 409),
    );
    renderWithProviders(<AppDetail appId="tab-app-1" />, client);
    await screen.findByText(RUNNING.name);
    fireEvent.click(screen.getByRole("button", { name: /지금 배포/ }));
    expect(await screen.findByText("준비된 앱만 배포할 수 있어요.")).toBeInTheDocument();
  });

  it("'재시작'은 restartApp(appId) 를 호출하고, 배포(deploy)는 돌지 않는다", async () => {
    const client = makeStub();
    const restartSpy = vi.spyOn(client, "restartApp");
    const deploySpy = vi.spyOn(client, "deploy");
    renderWithProviders(<AppDetail appId="tab-app-1" />, client);
    await screen.findByText(RUNNING.name);
    fireEvent.click(screen.getByRole("button", { name: /재시작/ }));
    // 재시작 전용 API 로 접수 — 예전 버그(재시작이 deploy 를 호출)로 회귀하지 않도록 함께 단언.
    await waitFor(() => expect(restartSpy).toHaveBeenCalledWith("tab-app-1"));
    expect(deploySpy).not.toHaveBeenCalled();
  });

  it("재시작 성공 시 서버가 준 안내(note)를 화면에 보여준다", async () => {
    const client = makeStub();
    vi.spyOn(client, "restartApp").mockResolvedValue({
      appId: "tab-app-1",
      note: "앱을 다시 시작하고 있어요. 잠시 후(약 1분) 새로고침해 주세요.",
    });
    renderWithProviders(<AppDetail appId="tab-app-1" />, client);
    await screen.findByText(RUNNING.name);
    fireEvent.click(screen.getByRole("button", { name: /재시작/ }));
    expect(
      await screen.findByText("앱을 다시 시작하고 있어요. 잠시 후(약 1분) 새로고침해 주세요."),
    ).toBeInTheDocument();
  });

  it("재시작 접수가 실패하면 에러 메시지를 노출한다(조용히 삼키지 않음)", async () => {
    const client = makeStub();
    vi.spyOn(client, "restartApp").mockRejectedValue(
      new ApiError("INVALID_STATE", "앱이 잠자는 중이에요. 접속 주소로 들어가면 자동으로 켜져요.", 409),
    );
    renderWithProviders(<AppDetail appId="tab-app-1" />, client);
    await screen.findByText(RUNNING.name);
    fireEvent.click(screen.getByRole("button", { name: /재시작/ }));
    expect(
      await screen.findByText("앱이 잠자는 중이에요. 접속 주소로 들어가면 자동으로 켜져요."),
    ).toBeInTheDocument();
  });

  it("재시작 실패 후에는 성공 안내(note)가 남아있지 않는다", async () => {
    const client = makeStub();
    vi.spyOn(client, "restartApp").mockRejectedValue(
      new ApiError("INVALID_STATE", "앱이 준비된 상태(정상)일 때만 다시 시작할 수 있어요.", 409),
    );
    renderWithProviders(<AppDetail appId="tab-app-1" />, client);
    await screen.findByText(RUNNING.name);
    fireEvent.click(screen.getByRole("button", { name: /재시작/ }));
    await screen.findByText("앱이 준비된 상태(정상)일 때만 다시 시작할 수 있어요.");
    expect(screen.queryByText(/다시 시작하고 있어요/)).not.toBeInTheDocument();
  });
});
