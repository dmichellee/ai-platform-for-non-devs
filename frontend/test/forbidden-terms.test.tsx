import { describe, it, expect, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { Dashboard } from "../src/screens/user/Dashboard.js";
import { AppDetail } from "../src/screens/user/AppDetail.js";
import { Connections } from "../src/screens/user/Connections.js";
import { CreateWizard } from "../src/screens/user/CreateWizard.js";
import { renderWithProviders, seedSession, setHash } from "./harness.js";

/**
 * 용어 사전 위반 검출 (apphub-conventions §6).
 * 사용자 화면 DOM 텍스트에 AWS 내부 용어가 노출되면 실패한다.
 * 관리자 화면은 예외이므로 제외한다. Dockerfile은 예외(Kiro 전달용) — 제외.
 *
 * 예외: "CodeCommit" — 저장소 provider는 GitHub/GitLab을 실제 브랜드명으로 노출하므로
 * 일관성을 위해 CodeCommit도 "AWS 저장소(CodeCommit)"로 고유명사 노출하기로 결정(사용자 승인).
 * 나머지 AWS 인프라 용어(ECS/ALB/Fargate 등)는 여전히 금지.
 */
const FORBIDDEN = [
  "ECS",
  "Fargate",
  "컨테이너",
  "ALB",
  "Target Group",
  "리스너",
  "CodeBuild",
  "CodePipeline",
  "파이프라인",
  "Cognito",
  "internet-facing",
  "internal",
  "IAM",
  "desiredCount",
  "scale-in",
];

function assertNoForbidden(): void {
  const text = document.body.textContent ?? "";
  for (const term of FORBIDDEN) {
    expect(text.includes(term), `사용자 화면에 금지 용어 '${term}'가 노출됨`).toBe(false);
  }
}

describe("사용자 화면 금지 용어 노출 검출", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
  });

  it("대시보드에 AWS 용어가 없다", async () => {
    setHash("/");
    renderWithProviders(<Dashboard />);
    await screen.findByText("고객문의 챗봇");
    assertNoForbidden();
  });

  it("앱 상세(RUNNING 앱)에 AWS 용어가 없다", async () => {
    setHash("/apps/a1b2c3d4");
    renderWithProviders(<AppDetail appId="a1b2c3d4" />);
    await waitFor(() => expect(screen.getByText("고객문의 챗봇")).toBeInTheDocument());
    assertNoForbidden();
  });

  it("앱 상세(FAILED 앱 — 실패 사유 노출)에 AWS 용어가 없다", async () => {
    // 픽스처 99887766: status=FAILED + failureReason(사용자용 한국어 요약).
    setHash("/apps/99887766");
    renderWithProviders(<AppDetail appId="99887766" />);
    await waitFor(() => expect(screen.getByText("재고 알림봇")).toBeInTheDocument());
    // 실패 사유 문구가 실제로 노출된 상태에서 금지 용어를 스캔한다.
    expect(screen.getByText(/배포 준비\(빌드 환경 구성\) 중 문제가 발생했어요/)).toBeInTheDocument();
    assertNoForbidden();
  });

  it("저장소 연결 관리에 AWS 용어(및 OAuth/CodeConnections)가 없다", async () => {
    setHash("/connections");
    renderWithProviders(<Connections />);
    await screen.findByText("회사 GitHub");
    const text = document.body.textContent ?? "";
    assertNoForbidden();
    expect(text.includes("CodeConnections")).toBe(false);
    expect(text.includes("OAuth")).toBe(false);
    // PENDING 연결의 사용자 안내는 '승인 대기 중'으로 노출 (배지 + 본문에 등장)
    expect(screen.getAllByText(/승인 대기 중/).length).toBeGreaterThan(0);
  });

  // 마법사에는 네트워크(VPC) 선택 UI가 없다(방침 ① — 플랫폼 자동 배치). 시간표 UI 만 스캔한다.
  it("앱 생성 마법사(공개 범위·시간표)에 AWS 용어(VPC 포함)가 없고 네트워크 UI 도 없다", async () => {
    setHash("/apps/new");
    renderWithProviders(<CreateWizard />);

    // 1단계 → 2단계(이름·공개 범위). 네트워크 선택 UI 는 존재하지 않아야 한다.
    fireEvent.click(await screen.findByText("회사 GitHub"));
    fireEvent.change(screen.getByPlaceholderText(/https:\/\/github.com/), {
      target: { value: "https://github.com/example/x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
    await screen.findByText("앱 이름과 접속 범위를 정해주세요");
    let text = document.body.textContent ?? "";
    assertNoForbidden();
    expect(text.includes("VPC")).toBe(false);
    expect(screen.queryByLabelText("네트워크")).not.toBeInTheDocument();

    // 6단계(가동 방식)까지 진행해 시간표 UI 도 스캔.
    fireEvent.change(screen.getByLabelText("앱 이름"), { target: { value: "용어 검사 앱" } });
    fireEvent.change(screen.getByLabelText("접속 주소"), { target: { value: "term-check" } });
    await screen.findByText("사용할 수 있는 주소예요");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /다음 단계/ })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
    fireEvent.click((await screen.findAllByText(/최소 .*대/))[0]!.closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
    await screen.findByText("어떤 기능을 사용하는 앱인가요?");
    fireEvent.click((await screen.findAllByRole("button")).find((b) => b.className.includes("choice"))!);
    fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
    await screen.findByText("앱에 전달할 설정값이 있나요?");
    fireEvent.click(screen.getByRole("button", { name: /다음 단계/ }));
    await screen.findByText("앱을 언제 켜둘까요?");
    fireEvent.click(screen.getByText("시간표대로"));
    await screen.findByLabelText("켜지는 시각");
    text = document.body.textContent ?? "";
    assertNoForbidden();
    expect(text.includes("VPC")).toBe(false);
    // 시간표 요일은 한글(월~일)로만 노출
    expect(screen.getByRole("button", { name: "월요일" })).toBeInTheDocument();
  });
});
