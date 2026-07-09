import { describe, it, expect, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { CreateWizard } from "../src/screens/user/CreateWizard.js";
import { renderWithProviders, seedSession, setHash } from "./harness.js";

describe("앱 생성 마법사 — 단계 전환", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
    setHash("/apps/new");
  });

  it("1단계(저장소)에서 시작한다", async () => {
    renderWithProviders(<CreateWizard />);
    expect(await screen.findByText("어떤 코드 저장소를 배포할까요?")).toBeInTheDocument();
  });

  it("저장소 선택·주소 입력 후 '다음 단계'로 2단계(이름·공개 범위)로 넘어간다", async () => {
    renderWithProviders(<CreateWizard />);
    // 사용 가능 연결(회사 GitHub)이 로드되면 클릭
    const conn = await screen.findByText("회사 GitHub");
    fireEvent.click(conn);
    // 저장소 주소 입력 (다음 활성 조건)
    fireEvent.change(screen.getByPlaceholderText(/https:\/\/github.com/), {
      target: { value: "https://github.com/example/x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
    expect(await screen.findByText("앱 이름과 접속 범위를 정해주세요")).toBeInTheDocument();
    // 공개 범위 라벨이 용어 사전대로 노출
    expect(screen.getByText("사내에서만 (권장)")).toBeInTheDocument();
    expect(screen.getByText("회사 밖에서도 접속")).toBeInTheDocument();
  });

  it("이름 입력 없이는 2→3단계로 넘어가지 못한다 (버튼 disabled)", async () => {
    renderWithProviders(<CreateWizard />);
    const conn = await screen.findByText("회사 GitHub");
    fireEvent.click(conn);
    fireEvent.change(screen.getByPlaceholderText(/https:\/\/github.com/), {
      target: { value: "https://github.com/example/x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
    await screen.findByText("앱 이름과 접속 범위를 정해주세요");
    const next = screen.getByRole("button", { name: /다음 단계/ });
    expect(next).toBeDisabled();
  });

  it("'이전'을 누르면 이전 단계로 돌아간다", async () => {
    renderWithProviders(<CreateWizard />);
    const conn = await screen.findByText("회사 GitHub");
    fireEvent.click(conn);
    fireEvent.change(screen.getByPlaceholderText(/https:\/\/github.com/), {
      target: { value: "https://github.com/example/x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
    await screen.findByText("앱 이름과 접속 범위를 정해주세요");
    fireEvent.click(screen.getByRole("button", { name: /이전/ }));
    await waitFor(() => expect(screen.getByText("어떤 코드 저장소를 배포할까요?")).toBeInTheDocument());
  });
});
