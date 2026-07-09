/**
 * 로그인 화면 — 실서비스: Cognito Hosted UI 로 이동. 목/데모: 사용자·관리자 우회 버튼.
 * 용어 사전: "Cognito"는 화면에 노출하지 않는다("회사 계정으로 로그인").
 */
import { Info, LogIn, ShieldCheck, UserRound } from "lucide-react";
import { BrandMark } from "../components/common.js";
import { ThemeToggle } from "../components/ThemeToggle.js";
import { useAuth } from "../auth/AuthContext.js";
import { getCachedConfig } from "../lib/config.js";

export function Login(): JSX.Element {
  const { loginRedirect, loginMock, notice } = useAuth();
  const cfg = getCachedConfig();
  const mock = cfg?.mock ?? true;

  return (
    <div className="login-screen">
      <div style={{ position: "absolute", top: 24, right: 24 }}>
        <ThemeToggle />
      </div>
      <div className="login-card">
        <BrandMark size={54} />
        <h1>AppHub</h1>
        <p>Kiro로 만든 앱을 회사 안에서 바로 배포하고 관리하세요.</p>

        {notice && (
          <div className="notice info" role="status">
            <Info size={18} className="icon" />
            <div>{notice}</div>
          </div>
        )}

        {!mock && (
          <button type="button" className="btn btn-primary" onClick={loginRedirect}>
            <LogIn size={16} className="icon" />
            회사 계정으로 로그인
          </button>
        )}

        {mock && (
          <>
            <button type="button" className="btn btn-primary" onClick={() => loginMock("user")}>
              <UserRound size={16} className="icon" />
              사용자로 둘러보기
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => loginMock("admin")}>
              <ShieldCheck size={16} className="icon" />
              관리자로 둘러보기
            </button>
            <p className="mock-note">
              지금은 미리보기 모드예요. 실제 배포 환경에서는 회사 계정 로그인으로 연결됩니다.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
