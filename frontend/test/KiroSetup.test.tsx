/**
 * Kiro 설정 다운로드 페이지 (frontend-engineer L1 컴포넌트 테스트).
 *
 * 검증:
 *  1) 페이지가 렌더되고 핵심 안내 문구가 보인다.
 *  2) 다운로드 버튼(a[download])의 href가 정확하다 — config.kiroConfigUrl 우선, 없으면 기본 경로 폴백.
 *  3) 탑바 "Kiro 설정" 링크를 누르면 #/kiro-setup 으로 이동한다.
 *  4) 사용자 화면 금지 용어(apphub-conventions §6)가 노출되지 않는다.
 *     (Dockerfile/Kiro/.kiro/8080은 예외 — 사용자가 실제 다루는 단어라 허용)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { KiroSetup } from "../src/screens/user/KiroSetup.js";
import { TopBar } from "../src/components/common.js";
import { AuthProvider } from "../src/auth/AuthContext.js";
import {
  DEFAULT_KIRO_CONFIG_URL,
  setConfigForTest,
  type RuntimeConfig,
} from "../src/lib/config.js";
import { renderWithProviders, seedSession, setHash, MOCK_CONFIG } from "./harness.js";

// 사용자 화면에 등장하면 안 되는 AWS 내부 용어. (forbidden-terms.test.tsx와 동일 기준)
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

describe("Kiro 설정 다운로드 페이지", () => {
  beforeEach(() => {
    localStorage.clear();
    seedSession("user");
    setHash("/kiro-setup");
  });

  afterEach(() => {
    // 다음 테스트가 오염된 config를 물지 않도록 목 설정으로 되돌린다.
    setConfigForTest(MOCK_CONFIG);
  });

  it("페이지가 렌더되고 핵심 안내 문구가 보인다", async () => {
    renderWithProviders(<KiroSetup />);
    expect(await screen.findByText("Kiro 설정 다운로드")).toBeInTheDocument();
    expect(screen.getByText(/왜 필요한가요/)).toBeInTheDocument();
    expect(screen.getByText(/무엇이 들어있나요/)).toBeInTheDocument();
  });

  it("설치 안내가 4단계로, 커밋 검사(pre-commit) 방식으로 표시된다", async () => {
    renderWithProviders(<KiroSetup />);
    await screen.findByText("Kiro 설정 다운로드");
    // 3단계 → 4단계로 갱신됨.
    expect(screen.getByText(/설치하는 법 \(4단계\)/)).toBeInTheDocument();
    // 4개 단계 카드의 제목이 모두 보인다.
    expect(screen.getByText("받은 파일 압축 풀기")).toBeInTheDocument();
    expect(screen.getByText("프로젝트 맨 위에 복사")).toBeInTheDocument();
    expect(screen.getByText("검사 설치 한 번 실행")).toBeInTheDocument();
    expect(screen.getByText("이제부터 자동 검사")).toBeInTheDocument();
    // 설치 스크립트 실행 명령 안내(여러 섹션에 등장하므로 존재만 확인).
    expect(screen.getAllByText(/install-hooks\.sh/).length).toBeGreaterThan(0);
    // 비개발자 대안(Kiro에게 요청) 문구.
    expect(screen.getByText(/커밋 검사 설치해줘/)).toBeInTheDocument();
  });

  it("폴더 트리에 새 번들 구성(steering + hooks/pre-commit + install-hooks.sh)이 반영된다", async () => {
    renderWithProviders(<KiroSetup />);
    await screen.findByText("Kiro 설정 다운로드");
    const tree = screen.getByLabelText("폴더 구조 예시");
    const treeText = tree.textContent ?? "";
    expect(treeText).toContain(".kiro/");
    expect(treeText).toContain("steering/");
    expect(treeText).toContain("deployment-standard.md");
    expect(treeText).toContain("hooks/");
    expect(treeText).toContain("pre-commit");
    expect(treeText).toContain("install-hooks.sh");
    // 옛 Kiro hook 파일은 더 이상 트리에 없다.
    expect(treeText).not.toContain("validate-deploy-ready.kiro.hook");
  });

  it("'무엇이 들어있나요'에 커밋 검사와 설치 스크립트가 안내된다", async () => {
    renderWithProviders(<KiroSetup />);
    await screen.findByText("Kiro 설정 다운로드");
    expect(screen.getByText(/배포 표준 지침 \(steering\)/)).toBeInTheDocument();
    expect(screen.getByText(/커밋 검사 \(pre-commit\)/)).toBeInTheDocument();
    expect(screen.getByText(/설치 스크립트 \(install-hooks\.sh\)/)).toBeInTheDocument();
  });

  it("팁에 '커밋이 멈췄을 때 안내를 Kiro에게 붙여넣기' 가이드가 있다", async () => {
    renderWithProviders(<KiroSetup />);
    await screen.findByText("Kiro 설정 다운로드");
    expect(screen.getByText(/커밋이 멈췄을 때/)).toBeInTheDocument();
  });

  it("config에 kiroConfigUrl이 없으면 기본 경로로 다운로드 링크를 건다", async () => {
    // MOCK_CONFIG에는 kiroConfigUrl이 없다 → 기본 경로 폴백.
    renderWithProviders(<KiroSetup />);
    const dl = await screen.findByTestId("kiro-download");
    expect(dl).toHaveAttribute("href", DEFAULT_KIRO_CONFIG_URL);
    expect(dl).toHaveAttribute("download");
  });

  it("config에 kiroConfigUrl이 있으면 그 값으로 다운로드 링크를 건다", async () => {
    const custom = "https://cdn.example.com/kiro-config/kiro-config.zip";
    const cfg: RuntimeConfig = { ...MOCK_CONFIG, kiroConfigUrl: custom };
    // renderWithProviders는 내부적으로 setConfigForTest(MOCK_CONFIG)로 설정을 초기화하므로,
    // 여기서는 커스텀 설정을 주입한 뒤 직접 렌더한다(KiroSetup은 useAuth만 필요, useApi 미사용).
    setConfigForTest(cfg);
    render(
      <AuthProvider config={cfg}>
        <KiroSetup />
      </AuthProvider>,
    );
    const dl = await screen.findByTestId("kiro-download");
    expect(dl).toHaveAttribute("href", custom);
  });

  it("사용자 화면에 AWS 내부 용어가 노출되지 않는다", async () => {
    renderWithProviders(<KiroSetup />);
    await screen.findByText("Kiro 설정 다운로드");
    const text = document.body.textContent ?? "";
    for (const term of FORBIDDEN) {
      expect(text.includes(term), `Kiro 설정 페이지에 금지 용어 '${term}'가 노출됨`).toBe(false);
    }
  });
});

describe("탑바 · Kiro 설정 진입점", () => {
  beforeEach(() => {
    localStorage.clear();
    setHash("/");
  });

  it("'Kiro 설정' 링크를 누르면 #/kiro-setup 으로 이동한다", async () => {
    seedSession("user");
    renderWithProviders(<TopBar userInitial="이" onLogout={() => {}} />);
    const link = await screen.findByRole("button", { name: /Kiro 설정/ });
    fireEvent.click(link);
    await waitFor(() => expect(window.location.hash).toBe("#/kiro-setup"));
  });

  it("admin 그룹에게도 'Kiro 설정' 링크가 보인다 (user/admin 공통)", async () => {
    seedSession("admin");
    renderWithProviders(<TopBar userInitial="관" onLogout={() => {}} />);
    expect(await screen.findByRole("button", { name: /Kiro 설정/ })).toBeInTheDocument();
  });
});
