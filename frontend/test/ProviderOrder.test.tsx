import { describe, it, expect, beforeEach } from "vitest";
import { screen, fireEvent, within } from "@testing-library/react";
import { Connections } from "../src/screens/user/Connections.js";
import { CreateWizard } from "../src/screens/user/CreateWizard.js";
import { renderWithProviders, seedSession, setHash } from "./harness.js";

/**
 * 저장소 provider 카드 순서 (문제 2).
 * "AWS 저장소(CodeCommit)"가 맨 앞에 오고 기본 선택이어야 한다.
 * 픽스처 연결: conn-0001 회사 GitHub(AVAILABLE), conn-0002 사내 GitLab(PENDING),
 *            conn-0003 AWS 저장소(codecommit, AVAILABLE).
 */

describe("저장소 provider 순서 — AWS 저장소 우선", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
  });

  it("연결 추가 모달: 첫 카드가 AWS 저장소(CodeCommit)이고 기본 선택이다", async () => {
    setHash("/connections");
    renderWithProviders(<Connections />);
    await screen.findByText("회사 GitHub"); // 목록 로드 대기
    fireEvent.click(screen.getByRole("button", { name: /연결 추가/ }));

    const dialog = await screen.findByRole("dialog", { name: "저장소 연결 추가" });
    // provider 카드는 관리자 활성 목록(GET /providers)을 비동기 로드 후 렌더 — 로드 완료 대기
    await within(dialog).findByText("AWS 저장소(CodeCommit)");
    // 저장소 종류 선택 카드(라벨을 가진 choice 버튼)만 추린다
    const choices = within(dialog)
      .getAllByRole("button")
      .filter((b) => b.className.includes("choice"));

    // 목 설정의 enabledProviders(3종 전부 활성) 기준
    expect(choices.length).toBe(3);
    // 첫 번째 카드가 AWS 저장소(CodeCommit)
    expect(within(choices[0]).getByText("AWS 저장소(CodeCommit)")).toBeInTheDocument();
    // 기본 선택(sel) 카드도 AWS 저장소
    const selected = choices.find((b) => b.className.includes("sel"));
    expect(selected).toBeDefined();
    expect(within(selected!).getByText("AWS 저장소(CodeCommit)")).toBeInTheDocument();
    // 기본 안내가 codecommit용("바로 사용")으로 나온다
    expect(within(dialog).getByText(/바로 사용할 수 있어요/)).toBeInTheDocument();
  });

  it("마법사 1단계: AVAILABLE 연결 카드에서 AWS 저장소가 GitHub보다 먼저 온다", async () => {
    setHash("/apps/new");
    renderWithProviders(<CreateWizard />);
    // 두 AVAILABLE 연결(AWS 저장소, 회사 GitHub)이 뜬다
    await screen.findByText("AWS 저장소");
    const awsCard = screen.getByText("AWS 저장소");
    const githubCard = screen.getByText("회사 GitHub");
    // DOM 순서상 AWS 저장소가 GitHub보다 앞에 위치
    const pos = awsCard.compareDocumentPosition(githubCard);
    // Node.DOCUMENT_POSITION_FOLLOWING(4) = githubCard가 awsCard 뒤에 있음
    expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("관리자 활성 provider만 노출 (기능 요구사항 3)", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
  });

  it("codecommit만 활성이면 GitHub/GitLab 카드가 안 보인다", async () => {
    setHash("/connections");
    const { MockApiClient } = await import("../src/mock/mockApi.js");
    const client = new MockApiClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).listProviders = async () => ["codecommit"];
    renderWithProviders(<Connections />, client);
    await screen.findByText("회사 GitHub"); // 기존 연결 목록 로드 대기
    fireEvent.click(screen.getByRole("button", { name: /연결 추가/ }));

    const dialog = await screen.findByRole("dialog", { name: "저장소 연결 추가" });
    await within(dialog).findByText("AWS 저장소(CodeCommit)");
    const choices = within(dialog)
      .getAllByRole("button")
      .filter((b) => b.className.includes("choice"));
    expect(choices.length).toBe(1);
    expect(within(dialog).queryByText("GitHub")).toBeNull();
    expect(within(dialog).queryByText("GitLab")).toBeNull();
  });
});
