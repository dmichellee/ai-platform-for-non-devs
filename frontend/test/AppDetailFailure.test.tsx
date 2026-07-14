import { describe, it, expect, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { AppDetail } from "../src/screens/user/AppDetail.js";
import { renderWithProviders, seedSession, setHash } from "./harness.js";
import { MockApiClient } from "../src/mock/mockApi.js";
import type { App, Deployment, LogEvent } from "../src/lib/types.js";
import { mockApps } from "../src/mock/fixtures.js";

// 특정 App 을 반환하도록 getApp 만 override 하는 stub — 실패 사유 유무 케이스를 제어한다.
class AppStub extends MockApiClient {
  constructor(private readonly app: App) {
    super();
  }
  override async getApp(): Promise<App> {
    return JSON.parse(JSON.stringify(this.app)) as App;
  }
  override async listDeployments(): Promise<Deployment[]> {
    return [];
  }
  override async getLogs(): Promise<{ events: LogEvent[] }> {
    return { events: [] };
  }
}

const BASE: App = { ...mockApps[0]!, appId: "failtest0" };

describe("앱 상세 — 프로비저닝 실패 사유 노출 (UX 갭 해소)", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
    setHash("/apps/failtest0");
  });

  it("status=FAILED + failureReason 이면 구체 사유를 보여준다", async () => {
    const reason = "배포 준비(빌드 환경 구성) 중 문제가 발생했어요. 다시 시도하거나 관리자에게 문의해주세요.";
    const app: App = { ...BASE, status: "FAILED", failureReason: reason };
    renderWithProviders(<AppDetail appId="failtest0" />, new AppStub(app));

    expect(await screen.findByText(reason)).toBeInTheDocument();
    // 다시 만들기(삭제 후 재생성) 안내를 함께 보여준다.
    expect(screen.getByText(/다시 만들어주세요/)).toBeInTheDocument();
  });

  it("failureReason 이 있으면 중립적 statusHint 로 대체되지 않는다", async () => {
    const reason = "첫 배포를 시작하지 못했어요. 다시 시도하거나 관리자에게 문의해주세요.";
    const app: App = { ...BASE, status: "FAILED", failureReason: reason };
    renderWithProviders(<AppDetail appId="failtest0" />, new AppStub(app));

    await screen.findByText(reason);
    // 중립 안내(statusHint FAILED)는 노출되지 않는다.
    expect(
      screen.queryByText(/자세한 내용은 배포 이력을 확인하거나 관리자에게 문의/),
    ).not.toBeInTheDocument();
  });

  it("failureReason 이 없는 FAILED 는 기존 중립 statusHint 로 폴백한다", async () => {
    const app: App = { ...BASE, status: "FAILED" };
    renderWithProviders(<AppDetail appId="failtest0" />, new AppStub(app));

    expect(
      await screen.findByText(/자세한 내용은 배포 이력을 확인하거나 관리자에게 문의/),
    ).toBeInTheDocument();
  });

  it("ACTIVE 앱은 실패 사유 안내를 보여주지 않는다", async () => {
    const app: App = {
      ...BASE,
      status: "ACTIVE",
      runtimeState: "RUNNING",
      // 잔재 방지 검증: 백엔드가 성공 시 지우므로 정상 응답엔 없지만, 방어적으로 status 게이트도 확인.
      failureReason: "이건 안 보여야 함",
    };
    renderWithProviders(<AppDetail appId="failtest0" />, new AppStub(app));

    await screen.findByText(BASE.name);
    expect(screen.queryByText("이건 안 보여야 함")).not.toBeInTheDocument();
  });
});
