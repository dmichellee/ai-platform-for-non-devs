import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { CreateWizard } from "../src/screens/user/CreateWizard.js";
import { renderWithProviders, seedSession, setHash } from "./harness.js";
import { MockApiClient } from "../src/mock/mockApi.js";
import { ApiError } from "../src/lib/api.js";

/**
 * 앱 생성 마법사 버그 3건 회귀 방지.
 *  1) 접속 주소 입력 중 하이픈 유지("my-app" 그대로), blur 시 앞뒤/연속 하이픈 트림.
 *  2) 서브도메인 실시간 중복 확인 3상태(사용 가능/이미 사용 중/형식 오류).
 *  3) 프리셋·권한템플릿을 user 엔드포인트(listPresets/listPermTemplates)로 조회, 빈 목록 안내.
 * 목 세션(user): email daeun@example.com. 기존 목 앱 서브도메인: chat-bot, sales-board 등.
 */

// 2단계(이름·공개 범위)까지 진입시키는 헬퍼 — 1단계에서 GitHub 연결+주소 입력 후 다음.
async function gotoNameStep(): Promise<void> {
  fireEvent.click(await screen.findByText("회사 GitHub"));
  fireEvent.change(screen.getByPlaceholderText(/https:\/\/github.com/), {
    target: { value: "https://github.com/example/x" },
  });
  fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
  await screen.findByText("앱 이름과 접속 범위를 정해주세요");
}

describe("버그1 — 접속 주소 하이픈 입력 유지", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
    setHash("/apps/new");
  });

  it("'my-app'을 타이핑하면 하이픈이 즉시 사라지지 않고 그대로 유지된다", async () => {
    renderWithProviders(<CreateWizard />);
    await gotoNameStep();
    const sub = screen.getByLabelText("접속 주소") as HTMLInputElement;
    // 실제 타이핑을 흉내: 매 글자마다 onChange (입력 컨트롤드 값 기준)
    for (const value of ["m", "my", "my-", "my-a", "my-ap", "my-app"]) {
      fireEvent.change(sub, { target: { value } });
    }
    expect(sub.value).toBe("my-app");
  });

  it("끝 하이픈을 남겨 입력하다가 blur하면 앞뒤/연속 하이픈이 정리된다", async () => {
    renderWithProviders(<CreateWizard />);
    await gotoNameStep();
    const sub = screen.getByLabelText("접속 주소") as HTMLInputElement;
    fireEvent.change(sub, { target: { value: "my--app-" } });
    // 입력 중에는 연속/끝 하이픈 보존
    expect(sub.value).toBe("my--app-");
    fireEvent.blur(sub);
    // blur 시 정리: 연속 하이픈 축약 + 끝 하이픈 제거
    expect(sub.value).toBe("my-app");
  });

  it("앞 하이픈은 입력 시점에 차단된다", async () => {
    renderWithProviders(<CreateWizard />);
    await gotoNameStep();
    const sub = screen.getByLabelText("접속 주소") as HTMLInputElement;
    fireEvent.change(sub, { target: { value: "-abc" } });
    expect(sub.value).toBe("abc");
  });
});

describe("버그2 — 서브도메인 실시간 중복 확인", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
    setHash("/apps/new");
  });

  it("사용 가능한 새 주소를 입력하면 '사용할 수 있는 주소예요'가 뜨고 다음이 활성화된다", async () => {
    renderWithProviders(<CreateWizard />);
    await gotoNameStep();
    fireEvent.change(screen.getByLabelText("앱 이름"), { target: { value: "새 앱" } });
    const sub = screen.getByLabelText("접속 주소");
    fireEvent.change(sub, { target: { value: "brand-new-app" } });
    expect(await screen.findByText("사용할 수 있는 주소예요")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /다음 단계/ })).not.toBeDisabled();
  });

  it("이미 쓰이는 주소(chat-bot)면 '이미 사용 중인 주소예요' + 다음 비활성", async () => {
    renderWithProviders(<CreateWizard />);
    await gotoNameStep();
    fireEvent.change(screen.getByLabelText("앱 이름"), { target: { value: "겹치는 앱" } });
    fireEvent.change(screen.getByLabelText("접속 주소"), { target: { value: "chat-bot" } });
    expect(await screen.findByText("이미 사용 중인 주소예요")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /다음 단계/ })).toBeDisabled();
  });

  it("예약어(admin)는 형식 오류 안내를 보여준다(INVALID)", async () => {
    renderWithProviders(<CreateWizard />);
    await gotoNameStep();
    fireEvent.change(screen.getByLabelText("접속 주소"), { target: { value: "admin" } });
    expect(await screen.findByText(/이 주소는 쓸 수 없어요/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /다음 단계/ })).toBeDisabled();
  });

  it("blur 시 트림된 최종값으로 확인한다('my-app-' → 사용 가능)", async () => {
    renderWithProviders(<CreateWizard />);
    await gotoNameStep();
    const sub = screen.getByLabelText("접속 주소") as HTMLInputElement;
    fireEvent.change(sub, { target: { value: "my-app-" } });
    fireEvent.blur(sub);
    expect(sub.value).toBe("my-app");
    expect(await screen.findByText("사용할 수 있는 주소예요")).toBeInTheDocument();
  });
});

describe("버그3 — 프리셋/권한템플릿 user 엔드포인트 사용", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
    setHash("/apps/new");
  });

  it("크기 단계는 adminListPresets가 아닌 listPresets를 호출한다", async () => {
    const client = new MockApiClient();
    const listSpy = vi.spyOn(client, "listPresets");
    const adminSpy = vi.spyOn(client, "adminListPresets");
    renderWithProviders(<CreateWizard />, client);
    // 마법사 진입만으로 프리셋을 미리 로드한다
    await waitFor(() => expect(listSpy).toHaveBeenCalled());
    expect(adminSpy).not.toHaveBeenCalled();
  });

  it("앱 유형 단계는 listPermTemplates를 호출한다", async () => {
    const client = new MockApiClient();
    const listSpy = vi.spyOn(client, "listPermTemplates");
    const adminSpy = vi.spyOn(client, "adminListPermTemplates");
    renderWithProviders(<CreateWizard />, client);
    await waitFor(() => expect(listSpy).toHaveBeenCalled());
    expect(adminSpy).not.toHaveBeenCalled();
  });

  it("프리셋 목록이 비면 '관리자가 아직 크기를 준비하지 않았어요' 안내 + 다음 비활성", async () => {
    // 빈 프리셋을 돌려주는 클라이언트로 3단계까지 진입한다.
    const client = new MockApiClient();
    vi.spyOn(client, "listPresets").mockResolvedValue([]);
    renderWithProviders(<CreateWizard />, client);
    await gotoNameStep();
    // 2단계에서 이름 + 사용 가능한 주소로 다음 활성화
    fireEvent.change(screen.getByLabelText("앱 이름"), { target: { value: "빈 크기 앱" } });
    fireEvent.change(screen.getByLabelText("접속 주소"), { target: { value: "empty-preset-app" } });
    await screen.findByText("사용할 수 있는 주소예요");
    fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
    // 3단계(크기) 진입 — 빈 목록 안내
    expect(
      await screen.findByText(/관리자가 아직 크기를 준비하지 않았어요/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /다음 단계/ })).toBeDisabled();
  });

  it("프리셋 조회 에러는 삼키지 않고 에러 안내로 보여준다", async () => {
    const client = new MockApiClient();
    vi.spyOn(client, "listPresets").mockRejectedValue(
      new ApiError("FORBIDDEN", "권한 없음", 403),
    );
    renderWithProviders(<CreateWizard />, client);
    await gotoNameStep();
    fireEvent.change(screen.getByLabelText("앱 이름"), { target: { value: "에러 크기 앱" } });
    fireEvent.change(screen.getByLabelText("접속 주소"), { target: { value: "err-preset-app" } });
    await screen.findByText("사용할 수 있는 주소예요");
    fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
    // 3단계 진입 — 에러 배너(role=alert)에 메시지 노출
    const step = await screen.findByText("앱을 얼마나 크게 돌릴까요?");
    expect(step).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getAllByRole("alert").some((el) => /권한 없음/.test(el.textContent ?? ""))).toBe(
        true,
      ),
    );
  });
});

describe("버그3 — user 권한템플릿에 정책(policyDocument) 노출 없음", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
    setHash("/apps/new");
  });

  it("listPermTemplates 응답 항목에는 policyDocument가 없다", async () => {
    const client = new MockApiClient();
    const items = await client.listPermTemplates();
    expect(items.length).toBeGreaterThan(0);
    for (const t of items) {
      expect(t).not.toHaveProperty("policyDocument");
      expect(typeof t.permId).toBe("string");
      expect(typeof t.displayName).toBe("string");
    }
  });
});

describe("mockApi.checkSubdomain 계약 3상태", () => {
  it("사용 가능/중복(TAKEN)/형식오류(INVALID)를 구분한다", async () => {
    localStorage.clear();
    seedSession("user");
    const client = new MockApiClient();
    // 기존 목 앱과 겹치지 않는 신규 → 사용 가능
    expect(await client.checkSubdomain("fresh-one")).toEqual({ available: true });
    // 기존 목 앱 서브도메인(sales-board) → TAKEN
    expect(await client.checkSubdomain("sales-board")).toEqual({ available: false, reason: "TAKEN" });
    // 3자 미만 → INVALID
    expect(await client.checkSubdomain("ab")).toEqual({ available: false, reason: "INVALID" });
    // 예약어 → INVALID
    expect(await client.checkSubdomain("api")).toEqual({ available: false, reason: "INVALID" });
    // 대문자/불허 문자 → INVALID
    expect(await client.checkSubdomain("Bad_Name")).toEqual({ available: false, reason: "INVALID" });
  });

  it("blur 트림 후 값과 동일하게 잘 통과한다(양끝 하이픈 없는 최종값)", async () => {
    const client = new MockApiClient();
    // 서비스 계층 함수는 최종값만 받는다 — 앞뒤 하이픈이 남은 원시값은 INVALID
    expect(await client.checkSubdomain("my-app-")).toEqual({ available: false, reason: "INVALID" });
    expect(await client.checkSubdomain("my-app")).toEqual({ available: true });
  });
});
