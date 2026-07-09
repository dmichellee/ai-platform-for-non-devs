import { describe, it, expect, beforeEach } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { CreateWizard } from "../src/screens/user/CreateWizard.js";
import { renderWithProviders, seedSession, setHash } from "./harness.js";

/**
 * 마법사 1단계 저장소 선택 — 하이브리드(codecommit 드롭다운 vs github/gitlab 자유입력).
 * 픽스처: conn-0003 = AWS 저장소(AVAILABLE, codecommit), conn-0001 = 회사 GitHub(AVAILABLE).
 * 저장소 이름 접두어: 서버가 base 앞에 `{ownerPrefix}-` 부착. 목 세션(user) 접두어는 "daeun".
 */
describe("앱 생성 마법사 — 저장소 하이브리드", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user"); // email: daeun@example.com → ownerPrefix "daeun"
    setHash("/apps/new");
  });

  it("AWS 저장소 연결을 고르면 자유입력 대신 드롭다운(본인 레포)이 나온다", async () => {
    renderWithProviders(<CreateWizard />);
    fireEvent.click(await screen.findByText("AWS 저장소"));
    // 드롭다운 라벨 등장, 자유입력용 '저장소 주소' 라벨은 없음
    expect(await screen.findByLabelText("배포할 저장소")).toBeInTheDocument();
    expect(screen.queryByLabelText("저장소 주소")).not.toBeInTheDocument();
    // 본인이 만든 레포(픽스처, 접두어 포함 최종명)가 옵션으로 로드된다
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "daeun-sales-board" })).toBeInTheDocument(),
    );
    // 브랜치 입력은 유지
    expect(screen.getByLabelText("배포할 브랜치")).toBeInTheDocument();
  });

  it("드롭다운에서 레포를 고르면 '다음 단계'가 활성화된다(repoUrl=cloneUrlHttp)", async () => {
    renderWithProviders(<CreateWizard />);
    fireEvent.click(await screen.findByText("AWS 저장소"));
    const select = await screen.findByLabelText("배포할 저장소");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "daeun-sales-board" })).toBeInTheDocument(),
    );
    // 선택 전에는 다음 비활성
    expect(screen.getByRole("button", { name: /다음 단계/ })).toBeDisabled();
    fireEvent.change(select, { target: { value: "daeun-sales-board" } });
    expect(screen.getByRole("button", { name: /다음 단계/ })).not.toBeDisabled();
  });

  it("'새 저장소 만들기' 입력창 앞에 내 아이디 접두어 칩과 최종 이름 미리보기가 보인다", async () => {
    renderWithProviders(<CreateWizard />);
    fireEvent.click(await screen.findByText("AWS 저장소"));
    await screen.findByLabelText("배포할 저장소");
    fireEvent.click(screen.getByRole("button", { name: /새 저장소 만들기/ }));

    const dialog = await screen.findByRole("dialog", { name: "새 저장소 만들기" });
    // 접두어 칩(입력 불가, 시각 표시)
    expect(within(dialog).getByText("daeun-")).toBeInTheDocument();
    // 접두어 안내 문구
    expect(
      within(dialog).getByText(/저장소 이름 앞에 내 아이디가 자동으로 붙어요/),
    ).toBeInTheDocument();
    // base 만 입력하면 최종 이름 미리보기가 접두어 포함으로 나온다
    fireEvent.change(within(dialog).getByLabelText("저장소 이름"), {
      target: { value: "customer-chatbot" },
    });
    expect(within(dialog).getByText("daeun-customer-chatbot")).toBeInTheDocument();
  });

  it("'새 저장소 만들기' → base 입력 → 만들면 접두어 포함 최종명으로 목록에 추가·자동 선택된다", async () => {
    renderWithProviders(<CreateWizard />);
    fireEvent.click(await screen.findByText("AWS 저장소"));
    await screen.findByLabelText("배포할 저장소");
    fireEvent.click(screen.getByRole("button", { name: /새 저장소 만들기/ }));

    const dialog = await screen.findByRole("dialog", { name: "새 저장소 만들기" });
    fireEvent.change(within(dialog).getByLabelText("저장소 이름"), {
      target: { value: "customer-chatbot" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /만들고 선택하기/ }));

    // 모달이 닫히고 접두어 포함 최종명이 옵션으로 등장 + 자동 선택되어 다음 단계 활성
    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: "daeun-customer-chatbot" }),
      ).toBeInTheDocument(),
    );
    // 접두어 없는 base 이름은 옵션으로 존재하지 않는다
    expect(screen.queryByRole("option", { name: "customer-chatbot" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /다음 단계/ })).not.toBeDisabled();
  });

  it("접두어가 붙은 최종명이 기존 레포와 겹치면 친절한 에러(REPO_NAME_TAKEN)를 보여준다", async () => {
    renderWithProviders(<CreateWizard />);
    fireEvent.click(await screen.findByText("AWS 저장소"));
    await screen.findByLabelText("배포할 저장소");
    fireEvent.click(screen.getByRole("button", { name: /새 저장소 만들기/ }));
    const dialog = await screen.findByRole("dialog", { name: "새 저장소 만들기" });
    // base "sales-board" → 최종 "daeun-sales-board" 가 픽스처에 이미 있다
    fireEvent.change(within(dialog).getByLabelText("저장소 이름"), {
      target: { value: "sales-board" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /만들고 선택하기/ }));
    expect(await within(dialog).findByText(/이미 같은 이름의 저장소가 있어요/)).toBeInTheDocument();
  });

  it("이름 규칙 위반이면 '만들고 선택하기'가 비활성이다(대문자)", async () => {
    renderWithProviders(<CreateWizard />);
    fireEvent.click(await screen.findByText("AWS 저장소"));
    await screen.findByLabelText("배포할 저장소");
    fireEvent.click(screen.getByRole("button", { name: /새 저장소 만들기/ }));
    const dialog = await screen.findByRole("dialog", { name: "새 저장소 만들기" });
    fireEvent.change(within(dialog).getByLabelText("저장소 이름"), {
      target: { value: "Bad_Name" },
    });
    expect(within(dialog).getByRole("button", { name: /만들고 선택하기/ })).toBeDisabled();
  });

  it("접두어 포함 전체 길이가 100자를 넘으면 버튼 비활성 + 길이 안내를 보여준다", async () => {
    renderWithProviders(<CreateWizard />);
    fireEvent.click(await screen.findByText("AWS 저장소"));
    await screen.findByLabelText("배포할 저장소");
    fireEvent.click(screen.getByRole("button", { name: /새 저장소 만들기/ }));
    const dialog = await screen.findByRole("dialog", { name: "새 저장소 만들기" });
    // "daeun-" (6자) + base 95자 = 101자 → 초과
    const longBase = "a".repeat(95);
    fireEvent.change(within(dialog).getByLabelText("저장소 이름"), {
      target: { value: longBase },
    });
    expect(within(dialog).getByText(/이름이 너무 길어요/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /만들고 선택하기/ })).toBeDisabled();
  });

  it("이메일 없는 세션은 sub 앞 8자로 접두어를 만든다(폴백)", async () => {
    localStorage.clear();
    seedSession("user", { email: null }); // email 없음 → sub "user-0001" 앞 8자 정제 → "user-000"
    setHash("/apps/new");
    renderWithProviders(<CreateWizard />);
    fireEvent.click(await screen.findByText("AWS 저장소"));
    await screen.findByLabelText("배포할 저장소");
    fireEvent.click(screen.getByRole("button", { name: /새 저장소 만들기/ }));
    const dialog = await screen.findByRole("dialog", { name: "새 저장소 만들기" });
    // sub = "user-0001" → 앞 8자 "user-000" → 양끝 구분자 없음 → 접두어 "user-000"
    expect(within(dialog).getByText("user-000-")).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("저장소 이름"), {
      target: { value: "demo-app" },
    });
    expect(within(dialog).getByText("user-000-demo-app")).toBeInTheDocument();
  });

  it("GitHub 연결은 provider별 placeholder와 붙여넣기 안내가 있는 자유입력을 유지한다", async () => {
    renderWithProviders(<CreateWizard />);
    fireEvent.click(await screen.findByText("회사 GitHub"));
    const url = await screen.findByLabelText("저장소 주소");
    expect(url).toHaveAttribute("placeholder", "https://github.com/계정/저장소");
    expect(screen.getByText("연결한 계정의 저장소 주소를 붙여넣으세요.")).toBeInTheDocument();
    // 드롭다운은 없음
    expect(screen.queryByLabelText("배포할 저장소")).not.toBeInTheDocument();
  });
});
