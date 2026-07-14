import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { AdminPresets } from "../src/screens/admin/AdminPresets.js";
import { AdminPermTemplates } from "../src/screens/admin/AdminPermTemplates.js";
import { renderWithProviders, seedSession } from "./harness.js";
import { MockApiClient } from "../src/mock/mockApi.js";

/**
 * 이슈 2(치명) 회귀 방지 — 프리셋/권한템플릿 **신규 생성** 시 식별자 키를 body 에서 제거한다.
 * 원인: FormModal 이 `{presetId:"", …}` 전체를 보내 백엔드 빈ID 방어(VALIDATION_ERROR)에 걸림.
 * 계약: create 는 presetId/permId **키 자체를 생략**하면 서버가 자동 발급.
 */

describe("이슈 2 — 프리셋 신규 생성 body 에 presetId 키가 없다", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("admin");
  });

  it("프리셋 추가 저장 시 adminCreatePreset body 에 presetId 키가 포함되지 않는다", async () => {
    const client = new MockApiClient();
    const createSpy = vi.spyOn(client, "adminCreatePreset");
    renderWithProviders(<AdminPresets />, client);

    // 추가 모달 열기 → 표시명 입력 → 저장
    fireEvent.click(await screen.findByRole("button", { name: /프리셋 추가/ }));
    fireEvent.change(await screen.findByLabelText("표시명 (사용자에게 보임)"), {
      target: { value: "보통" },
    });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    const body = createSpy.mock.calls[0]![0];
    expect(Object.prototype.hasOwnProperty.call(body, "presetId")).toBe(false);
  });

  it("빈 식별자 키가 담기면 mock 이 계약대로 거부한다(VALIDATION_ERROR)", async () => {
    const client = new MockApiClient();
    // 계약 정합 확인: presetId 키가 있고 빈 문자열이면 400.
    await expect(
      client.adminCreatePreset({ presetId: "", displayName: "x", cpu: 512, memory: 1024 }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    // 키를 생략하면 서버가 자동 발급 → 성공.
    const ok = await client.adminCreatePreset({ displayName: "자동발급", cpu: 512, memory: 1024 });
    expect(typeof ok.presetId).toBe("string");
    expect(ok.presetId.length).toBeGreaterThan(0);
  });
});

describe("이슈 2 — 권한 템플릿 신규 생성 body 에 permId 키가 없다", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("admin");
  });

  it("템플릿 추가 저장 시 adminCreatePermTemplate body 에 permId 키가 포함되지 않는다", async () => {
    const client = new MockApiClient();
    const createSpy = vi.spyOn(client, "adminCreatePermTemplate");
    renderWithProviders(<AdminPermTemplates />, client);

    fireEvent.click(await screen.findByRole("button", { name: /템플릿 추가/ }));
    fireEvent.change(await screen.findByLabelText(/표시명/), { target: { value: "AI 기능 사용" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    const body = createSpy.mock.calls[0]![0];
    expect(Object.prototype.hasOwnProperty.call(body, "permId")).toBe(false);
    expect(body).toHaveProperty("displayName", "AI 기능 사용");
  });

  it("빈 permId 키가 담기면 mock 이 거부하고, 생략하면 자동 발급된다", async () => {
    const client = new MockApiClient();
    await expect(
      // @ts-expect-error 계약 위반(permId 키)을 방어하는지 런타임 확인
      client.adminCreatePermTemplate({ permId: "  ", displayName: "x", policyDocument: {} }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const ok = await client.adminCreatePermTemplate({ displayName: "자동", policyDocument: {} });
    expect(ok.permId.length).toBeGreaterThan(0);
  });
});
