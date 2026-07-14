import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { CreateWizard } from "../src/screens/user/CreateWizard.js";
import { AppDetail } from "../src/screens/user/AppDetail.js";
import { DEFAULT_SCHEDULE, isScheduleValid } from "../src/components/ScheduleEditor.js";
import { renderWithProviders, seedSession, setHash } from "./harness.js";
import { MockApiClient } from "../src/mock/mockApi.js";
import type { CreateAppRequest } from "../src/lib/types.js";

/**
 * 이슈 4 회귀 방지 — sleepMode="schedule" 선택 시 시간표 입력 UI 노출 + body 에 schedule 포함.
 * days 인덱스 규약: 0=일 … 6=토 (백엔드 validate.py `_parse_schedule` 의 0<=d<=6 와 일치).
 *   기본값은 평일(월~금) = [1,2,3,4,5].
 */

// 마법사 6단계(가동 방식)까지 진입. 목 기본 VPC 1개 → 자동선택되어 네트워크 UI 없음.
async function gotoSleepStep(): Promise<void> {
  // 1단계: 저장소
  fireEvent.click(await screen.findByText("회사 GitHub"));
  fireEvent.change(screen.getByPlaceholderText(/https:\/\/github.com/), {
    target: { value: "https://github.com/example/x" },
  });
  fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
  // 2단계: 이름·주소
  await screen.findByText("앱 이름과 접속 범위를 정해주세요");
  fireEvent.change(screen.getByLabelText("앱 이름"), { target: { value: "시간표 앱" } });
  fireEvent.change(screen.getByLabelText("접속 주소"), { target: { value: "sched-app" } });
  await screen.findByText("사용할 수 있는 주소예요");
  fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
  // 3단계: 크기
  fireEvent.click((await screen.findAllByText(/최소 .*대/))[0]!.closest("button")!);
  fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
  // 4단계: 앱 유형
  await screen.findByText("어떤 기능을 사용하는 앱인가요?");
  const typeCard = (await screen.findAllByRole("button")).find((b) =>
    /기본|봇|사용/.test(b.textContent ?? ""),
  );
  // 첫 유형 카드 클릭 (choice 버튼)
  fireEvent.click(typeCard ?? screen.getAllByRole("button")[0]!);
  fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
  // 5단계: 환경변수 (선택) → 다음
  await screen.findByText("앱에 전달할 설정값이 있나요?");
  fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
  // 6단계: 가동 방식
  await screen.findByText("앱을 언제 켜둘까요?");
}

describe("이슈 4 — 마법사 '시간표대로' 시간표 입력 UI", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
    setHash("/apps/new");
  });

  it("'시간표대로'를 고르면 시작/종료 시각과 요일 칩이 나타난다", async () => {
    renderWithProviders(<CreateWizard />);
    await gotoSleepStep();
    // 선택 전에는 시간표 입력이 없다
    expect(screen.queryByLabelText("켜지는 시각")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("시간표대로"));
    expect(await screen.findByLabelText("켜지는 시각")).toBeInTheDocument();
    expect(screen.getByLabelText("꺼지는 시각")).toBeInTheDocument();
    // 요일 칩 7개(일~토)
    for (const d of ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"]) {
      expect(screen.getByRole("button", { name: d })).toBeInTheDocument();
    }
  });

  it("기본 요일은 평일(월~금)이 선택돼 있다(aria-pressed)", async () => {
    renderWithProviders(<CreateWizard />);
    await gotoSleepStep();
    fireEvent.click(screen.getByText("시간표대로"));
    await screen.findByLabelText("켜지는 시각");
    expect(screen.getByRole("button", { name: "월요일" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "금요일" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "일요일" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "토요일" })).toHaveAttribute("aria-pressed", "false");
  });

  it("createApp body 에 schedule(days 0=일…6=토)이 포함된다", async () => {
    const client = new MockApiClient();
    const spy = vi.spyOn(client, "createApp");
    renderWithProviders(<CreateWizard />, client);
    await gotoSleepStep();
    fireEvent.click(screen.getByText("시간표대로"));
    await screen.findByLabelText("켜지는 시각");
    // 일요일(=0)도 추가로 켠다 → days 에 0 포함되는지 확인
    fireEvent.click(screen.getByRole("button", { name: "일요일" }));
    fireEvent.click(screen.getByRole("button", { name: /앱 만들기/ }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const body = spy.mock.calls[0]![0] as CreateAppRequest;
    expect(body.sleepMode).toBe("schedule");
    expect(body.schedule).toBeDefined();
    expect(body.schedule!.days).toEqual([0, 1, 2, 3, 4, 5]);
    expect(body.schedule!.timezone).toBe("Asia/Seoul");
    expect(body.schedule!.startTime).toBe("09:00");
  });

  it("모든 요일을 끄면 '앱 만들기'가 비활성(요일 1개↑ 필요)", async () => {
    renderWithProviders(<CreateWizard />);
    await gotoSleepStep();
    fireEvent.click(screen.getByText("시간표대로"));
    await screen.findByLabelText("켜지는 시각");
    for (const d of ["월요일", "화요일", "수요일", "목요일", "금요일"]) {
      fireEvent.click(screen.getByRole("button", { name: d }));
    }
    expect(screen.getByRole("button", { name: /앱 만들기/ })).toBeDisabled();
  });
});

describe("이슈 4 — 앱 상세 설정 탭 시간표 입력", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
  });
  afterEach(() => vi.useRealTimers());

  it("시간표 앱(e5f6a7b8) 설정 탭에서 시간표 입력이 기존 값으로 노출된다", async () => {
    setHash("/apps/e5f6a7b8");
    renderWithProviders(<AppDetail appId="e5f6a7b8" />);
    // 설정 탭 진입
    fireEvent.click(await screen.findByRole("tab", { name: /설정/ }));
    // schedule 모드라 시간표 에디터가 바로 보인다(기존 09:00–19:00, 평일)
    const start = (await screen.findByLabelText("켜지는 시각")) as HTMLInputElement;
    expect(start.value).toBe("09:00");
    expect(screen.getByRole("button", { name: "월요일" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "일요일" })).toHaveAttribute("aria-pressed", "false");
  });

  it("schedule 변경 시 patchApp body 에 schedule 이 포함된다", async () => {
    const client = new MockApiClient();
    const spy = vi.spyOn(client, "patchApp");
    setHash("/apps/e5f6a7b8");
    renderWithProviders(<AppDetail appId="e5f6a7b8" />, client);
    fireEvent.click(await screen.findByRole("tab", { name: /설정/ }));
    await screen.findByLabelText("켜지는 시각");
    // 토요일 추가 → dirty
    fireEvent.click(screen.getByRole("button", { name: "토요일" }));
    fireEvent.click(screen.getByRole("button", { name: /변경 사항 저장/ }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const body = spy.mock.calls[0]![1];
    expect(body.sleepMode).toBe("schedule");
    expect(body.schedule).toBeDefined();
    expect(body.schedule!.days).toContain(6); // 토=6
  });
});

describe("이슈 4 — isScheduleValid / DEFAULT_SCHEDULE 계약 정합", () => {
  it("기본 시간표는 유효하고 days 는 0~6 범위·평일이다", () => {
    expect(isScheduleValid(DEFAULT_SCHEDULE)).toBe(true);
    expect(DEFAULT_SCHEDULE.days).toEqual([1, 2, 3, 4, 5]);
    expect(DEFAULT_SCHEDULE.days.every((d) => d >= 0 && d <= 6)).toBe(true);
  });
  it("요일이 비었거나 시각 형식이 틀리면 무효", () => {
    expect(isScheduleValid({ ...DEFAULT_SCHEDULE, days: [] })).toBe(false);
    expect(isScheduleValid({ ...DEFAULT_SCHEDULE, startTime: "9:0" })).toBe(false);
    expect(isScheduleValid({ ...DEFAULT_SCHEDULE, days: [7] })).toBe(false);
  });
});
