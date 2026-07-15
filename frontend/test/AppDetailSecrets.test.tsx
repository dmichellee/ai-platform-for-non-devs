import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { AppDetail } from "../src/screens/user/AppDetail.js";
import { renderWithProviders, seedSession, setHash } from "./harness.js";
import { MockApiClient } from "../src/mock/mockApi.js";
import type { App, Deployment, LogEvent, PatchAppRequest } from "../src/lib/types.js";
import { mockApps } from "../src/mock/fixtures.js";

/**
 * ④ 앱 상세 설정 탭 — 비밀값(시크릿) 관리.
 * - 기존 비밀값은 KEY 목록만 표시(값 비노출) + "다시 볼 수 없어요" 안내.
 * - 새 값 입력 시 교체(secrets), 삭제 표시 시 제거(secretsRemove).
 * - 새 비밀값 추가.
 */

class SettingsStub extends MockApiClient {
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

// secretArns 에 기존 비밀값 2개를 가진 RUNNING 앱.
const APP: App = {
  ...mockApps[0]!,
  appId: "sec-detail-1",
  status: "ACTIVE",
  runtimeState: "RUNNING",
  envVars: { GREETING: "hi" },
  secretArns: {
    OPENAI_API_KEY: "arn:mock:secret/x/OPENAI_API_KEY",
    DB_PASSWORD: "arn:mock:secret/x/DB_PASSWORD",
  },
};

async function openSettings(client: MockApiClient): Promise<void> {
  setHash("/apps/sec-detail-1?tab=settings");
  renderWithProviders(<AppDetail appId="sec-detail-1" />, client);
  await screen.findByText(APP.name);
  fireEvent.click(screen.getByRole("tab", { name: "설정" }));
  await screen.findByText("비밀 설정값");
}

describe("④ 앱 상세 설정 — 비밀값 관리", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
  });

  it("기존 secretArns 키 목록을 이름으로 보여주고 값은 보이지 않는다", async () => {
    await openSettings(new SettingsStub(APP));
    // 키 이름은 readonly input value 로 노출
    expect(screen.getByDisplayValue("OPENAI_API_KEY")).toBeInTheDocument();
    expect(screen.getByDisplayValue("DB_PASSWORD")).toBeInTheDocument();
    // "다시 볼 수 없어요" 안내
    expect(screen.getByText(/다시 볼 수 없어요/)).toBeInTheDocument();
    // 값 입력은 password 타입(값 자체는 노출 안 됨)
    const valInput = screen.getByLabelText("OPENAI_API_KEY 새 값") as HTMLInputElement;
    expect(valInput.type).toBe("password");
    expect(valInput.value).toBe("");
  });

  it("기존 비밀값에 새 값을 입력하면 secrets 로 교체 전송된다", async () => {
    const client = new SettingsStub(APP);
    const patchSpy = vi.spyOn(client, "patchApp");
    await openSettings(client);

    fireEvent.change(screen.getByLabelText("OPENAI_API_KEY 새 값"), { target: { value: "sk-new" } });
    fireEvent.click(screen.getByRole("button", { name: /변경 사항 저장/ }));
    await waitFor(() => expect(patchSpy).toHaveBeenCalled());
    const body = patchSpy.mock.calls.at(-1)![1] as PatchAppRequest;
    expect(body.secrets).toEqual({ OPENAI_API_KEY: "sk-new" });
    expect(body.secretsRemove ?? []).not.toContain("OPENAI_API_KEY");
  });

  it("기존 비밀값 삭제 표시 시 secretsRemove 로 전송된다", async () => {
    const client = new SettingsStub(APP);
    const patchSpy = vi.spyOn(client, "patchApp");
    await openSettings(client);

    fireEvent.click(screen.getByRole("button", { name: "DB_PASSWORD 삭제" }));
    fireEvent.click(screen.getByRole("button", { name: /변경 사항 저장/ }));
    await waitFor(() => expect(patchSpy).toHaveBeenCalled());
    const body = patchSpy.mock.calls.at(-1)![1] as PatchAppRequest;
    expect(body.secretsRemove).toEqual(["DB_PASSWORD"]);
  });

  it("새 비밀값을 추가하면 secrets 로 전송된다(평문 envVars 와 분리)", async () => {
    const client = new SettingsStub(APP);
    const patchSpy = vi.spyOn(client, "patchApp");
    await openSettings(client);

    fireEvent.click(screen.getByRole("button", { name: /비밀 설정값 추가/ }));
    fireEvent.change(screen.getByLabelText("새 비밀값 이름"), { target: { value: "WEBHOOK_SECRET" } });
    fireEvent.change(screen.getByLabelText("새 비밀값 값"), { target: { value: "whsec_1" } });
    fireEvent.click(screen.getByRole("button", { name: /변경 사항 저장/ }));
    await waitFor(() => expect(patchSpy).toHaveBeenCalled());
    const body = patchSpy.mock.calls.at(-1)![1] as PatchAppRequest;
    expect(body.secrets).toEqual({ WEBHOOK_SECRET: "whsec_1" });
    // 평문 설정값(GREETING)은 envVars 로 그대로 유지
    expect(body.envVars).toEqual({ GREETING: "hi" });
  });

  it("환경변수 행의 이름/값 칸에 안내 placeholder가 마법사와 동일 문구로 있다", async () => {
    // 버그: 이름/값 칸에 placeholder가 없어 '정체불명의 빈 칸'으로 보였음.
    // 이름 칸은 마법사(StepEnv)와 동일한 "이름 (예: API_KEY)", 값 칸은 "값".
    await openSettings(new SettingsStub(APP));
    const nameInput = screen.getByLabelText("설정 이름") as HTMLInputElement;
    const valueInput = screen.getByLabelText("설정 값") as HTMLInputElement;
    expect(nameInput.placeholder).toBe("이름 (예: API_KEY)");
    expect(valueInput.placeholder).toBe("값");
    // 한 줄 나란히 배치되도록 kv-row/kv-key/kv-value 클래스가 붙어 있다.
    expect(nameInput.closest(".kv-row")).not.toBeNull();
    expect(nameInput.classList.contains("kv-key")).toBe(true);
    expect(valueInput.classList.contains("kv-value")).toBe(true);
  });

  it("새 비밀값 행 입력칸이 한 줄 배치(kv-row)로 렌더된다", async () => {
    await openSettings(new SettingsStub(APP));
    fireEvent.click(screen.getByRole("button", { name: /비밀 설정값 추가/ }));
    const secretNameInput = screen.getByLabelText("새 비밀값 이름") as HTMLInputElement;
    const secretValueInput = screen.getByLabelText("새 비밀값 값") as HTMLInputElement;
    expect(secretNameInput.closest(".kv-row")).not.toBeNull();
    expect(secretNameInput.classList.contains("kv-key")).toBe(true);
    expect(secretValueInput.classList.contains("kv-value")).toBe(true);
  });

  it("비밀값을 건드리지 않으면 secrets/secretsRemove 키를 보내지 않는다", async () => {
    const client = new SettingsStub(APP);
    const patchSpy = vi.spyOn(client, "patchApp");
    await openSettings(client);

    // 평문만 바꿔 저장을 트리거(dirty 되게).
    fireEvent.change(screen.getByLabelText("설정 값"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: /변경 사항 저장/ }));
    await waitFor(() => expect(patchSpy).toHaveBeenCalled());
    const body = patchSpy.mock.calls.at(-1)![1] as PatchAppRequest;
    expect("secrets" in body).toBe(false);
    expect("secretsRemove" in body).toBe(false);
  });
});
