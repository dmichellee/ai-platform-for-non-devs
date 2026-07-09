import { describe, it, expect, beforeEach } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { CreateWizard } from "../src/screens/user/CreateWizard.js";
import { renderWithProviders, seedSession, setHash } from "./harness.js";

/**
 * 마법사 1단계 저장소 선택 — 하이브리드(codecommit 드롭다운 vs github/gitlab 자유입력).
 * 픽스처: conn-0003 = AWS 저장소(AVAILABLE, codecommit), conn-0001 = 회사 GitHub(AVAILABLE).
 */
describe("앱 생성 마법사 — 저장소 하이브리드", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
    setHash("/apps/new");
  });

  it("AWS 저장소 연결을 고르면 자유입력 대신 드롭다운(본인 레포)이 나온다", async () => {
    renderWithProviders(<CreateWizard />);
    fireEvent.click(await screen.findByText("AWS 저장소"));
    // 드롭다운 라벨 등장, 자유입력용 '저장소 주소' 라벨은 없음
    expect(await screen.findByLabelText("배포할 저장소")).toBeInTheDocument();
    expect(screen.queryByLabelText("저장소 주소")).not.toBeInTheDocument();
    // 본인이 만든 레포(픽스처)가 옵션으로 로드된다
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "sales-board" })).toBeInTheDocument(),
    );
    // 브랜치 입력은 유지
    expect(screen.getByLabelText("배포할 브랜치")).toBeInTheDocument();
  });

  it("드롭다운에서 레포를 고르면 '다음 단계'가 활성화된다(repoUrl=cloneUrlHttp)", async () => {
    renderWithProviders(<CreateWizard />);
    fireEvent.click(await screen.findByText("AWS 저장소"));
    const select = await screen.findByLabelText("배포할 저장소");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "sales-board" })).toBeInTheDocument(),
    );
    // 선택 전에는 다음 비활성
    expect(screen.getByRole("button", { name: /다음 단계/ })).toBeDisabled();
    fireEvent.change(select, { target: { value: "sales-board" } });
    expect(screen.getByRole("button", { name: /다음 단계/ })).not.toBeDisabled();
  });

  it("'새 저장소 만들기' → 이름 입력 → 만들면 목록에 추가되고 자동 선택된다", async () => {
    renderWithProviders(<CreateWizard />);
    fireEvent.click(await screen.findByText("AWS 저장소"));
    await screen.findByLabelText("배포할 저장소");
    fireEvent.click(screen.getByRole("button", { name: /새 저장소 만들기/ }));

    const dialog = await screen.findByRole("dialog", { name: "새 저장소 만들기" });
    fireEvent.change(within(dialog).getByLabelText("저장소 이름"), {
      target: { value: "customer-chatbot" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /만들고 선택하기/ }));

    // 모달이 닫히고 새 레포가 옵션으로 등장 + 자동 선택되어 다음 단계 활성
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "customer-chatbot" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /다음 단계/ })).not.toBeDisabled();
  });

  it("중복 이름으로 새 저장소를 만들면 친절한 에러(REPO_NAME_TAKEN)를 보여준다", async () => {
    renderWithProviders(<CreateWizard />);
    fireEvent.click(await screen.findByText("AWS 저장소"));
    await screen.findByLabelText("배포할 저장소");
    fireEvent.click(screen.getByRole("button", { name: /새 저장소 만들기/ }));
    const dialog = await screen.findByRole("dialog", { name: "새 저장소 만들기" });
    // 픽스처에 이미 있는 이름
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
