import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, screen, fireEvent } from "@testing-library/react";
import { AppDetail } from "../src/screens/user/AppDetail.js";
import { renderWithProviders, seedSession, setHash } from "./harness.js";
import { MockApiClient } from "../src/mock/mockApi.js";
import { ApiError } from "../src/lib/api.js";
import type { App, Deployment, LogEvent } from "../src/lib/types.js";
import { mockApps } from "../src/mock/fixtures.js";

/**
 * QA F2 — 앱 실행 로그 자동 새로고침은 증분(startTime=최신 줄+1)·10초 주기·429 시 30초 백오프.
 * QA F7 — 배포 이력 탭에서 listDeployments 를 루트 한 곳만 폴링한다.
 */

const T0 = Date.now();
const RUNNING: App = { ...mockApps[0]!, appId: "inc-app1", status: "ACTIVE", runtimeState: "RUNNING" };

type LogsOpts = { limit?: number; nextToken?: string; startTime?: number };

class IncStub extends MockApiClient {
  /** 호출 순서대로 응답(또는 throw)할 큐. 비면 빈 결과. */
  queue: Array<{ events: LogEvent[]; nextToken?: string } | Error> = [];
  calls: LogsOpts[] = [];
  override async getApp(): Promise<App> {
    return JSON.parse(JSON.stringify(RUNNING)) as App;
  }
  override async listDeployments(): Promise<Deployment[]> {
    return [];
  }
  override async getLogs(_appId: string, opts?: LogsOpts): Promise<{ events: LogEvent[]; nextToken?: string }> {
    this.calls.push({ ...opts });
    const next = this.queue.shift();
    if (next instanceof Error) throw next;
    return next ?? { events: [] };
  }
}

async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function openLogs(client: IncStub): Promise<void> {
  setHash("/apps/inc-app1?tab=deployments");
  renderWithProviders(<AppDetail appId="inc-app1" />, client);
  await tick(0);
  fireEvent.click(screen.getByRole("button", { name: /실행 로그 보기/ }));
  await tick(0);
}

function lineTexts(): string[] {
  return Array.from(document.querySelectorAll(".log-line")).map((el) => el.textContent ?? "");
}

describe("F2 — 앱 실행 로그 증분 새로고침", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    seedSession("user");
  });
  afterEach(() => vi.useRealTimers());

  it("첫 조회는 startTime 없이, 이후는 최신 줄 시각+1 을 startTime 으로 보내고 새 줄을 위에 합친다(중복 없음)", async () => {
    const client = new IncStub();
    client.queue.push(
      { events: [{ timestamp: T0, message: "A" }, { timestamp: T0 - 1_000, message: "B" }] },
      // 서버가 경계 줄을 다시 줘도 화면엔 한 번만
      { events: [{ timestamp: T0 + 2_000, message: "C" }, { timestamp: T0, message: "A" }] },
      { events: [{ timestamp: T0 + 5_000, message: "D" }] },
    );
    await openLogs(client);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.startTime).toBeUndefined();

    await tick(10_000);
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]!.startTime).toBe(T0 + 1);
    expect(lineTexts().map((t) => t.slice(-1))).toEqual(["C", "A", "B"]);

    await tick(10_000);
    expect(client.calls).toHaveLength(3);
    expect(client.calls[2]!.startTime).toBe(T0 + 2_001);
    expect(lineTexts().map((t) => t.slice(-1))).toEqual(["D", "C", "A", "B"]);
  });

  it("갱신 주기는 10초(5초 시점엔 요청 없음)", async () => {
    const client = new IncStub();
    client.queue.push({ events: [{ timestamp: T0, message: "A" }] });
    await openLogs(client);
    await tick(9_900);
    expect(client.calls).toHaveLength(1);
    await tick(200);
    expect(client.calls).toHaveLength(2);
    expect(screen.getByText(/자동 새로고침 \(10초\)/)).toBeInTheDocument();
  });

  it("429 를 받으면 안내를 띄우고 다음 갱신을 30초 뒤로 늦춘다, 성공하면 안내가 사라진다", async () => {
    const client = new IncStub();
    client.queue.push(
      { events: [{ timestamp: T0, message: "A" }] },
      new ApiError("RATE_LIMITED", "요청이 많아요.", 429),
      { events: [{ timestamp: T0 + 1_000, message: "B" }] },
    );
    await openLogs(client);
    await tick(10_000);
    expect(client.calls).toHaveLength(2);
    expect(screen.getByText(/잠시 뒤 다시 불러올게요/)).toBeInTheDocument();
    // 기존 로그는 그대로
    expect(lineTexts()).toHaveLength(1);

    await tick(20_000); // 10초 주기라면 이미 불렀을 시점
    expect(client.calls).toHaveLength(2);
    await tick(10_100); // 30초 경과
    expect(client.calls).toHaveLength(3);
    expect(client.calls[2]!.startTime).toBe(T0 + 1);
    expect(screen.queryByText(/잠시 뒤 다시 불러올게요/)).not.toBeInTheDocument();
    expect(lineTexts()).toHaveLength(2);
  });

  it("자동 새로고침을 끄면 더 부르지 않는다", async () => {
    const client = new IncStub();
    client.queue.push({ events: [{ timestamp: T0, message: "A" }] });
    await openLogs(client);
    fireEvent.click(screen.getByRole("switch", { name: "자동 새로고침" }));
    await tick(60_000);
    expect(client.calls).toHaveLength(1);
  });
});

describe("F7 — 배포 이력 탭의 배포 목록 폴링은 한 곳에서만", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    seedSession("user");
  });
  afterEach(() => vi.useRealTimers());

  it("배포 이력 탭을 열어도 listDeployments 는 주기당 1회", async () => {
    const client = new IncStub();
    const spy = vi.spyOn(client, "listDeployments");
    setHash("/apps/inc-app1?tab=deployments");
    renderWithProviders(<AppDetail appId="inc-app1" />, client);
    await tick(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/아직 배포 기록이 없어요/)).toBeInTheDocument();
    await tick(30_000); // 안정 상태 주기
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
