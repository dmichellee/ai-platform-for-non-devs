import { describe, it, expect, beforeEach } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { Connections } from "../src/screens/user/Connections.js";
import { renderWithProviders, seedSession, setHash } from "./harness.js";

/**
 * 저장소 연결 관리 — AWS 저장소(codecommit) 카드의 내 저장소 목록·삭제 (사용자 지적: 만들기만 있고 삭제 없음).
 * 픽스처: conn-0003 = "AWS 저장소"(codecommit, AVAILABLE), 레포 daeun-sales-board / daeun-meeting-notes.
 *   - daeun-sales-board 는 목 앱 e5f6a7b8(매출 대시보드)이 쓰는 레포 → 삭제 시 REPO_IN_USE(409).
 *   - daeun-meeting-notes 는 쓰는 앱 없음 → 정상 삭제 가능.
 * github/gitlab 카드에는 저장소 관리 기능이 없어야 한다.
 */
describe("저장소 연결 — AWS 저장소 카드 내 저장소 목록·삭제", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user"); // email daeun@example.com → ownerPrefix "daeun"
    setHash("/connections");
  });

  it("codecommit 카드의 '내 저장소' 토글을 펼치면 목록(접두어 포함 최종명)이 나온다", async () => {
    renderWithProviders(<Connections />);
    // codecommit 연결 카드 로드
    await screen.findByText("AWS 저장소");
    // 접힘 상태에서는 레포 이름이 아직 안 보인다
    expect(screen.queryByText("daeun-meeting-notes")).not.toBeInTheDocument();
    // 토글(접힘) → 펼침
    const toggle = screen.getByRole("button", { name: /내 저장소/ });
    fireEvent.click(toggle);
    // 목록 로드 — 본인이 만든 레포 최종명이 나온다
    expect(await screen.findByText("daeun-sales-board")).toBeInTheDocument();
    expect(screen.getByText("daeun-meeting-notes")).toBeInTheDocument();
    // 개수 라벨 갱신
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /내 저장소 2개/ })).toBeInTheDocument(),
    );
  });

  it("사용 중인 앱이 없는 저장소는 이름을 정확히 입력해야 삭제 버튼이 활성화된다", async () => {
    renderWithProviders(<Connections />);
    await screen.findByText("AWS 저장소");
    fireEvent.click(screen.getByRole("button", { name: /내 저장소/ }));
    await screen.findByText("daeun-meeting-notes");

    // meeting-notes 행의 삭제 버튼(사용 중 아님)
    fireEvent.click(screen.getByRole("button", { name: "daeun-meeting-notes 저장소 삭제" }));
    const dialog = await screen.findByRole("dialog", { name: "저장소를 삭제할까요?" });
    // 파괴적 경고 문구
    expect(
      within(dialog).getByText(/안의 코드가 모두 사라지고 되돌릴 수 없어요/),
    ).toBeInTheDocument();

    const delBtn = within(dialog).getByRole("button", { name: /삭제할게요/ });
    // 이름 입력 전 비활성
    expect(delBtn).toBeDisabled();
    // 틀린 이름 → 여전히 비활성
    fireEvent.change(within(dialog).getByLabelText("삭제 확인 저장소 이름"), {
      target: { value: "daeun-meeting" },
    });
    expect(delBtn).toBeDisabled();
    // 정확한 이름 → 활성
    fireEvent.change(within(dialog).getByLabelText("삭제 확인 저장소 이름"), {
      target: { value: "daeun-meeting-notes" },
    });
    expect(delBtn).not.toBeDisabled();

    // 삭제 실행 → 모달이 닫히고 목록 갱신 후 삭제한 레포가 사라진다(사용 중이던 레포는 유지).
    fireEvent.click(delBtn);
    // 재조회가 끝나 남은 레포가 다시 렌더되고, 삭제한 레포는 없을 때까지 대기(로딩 구간 오탐 방지).
    await waitFor(() => {
      expect(screen.getByText("daeun-sales-board")).toBeInTheDocument();
      expect(screen.queryAllByText("daeun-meeting-notes")).toHaveLength(0);
    });
  });

  it("사용 중인 앱이 있는 저장소는 삭제 시 REPO_IN_USE 안내를 모달 안에서 보여준다", async () => {
    renderWithProviders(<Connections />);
    await screen.findByText("AWS 저장소");
    fireEvent.click(screen.getByRole("button", { name: /내 저장소/ }));
    await screen.findByText("daeun-sales-board");

    // sales-board 는 목 앱이 사용 중 → 서버가 409 REPO_IN_USE
    fireEvent.click(screen.getByRole("button", { name: "daeun-sales-board 저장소 삭제" }));
    const dialog = await screen.findByRole("dialog", { name: "저장소를 삭제할까요?" });
    fireEvent.change(within(dialog).getByLabelText("삭제 확인 저장소 이름"), {
      target: { value: "daeun-sales-board" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /삭제할게요/ }));

    // 사용 중 안내가 모달 안에 뜨고, 레포는 삭제되지 않아 목록에 남아 있다.
    // (이름은 목록 행 + 모달 본문 양쪽에 등장하므로 1회 이상이면 삭제되지 않은 것.)
    expect(
      await within(dialog).findByText(/사용 중인 앱이 있어요/),
    ).toBeInTheDocument();
    expect(screen.getAllByText("daeun-sales-board").length).toBeGreaterThan(0);
  });

  it("카드 안에서 바로 새 저장소를 만들 수 있다(접두어 칩 재사용)", async () => {
    renderWithProviders(<Connections />);
    await screen.findByText("AWS 저장소");
    fireEvent.click(screen.getByRole("button", { name: /내 저장소/ }));
    // 목록 로드 대기
    await screen.findByText("daeun-sales-board");

    fireEvent.click(screen.getByRole("button", { name: /새 저장소 만들기/ }));
    const dialog = await screen.findByRole("dialog", { name: "새 저장소 만들기" });
    // 마법사와 동일한 접두어 칩 재사용
    expect(within(dialog).getByText("daeun-")).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("저장소 이름"), {
      target: { value: "new-report" },
    });
    // 최종 이름 미리보기
    expect(within(dialog).getByText("daeun-new-report")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /^만들기$/ }));

    // 새 레포가 목록에 나타난다
    expect(await screen.findByText("daeun-new-report")).toBeInTheDocument();
  });

  it("GitHub(codeconnections) 카드에는 저장소 목록·삭제 기능이 없다", async () => {
    renderWithProviders(<Connections />);
    // 회사 GitHub 카드 로드 (conn-0001, github, AVAILABLE)
    const githubName = await screen.findByText("회사 GitHub");
    // 카드 컨테이너(.panel)로 올라가 그 안에 '내 저장소' 토글이 없는지 확인
    const card = githubName.closest(".panel") as HTMLElement;
    expect(card).toBeTruthy();
    expect(within(card).queryByRole("button", { name: /내 저장소/ })).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /새 저장소 만들기/ })).not.toBeInTheDocument();
  });
});
