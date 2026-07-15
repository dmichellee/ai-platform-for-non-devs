import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { CreateWizard } from "../src/screens/user/CreateWizard.js";
import { renderWithProviders, seedSession, setHash } from "./harness.js";
import { MockApiClient } from "../src/mock/mockApi.js";
import type { CreateAppRequest } from "../src/lib/types.js";

/**
 * ④ 시크릿 분리 전송 — 마법사 5단계(환경변수).
 * '비밀로 보관' 토글이 켜진 항목은 secrets 로, 꺼진 항목은 envVars(평문)로 나뉘어 POST /apps body 에 실린다.
 */

// 5단계(환경변수)까지 진입.
async function gotoEnvStep(): Promise<void> {
  fireEvent.click(await screen.findByText("회사 GitHub"));
  fireEvent.change(screen.getByPlaceholderText(/https:\/\/github.com/), {
    target: { value: "https://github.com/example/x" },
  });
  fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
  await screen.findByText("앱 이름과 접속 범위를 정해주세요");
  fireEvent.change(screen.getByLabelText("앱 이름"), { target: { value: "시크릿 앱" } });
  fireEvent.change(screen.getByLabelText("접속 주소"), { target: { value: "secret-app" } });
  await screen.findByText("사용할 수 있는 주소예요");
  await waitFor(() => expect(screen.getByRole("button", { name: /다음 단계/ })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
  fireEvent.click((await screen.findAllByText(/최소 .*대/))[0]!.closest("button")!);
  fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
  await screen.findByText("어떤 기능을 사용하는 앱인가요?");
  fireEvent.click((await screen.findAllByRole("button")).find((b) => b.className.includes("choice"))!);
  fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
  await screen.findByText("앱에 전달할 설정값이 있나요?");
}

async function finishFromEnvStep(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
  await screen.findByText("앱을 언제 켜둘까요?");
  fireEvent.click(screen.getByRole("button", { name: /앱 만들기/ }));
}

describe("④ 마법사 — 시크릿/평문 분리 전송", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
    setHash("/apps/new");
  });

  it("'비밀로 보관' ON 항목은 secrets, OFF 항목은 envVars 로 나뉘어 전송된다", async () => {
    const client = new MockApiClient();
    const createSpy = vi.spyOn(client, "createApp");
    renderWithProviders(<CreateWizard />, client);
    await gotoEnvStep();

    // 첫 번째 설정값(평문): GREETING=hi
    fireEvent.click(screen.getByRole("button", { name: /설정값 추가/ }));
    let names = screen.getAllByLabelText("설정 이름");
    let values = screen.getAllByLabelText("설정 값");
    fireEvent.change(names[0]!, { target: { value: "GREETING" } });
    fireEvent.change(values[0]!, { target: { value: "hi" } });

    // 두 번째 설정값(비밀): API_KEY=sk-123 + '비밀로 보관' 토글 ON
    fireEvent.click(screen.getByRole("button", { name: /설정값 추가/ }));
    names = screen.getAllByLabelText("설정 이름");
    values = screen.getAllByLabelText("설정 값");
    fireEvent.change(names[1]!, { target: { value: "API_KEY" } });
    fireEvent.change(values[1]!, { target: { value: "sk-123" } });
    // 두 번째 행의 '비밀로 보관' 버튼 클릭
    fireEvent.click(screen.getAllByRole("button", { name: /비밀로 보관/ })[1]!);

    await finishFromEnvStep();
    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    const body = createSpy.mock.calls[0]![0] as CreateAppRequest;

    expect(body.envVars).toEqual({ GREETING: "hi" });
    expect(body.secrets).toEqual({ API_KEY: "sk-123" });
  });

  it("비밀값이 하나도 없으면 secrets 키 자체를 보내지 않는다", async () => {
    const client = new MockApiClient();
    const createSpy = vi.spyOn(client, "createApp");
    renderWithProviders(<CreateWizard />, client);
    await gotoEnvStep();

    fireEvent.click(screen.getByRole("button", { name: /설정값 추가/ }));
    fireEvent.change(screen.getAllByLabelText("설정 이름")[0]!, { target: { value: "LEVEL" } });
    fireEvent.change(screen.getAllByLabelText("설정 값")[0]!, { target: { value: "info" } });

    await finishFromEnvStep();
    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    const body = createSpy.mock.calls[0]![0] as CreateAppRequest;
    expect(body.envVars).toEqual({ LEVEL: "info" });
    expect("secrets" in body).toBe(false);
  });

  it("mockApi.patchApp: secrets/secretsRemove 로 App.secretArns 가 갱신된다", async () => {
    const client = new MockApiClient();
    // 픽스처 앱 a1b2c3d4 는 secretArns={OPENAI_API_KEY:...}. 새 키 추가 + 기존 키 삭제.
    const updated = await client.patchApp("a1b2c3d4", {
      secrets: { NEW_TOKEN: "abc" },
      secretsRemove: ["OPENAI_API_KEY"],
    });
    expect(Object.keys(updated.secretArns)).toEqual(["NEW_TOKEN"]);
    expect(updated.secretArns.NEW_TOKEN).toContain("arn:");
  });
});
