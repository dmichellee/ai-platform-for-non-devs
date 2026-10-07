import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, screen, fireEvent } from "@testing-library/react";
import { Dashboard } from "../src/screens/user/Dashboard.js";
import { AppDetail } from "../src/screens/user/AppDetail.js";
import { renderWithProviders, seedSession, setHash } from "./harness.js";
import { MockApiClient } from "../src/mock/mockApi.js";
import { ApiError } from "../src/lib/api.js";
import type { App, Deployment } from "../src/lib/types.js";
import { mockApps } from "../src/mock/fixtures.js";
import {
  applyPendingDeletes,
  markDeleting,
  resetPendingDeletesForTest,
} from "../src/lib/liveStatus.js";

/**
 * QA N6 — 대시보드·앱 상세 자동 갱신.
 * - 전이 상태(CREATING·DELETING·WAKING, 배포 진행 중)면 5초, 아니면 30초 간격으로 다시 불러온다.
 * - 탭이 숨겨지면 멈추고, 다시 보이면 즉시 한 번 불러온다.
 * - 삭제 접수 직후 카드는 서버 목록과 무관하게 "삭제 중"(낙관적 갱신), 목록에서 빠지면 사라진다.
 * 타이머는 가짜 시계로 진행시키고, stub 클라이언트는 지연 없이 즉시 응답한다.
 */

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const STABLE: App = { ...mockApps[0]!, appId: "stable01", name: "안정 앱", status: "ACTIVE", runtimeState: "RUNNING" };
const CREATING: App = { ...mockApps[0]!, appId: "creat001", name: "만드는 앱", status: "CREATING", runtimeState: "SLEEPING" };

class ListStub extends MockApiClient {
  constructor(public list: App[]) {
    super();
  }
  override async listApps(): Promise<App[]> {
    return clone(this.list);
  }
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("N6 — 대시보드 자동 갱신 주기", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    seedSession("user");
    setHash("/");
    resetPendingDeletesForTest();
    setVisibility("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
    setVisibility("visible");
  });

  it("만드는 중인 앱이 있으면 5초마다 다시 불러온다", async () => {
    const client = new ListStub([STABLE, CREATING]);
    const spy = vi.spyOn(client, "listApps");
    renderWithProviders(<Dashboard />, client);
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(1);
    await advance(4_999);
    expect(spy).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(spy).toHaveBeenCalledTimes(2);
    await advance(5_000);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("전이 상태가 없으면 30초마다 다시 불러온다(5초엔 부르지 않음)", async () => {
    const client = new ListStub([STABLE]);
    const spy = vi.spyOn(client, "listApps");
    renderWithProviders(<Dashboard />, client);
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(1);
    await advance(5_000);
    expect(spy).toHaveBeenCalledTimes(1);
    await advance(25_000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("'만드는 중' → '실행 중'이 새로고침 없이 바뀌고, 그 뒤엔 30초 주기로 느려진다", async () => {
    const client = new ListStub([CREATING]);
    const spy = vi.spyOn(client, "listApps");
    renderWithProviders(<Dashboard />, client);
    await advance(0);
    expect(screen.getByText("만드는 중")).toBeInTheDocument();
    client.list = [{ ...CREATING, status: "ACTIVE", runtimeState: "RUNNING" }];
    await advance(5_000);
    expect(screen.getByText("실행 중")).toBeInTheDocument();
    expect(screen.queryByText("만드는 중")).not.toBeInTheDocument();
    const calls = spy.mock.calls.length;
    await advance(5_000);
    expect(spy).toHaveBeenCalledTimes(calls); // 더는 5초 주기 아님
  });

  it("탭이 숨겨지면 멈추고, 다시 보이면 즉시 불러온다", async () => {
    const client = new ListStub([CREATING]);
    const spy = vi.spyOn(client, "listApps");
    renderWithProviders(<Dashboard />, client);
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(1);
    act(() => setVisibility("hidden"));
    await advance(60_000);
    expect(spy).toHaveBeenCalledTimes(1);
    act(() => setVisibility("visible"));
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("자동 갱신 중 일시 오류가 나도 카드를 지우지 않는다", async () => {
    const client = new ListStub([CREATING]);
    renderWithProviders(<Dashboard />, client);
    await advance(0);
    vi.spyOn(client, "listApps").mockRejectedValueOnce(
      new ApiError("NETWORK_ERROR", "연결이 원활하지 않아요.", 0),
    );
    await advance(5_000);
    expect(screen.getByText("만드는 앱")).toBeInTheDocument();
  });
});

describe("N6 — 삭제 낙관적 갱신", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    seedSession("user");
    resetPendingDeletesForTest();
    setVisibility("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("삭제 접수된 앱은 서버 목록이 아직 '준비됨'이어도 카드에 '삭제 중'으로 보이고, 목록에서 빠지면 사라진다", async () => {
    setHash("/");
    markDeleting(STABLE.appId);
    const client = new ListStub([STABLE]); // 서버는 아직 ACTIVE/RUNNING 을 준다(지연 반영)
    const spy = vi.spyOn(client, "listApps");
    renderWithProviders(<Dashboard />, client);
    await advance(0);
    expect(screen.getByText("안정 앱")).toBeInTheDocument();
    expect(screen.getByText("삭제 중")).toBeInTheDocument();
    expect(screen.queryByText("실행 중")).not.toBeInTheDocument();

    // 삭제 중은 전이 상태 → 5초 뒤 다시 불러온다. 서버 목록에서 빠지면 카드도 사라진다.
    client.list = [];
    await advance(5_000);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("안정 앱")).not.toBeInTheDocument();
  });

  it("앱 상세에서 삭제를 확정하면 해당 앱이 '삭제 중'으로 표시 대상에 오른다", async () => {
    vi.useRealTimers();
    setHash("/apps/a1b2c3d4");
    renderWithProviders(<AppDetail appId="a1b2c3d4" />);
    fireEvent.click(await screen.findByRole("button", { name: "삭제" }));
    fireEvent.change(screen.getByLabelText("삭제 확인 이름"), { target: { value: "고객문의 챗봇" } });
    fireEvent.click(screen.getByRole("button", { name: "삭제할게요" }));
    await vi.waitFor(() => expect(window.location.hash).toBe("#/"));
    const [shown] = applyPendingDeletes([{ ...mockApps[0]!, status: "ACTIVE" }]);
    expect(shown!.status).toBe("DELETING");
  });
});

// ── 앱 상세 헤더 상태 자동 갱신 ──
class DetailStub extends MockApiClient {
  constructor(
    public app: App,
    public deps: Deployment[],
  ) {
    super();
  }
  override async getApp(): Promise<App> {
    return clone(this.app);
  }
  override async listDeployments(): Promise<Deployment[]> {
    return clone(this.deps);
  }
}

const SUCCEEDED: Deployment = {
  appId: "stable01",
  deploymentId: "2026-10-01T00:00:00.000Z",
  trigger: "auto",
  status: "SUCCEEDED",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

describe("N6 — 앱 상세 헤더 상태 자동 갱신", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    seedSession("user");
    setHash("/apps/stable01");
    setVisibility("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("최근 배포가 진행 중이면(앱 자체는 실행 중) 5초마다 앱 상태를 다시 불러온다", async () => {
    const client = new DetailStub(STABLE, [
      { ...SUCCEEDED, deploymentId: "2026-10-02T00:00:00.000Z", status: "BUILDING" },
      SUCCEEDED,
    ]);
    const spy = vi.spyOn(client, "getApp");
    renderWithProviders(<AppDetail appId="stable01" />, client);
    await advance(0);
    const base = spy.mock.calls.length;
    await advance(5_000);
    expect(spy.mock.calls.length).toBeGreaterThan(base);
  });

  it("전이 상태가 없으면 5초엔 부르지 않고 30초에 다시 불러온다", async () => {
    const client = new DetailStub(STABLE, [SUCCEEDED]);
    const spy = vi.spyOn(client, "getApp");
    renderWithProviders(<AppDetail appId="stable01" />, client);
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(1);
    await advance(5_000);
    expect(spy).toHaveBeenCalledTimes(1);
    await advance(25_000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("깨우는 중 → 실행 중이 새로고침 없이 바뀐다", async () => {
    const client = new DetailStub({ ...STABLE, runtimeState: "WAKING" }, [SUCCEEDED]);
    renderWithProviders(<AppDetail appId="stable01" />, client);
    await advance(0);
    expect(screen.getAllByText("깨우는 중").length).toBeGreaterThan(0);
    client.app = { ...STABLE, runtimeState: "RUNNING" };
    await advance(5_000);
    expect(screen.queryByText("깨우는 중")).not.toBeInTheDocument();
    expect(screen.getAllByText("실행 중").length).toBeGreaterThan(0);
  });

  it("삭제 중이던 앱이 자동 갱신에서 404가 되면 '삭제됐어요' 안내를 보여준다", async () => {
    const client = new DetailStub({ ...STABLE, status: "DELETING" }, [SUCCEEDED]);
    renderWithProviders(<AppDetail appId="stable01" />, client);
    await advance(0);
    vi.spyOn(client, "getApp").mockRejectedValue(new ApiError("NOT_FOUND", "앱을 찾을 수 없어요.", 404));
    await advance(5_000);
    expect(screen.getByText("이 앱은 삭제됐거나 찾을 수 없어요.")).toBeInTheDocument();
  });
});
