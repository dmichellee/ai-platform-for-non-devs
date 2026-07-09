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
    expect(screen.getByText(/설치하는 법/)).toBeInTheDocument();
    expect(screen.getByText(/무엇이 들어있나요/)).toBeInTheDocument();
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
