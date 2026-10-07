import { describe, it, expect, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { AppDetail } from "../src/screens/user/AppDetail.js";
import { renderWithProviders, seedSession, setHash } from "./harness.js";
import { MockApiClient } from "../src/mock/mockApi.js";
import type { App, PatchAppRequest, PatchAppResponse } from "../src/lib/types.js";
import { mockApps } from "../src/mock/fixtures.js";
import { AUTO_DEPLOY_APPLYING_TITLE } from "../src/lib/labels.js";

/**
 * QA M4 — 설정 탭 자동 배포 토글 저장 결과 안내.
 * PATCH 응답 autoDeploy:{status:"APPLYING"|"SKIPPED", note}
 *  - APPLYING: 정보 톤 "적용 중 — 몇 분 뒤 반영" + note, 개요의 "켜짐 (코드 올리면 자동 배포)" → "적용 중…"
 *  - SKIPPED: 경고 톤 + note
 */

class PatchStub extends MockApiClient {
  constructor(
    private app: App,
    private readonly autoDeploy: PatchAppResponse["autoDeploy"],
  ) {
    super();
  }
  override async getApp(): Promise<App> {
    return JSON.parse(JSON.stringify(this.app)) as App;
  }
  override async patchApp(_id: string, b: PatchAppRequest): Promise<PatchAppResponse> {
    // ALREADY_APPLYING 은 이번 변경을 저장하지 않는다(계약) — 응답 autoDeployEnabled 는 기존 값.
    const rejected = this.autoDeploy?.status === "SKIPPED" && this.autoDeploy.reason === "ALREADY_APPLYING";
    if (b.autoDeployEnabled !== undefined && !rejected)
      this.app = { ...this.app, autoDeployEnabled: b.autoDeployEnabled };
    const res: PatchAppResponse = JSON.parse(JSON.stringify(this.app)) as App;
    return this.autoDeploy ? { ...res, autoDeploy: this.autoDeploy } : res;
  }
}

async function toggleAndSave(): Promise<void> {
  fireEvent.click(await screen.findByRole("switch", { name: "자동 배포" }));
  fireEvent.click(screen.getByRole("button", { name: "변경 사항 저장" }));
}

describe("M4 — 자동 배포 토글 저장 안내", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
  });

  it("APPLYING: 정보 톤으로 '적용 중 — 몇 분 뒤 반영'과 서버 note 를 보여주고, 개요는 '적용 중…'", async () => {
    const app: App = { ...mockApps[0]!, appId: "m4-apply1", autoDeployEnabled: false };
    const note = "자동 배포 설정을 적용하고 있어요. 몇 분 뒤부터 반영돼요.";
    const client = new PatchStub(app, { status: "APPLYING", note });
    setHash("/apps/m4-apply1?tab=settings");
    renderWithProviders(<AppDetail appId="m4-apply1" />, client);
    await toggleAndSave();

    const title = await screen.findByText(AUTO_DEPLOY_APPLYING_TITLE);
    const box = title.closest(".notice")!;
    expect(box.className).toContain("info");
    expect(box.textContent).toContain(note);

    // 개요 탭: "켜짐 (코드 올리면 자동 배포)" 대신 "적용 중…"
    fireEvent.click(screen.getByRole("tab", { name: /개요/ }));
    expect(await screen.findByText("적용 중…")).toBeInTheDocument();
    expect(screen.queryByText("켜짐 (코드 올리면 자동 배포)")).not.toBeInTheDocument();
  });

  it("SKIPPED(NOT_READY): 경고 톤으로 서버 note 를 보여주고 개요는 '적용 중…'으로 바꾸지 않는다", async () => {
    const app: App = { ...mockApps[0]!, appId: "m4-skip01", autoDeployEnabled: false };
    const note = "앱이 아직 준비되지 않아 자동 배포 설정을 바로 적용하지 못했어요.";
    const client = new PatchStub(app, { status: "SKIPPED", reason: "NOT_READY", note });
    setHash("/apps/m4-skip01?tab=settings");
    renderWithProviders(<AppDetail appId="m4-skip01" />, client);
    await toggleAndSave();

    const msg = await screen.findByText(note);
    expect(msg.closest(".notice")!.className).toContain("warn");
    expect(screen.queryByText(AUTO_DEPLOY_APPLYING_TITLE)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /개요/ }));
    expect(await screen.findByText("켜짐 (코드 올리면 자동 배포)")).toBeInTheDocument();
  });

  it("SKIPPED(ALREADY_APPLYING): 이번 변경은 저장되지 않아 토글이 기존 값으로 되돌아가고, 적용 중 표시는 유지", async () => {
    const app: App = { ...mockApps[0]!, appId: "m4-busy01", autoDeployEnabled: true };
    const note = "이전 자동 배포 설정을 적용하는 중이라 이번 변경은 저장하지 않았어요. 몇 분 뒤 다시 바꿔 주세요.";
    const client = new PatchStub(app, { status: "SKIPPED", reason: "ALREADY_APPLYING", note });
    setHash("/apps/m4-busy01?tab=settings");
    renderWithProviders(<AppDetail appId="m4-busy01" />, client);
    const sw = await screen.findByRole("switch", { name: "자동 배포" });
    expect(sw).toHaveAttribute("aria-checked", "true");
    await toggleAndSave();
    const msg = await screen.findByText(note);
    expect(msg.closest(".notice")!.className).toContain("warn");
    // 서버 값(true)으로 되돌아온다
    expect(screen.getByRole("switch", { name: "자동 배포" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("tab", { name: /개요/ }));
    expect(await screen.findByText("적용 중…")).toBeInTheDocument();
  });

  it("autoDeploy 가 없는 응답(다른 설정만 변경)에서는 안내를 띄우지 않는다", async () => {
    const app: App = { ...mockApps[0]!, appId: "m4-none01" };
    const client = new PatchStub(app, undefined);
    setHash("/apps/m4-none01?tab=settings");
    renderWithProviders(<AppDetail appId="m4-none01" />, client);
    fireEvent.click(await screen.findByRole("button", { name: /항상 켜두기/ }));
    fireEvent.click(screen.getByRole("button", { name: "변경 사항 저장" }));
    await screen.findByRole("button", { name: "변경 사항 저장" });
    expect(screen.queryByText(AUTO_DEPLOY_APPLYING_TITLE)).not.toBeInTheDocument();
  });

  it("목 API: 자동 배포 토글을 바꾸면 PATCH 응답에 autoDeploy APPLYING 이 온다", async () => {
    const client = new MockApiClient();
    const res = await client.patchApp("a1b2c3d4", { autoDeployEnabled: false });
    expect(res.autoDeploy?.status).toBe("APPLYING");
    const same = await client.patchApp("a1b2c3d4", { autoDeployEnabled: false });
    expect(same.autoDeploy).toBeUndefined();
  });
});
