import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { AppDetail } from "../src/screens/user/AppDetail.js";
import { renderWithProviders, seedSession, setHash } from "./harness.js";
import { MockApiClient } from "../src/mock/mockApi.js";
import { ApiError } from "../src/lib/api.js";
import type {
  App,
  Deployment,
  LogEvent,
  PatchAppRequest,
  PatchAppResponse,
  RedeployResult,
} from "../src/lib/types.js";
import { mockApps } from "../src/mock/fixtures.js";

/**
 * ④ 앱 상세 설정 탭 — 비밀값(시크릿) 관리.
 * - 기존 비밀값은 KEY 목록만 표시(값 비노출) + "다시 볼 수 없어요" 안내.
 * - 새 값 입력 시 교체(secrets), 삭제 표시 시 제거(secretsRemove).
 * - 새 비밀값 추가.
 */

class SettingsStub extends MockApiClient {
  listCalls = 0;
  constructor(
    private readonly app: App,
    // 시크릿 변경 PATCH 응답의 redeploy(D8). null 이면 필드 없음. ApiError 면 그 에러로 실패.
    private readonly patchOutcome: RedeployResult | ApiError | null = null,
  ) {
    super();
  }
  override async patchApp(_appId: string, b: PatchAppRequest): Promise<PatchAppResponse> {
    if (this.patchOutcome instanceof ApiError) throw this.patchOutcome;
    const keys = new Set(this.app.secretKeys);
    for (const k of Object.keys(b.secrets ?? {})) keys.add(k);
    for (const k of b.secretsRemove ?? []) keys.delete(k);
    const updated: App = { ...this.app, secretKeys: [...keys], envVars: b.envVars ?? this.app.envVars };
    const changed = Object.keys(b.secrets ?? {}).length > 0 || (b.secretsRemove ?? []).length > 0;
    return changed && this.patchOutcome ? { ...updated, redeploy: this.patchOutcome } : updated;
  }
  override async getApp(): Promise<App> {
    return JSON.parse(JSON.stringify(this.app)) as App;
  }
  deps: Deployment[] = [];
  override async listDeployments(): Promise<Deployment[]> {
    this.listCalls += 1;
    return this.deps;
  }
  override async getLogs(): Promise<{ events: LogEvent[] }> {
    return { events: [] };
  }
}

// secretKeys 에 기존 비밀값 2개를 가진 RUNNING 앱.
const APP: App = {
  ...mockApps[0]!,
  appId: "sec-detail-1",
  status: "ACTIVE",
  runtimeState: "RUNNING",
  envVars: { GREETING: "hi" },
  secretKeys: ["OPENAI_API_KEY", "DB_PASSWORD"],
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

  it("기존 secretKeys 키 목록을 이름으로 보여주고 값은 보이지 않는다", async () => {
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
    fireEvent.click(await screen.findByRole("button", { name: /다시 배포하고 저장/ }));
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
    fireEvent.click(await screen.findByRole("button", { name: /다시 배포하고 저장/ }));
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
    fireEvent.click(await screen.findByRole("button", { name: /다시 배포하고 저장/ }));
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

/**
 * D8 — 비밀값 변경 저장 = 즉시 재배포.
 * 저장 전 확인 모달, 취소 시 요청 없음, 승인 시 PATCH, 무변경 시 모달 없음, 결과(PENDING/SKIPPED/409) 안내.
 */
describe("D8 비밀값 변경 시 확인 후 재배포", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
  });

  async function changeSecretAndClickSave(): Promise<void> {
    fireEvent.change(screen.getByLabelText("OPENAI_API_KEY 새 값"), { target: { value: "sk-new" } });
    fireEvent.click(screen.getByRole("button", { name: /변경 사항 저장/ }));
  }

  it("비밀값을 바꾸고 저장하면 재배포 확인 모달이 뜬다(아직 요청 안 보냄)", async () => {
    const client = new SettingsStub(APP);
    const patchSpy = vi.spyOn(client, "patchApp");
    await openSettings(client);
    await changeSecretAndClickSave();

    const dialog = await screen.findByRole("dialog", { name: "앱을 다시 배포할까요?" });
    expect(dialog).toHaveTextContent("비밀 값을 바꾸면 앱이 다시 배포돼요");
    expect(dialog).toHaveTextContent("몇 분 동안 앱이 재시작될 수 있어요");
    // 어떤 비밀값이 바뀌는지 이름만 요약(값은 노출 안 함)
    expect(dialog).toHaveTextContent("OPENAI_API_KEY");
    expect(dialog).not.toHaveTextContent("sk-new");
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it("모달에서 취소하면 PATCH 를 보내지 않고 모달이 닫힌다", async () => {
    const client = new SettingsStub(APP);
    const patchSpy = vi.spyOn(client, "patchApp");
    await openSettings(client);
    await changeSecretAndClickSave();

    fireEvent.click(await screen.findByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(patchSpy).not.toHaveBeenCalled();
    // 입력은 그대로 남아 다시 저장할 수 있다.
    expect((screen.getByLabelText("OPENAI_API_KEY 새 값") as HTMLInputElement).value).toBe("sk-new");
  });

  it("삭제 표시만 해도(값 입력 없이) 확인 모달이 뜬다", async () => {
    const client = new SettingsStub(APP);
    const patchSpy = vi.spyOn(client, "patchApp");
    await openSettings(client);
    fireEvent.click(screen.getByRole("button", { name: "DB_PASSWORD 삭제" }));
    fireEvent.click(screen.getByRole("button", { name: /변경 사항 저장/ }));
    const dialog = await screen.findByRole("dialog", { name: "앱을 다시 배포할까요?" });
    expect(dialog).toHaveTextContent("DB_PASSWORD");
    expect(dialog).toHaveTextContent("삭제");
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it("승인하면 PATCH 를 보내고, PENDING 이면 '다시 배포를 시작했어요' + 배포 목록을 다시 불러온다", async () => {
    const client = new SettingsStub(APP, { status: "PENDING", deploymentId: "2026-10-05T00:00:00Z" });
    const patchSpy = vi.spyOn(client, "patchApp");
    await openSettings(client);
    await waitFor(() => expect(client.listCalls).toBeGreaterThan(0));
    const before = client.listCalls;
    await changeSecretAndClickSave();
    fireEvent.click(await screen.findByRole("button", { name: /다시 배포하고 저장/ }));

    await waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/다시 배포를 시작했어요/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // 상단 배지/첫 배포 판정용 배포 목록 재조회
    await waitFor(() => expect(client.listCalls).toBeGreaterThan(before));
    // 배포 이력 탭으로 이동하는 바로가기
    fireEvent.click(screen.getByRole("button", { name: /배포 이력에서 진행 상황 보기/ }));
    await waitFor(() => expect(window.location.hash).toContain("tab=deployments"));
  });

  it("SKIPPED(NOT_DEPLOYED)면 '첫 배포 때 적용돼요' 안내", async () => {
    const client = new SettingsStub(APP, { status: "SKIPPED", reason: "NOT_DEPLOYED" });
    await openSettings(client);
    await changeSecretAndClickSave();
    fireEvent.click(await screen.findByRole("button", { name: /다시 배포하고 저장/ }));
    expect(await screen.findByText(/첫 배포 때 적용돼요/)).toBeInTheDocument();
    expect(screen.queryByText(/다시 배포를 시작했어요/)).not.toBeInTheDocument();
  });

  it("배포 진행 중 409 면 서버 안내 문구를 그대로 보여준다", async () => {
    const msg = "지금 배포가 진행 중이에요. 배포가 끝난 뒤 비밀 값을 다시 저장해 주세요.";
    const client = new SettingsStub(APP, new ApiError("INVALID_STATE", msg, 409));
    await openSettings(client);
    await changeSecretAndClickSave();
    fireEvent.click(await screen.findByRole("button", { name: /다시 배포하고 저장/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(msg);
    expect(screen.queryByText(/다시 배포를 시작했어요/)).not.toBeInTheDocument();
  });

  it("비밀값 무변경 저장은 모달 없이 바로 PATCH 를 보낸다", async () => {
    const client = new SettingsStub(APP);
    const patchSpy = vi.spyOn(client, "patchApp");
    await openSettings(client);
    fireEvent.change(screen.getByLabelText("설정 값"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: /변경 사항 저장/ }));
    await waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(/다시 배포를 시작했어요/)).not.toBeInTheDocument();
  });

  it("설정값(환경변수)은 다음 배포부터 적용된다는 안내가 있다", async () => {
    await openSettings(new SettingsStub(APP));
    expect(screen.getByText(/다음 배포부터/)).toBeInTheDocument();
  });

  it("SKIPPED(IMAGE_NOT_FOUND)면 저장은 됐다는 경고 톤 + '지금 배포' 안내", async () => {
    const client = new SettingsStub(APP, { status: "SKIPPED", reason: "IMAGE_NOT_FOUND" });
    await openSettings(client);
    await changeSecretAndClickSave();
    fireEvent.click(await screen.findByRole("button", { name: /다시 배포하고 저장/ }));
    const notice = (await screen.findByText(/저장은 됐지만/)).closest(".notice");
    expect(notice).toHaveClass("warn");
    expect(notice).toHaveTextContent("'지금 배포'");
    expect(screen.queryByText(/다시 배포를 시작했어요/)).not.toBeInTheDocument();
  });

  it("SKIPPED(START_FAILED)도 경고 톤 + '지금 배포' 안내", async () => {
    const client = new SettingsStub(APP, { status: "SKIPPED", reason: "START_FAILED" });
    await openSettings(client);
    await changeSecretAndClickSave();
    fireEvent.click(await screen.findByRole("button", { name: /다시 배포하고 저장/ }));
    const notice = (await screen.findByText(/저장은 됐지만/)).closest(".notice");
    expect(notice).toHaveClass("warn");
    expect(notice).toHaveTextContent("'지금 배포'");
  });

  it("서버가 note 를 주면 기본 문구 대신 note 를 그대로 보여준다", async () => {
    const note = "비밀 값을 저장했지만 지금 버전을 찾지 못했어요. '지금 배포'를 눌러주세요.";
    const client = new SettingsStub(APP, { status: "SKIPPED", reason: "IMAGE_NOT_FOUND", note });
    await openSettings(client);
    await changeSecretAndClickSave();
    fireEvent.click(await screen.findByRole("button", { name: /다시 배포하고 저장/ }));
    expect(await screen.findByText(note)).toBeInTheDocument();
    expect(screen.queryByText(/지금 버전으로 바로 다시 배포하지 못했어요/)).not.toBeInTheDocument();
  });

  it("동시 수정 충돌 409 CONFLICT 도 서버 안내 문구를 그대로 보여준다", async () => {
    const msg = "다른 곳에서 이 앱의 설정이 먼저 바뀌었어요. 새로고침한 뒤 다시 저장해 주세요.";
    const client = new SettingsStub(APP, new ApiError("CONFLICT", msg, 409));
    await openSettings(client);
    await changeSecretAndClickSave();
    fireEvent.click(await screen.findByRole("button", { name: /다시 배포하고 저장/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(msg);
  });

  it("CONFLICT 에 message 가 비어도 친절한 기본 문구로 안내한다", async () => {
    const client = new SettingsStub(APP, new ApiError("CONFLICT", "", 409));
    await openSettings(client);
    await changeSecretAndClickSave();
    fireEvent.click(await screen.findByRole("button", { name: /다시 배포하고 저장/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/먼저 바뀌었어요/);
  });

  it("배포 이력에서 secret-change 배포는 '비밀 값 변경'으로 표시된다", async () => {
    const client = new SettingsStub(APP);
    client.deps = [
      {
        appId: APP.appId,
        deploymentId: "2026-10-05T01:00:00Z",
        commitSha: "abc1234",
        commitMessage: "비밀 설정값 변경 적용",
        trigger: "secret-change",
        status: "PENDING",
        createdAt: "2026-10-05T01:00:00Z",
        updatedAt: "2026-10-05T01:00:00Z",
      },
    ];
    setHash("/apps/sec-detail-1?tab=deployments");
    renderWithProviders(<AppDetail appId="sec-detail-1" />, client);
    expect(await screen.findByText(/비밀 값 변경 · abc1234/)).toBeInTheDocument();
  });
});
