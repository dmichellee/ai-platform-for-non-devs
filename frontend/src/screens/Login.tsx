/**
 * 로그인 화면 — D21 자체 로그인(이메일/비밀번호, 첫 로그인 새 비밀번호, 비밀번호 찾기).
 * 실서비스: 이 화면에서 바로 로그인 서버 API를 호출한다(다른 페이지로 이동하지 않음).
 * 목/데모: 사용자·관리자 우회 버튼.
 *
 * 용어 사전: "Cognito"는 화면에 노출하지 않는다("로그인", "회사 계정").
 * 디자인(ui-ux-pro-max ux 가이드): 보이는 label + 필드 아래 hint, 오류는 role=alert로 폼 바로 위,
 * 제출 중 로딩 표시, 비밀번호 보기/숨기기 토글, 다단계 흐름에는 항상 "돌아가기" 경로.
 */
import { useState, type FormEvent } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  LogIn,
  Mail,
  ShieldCheck,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import { BrandMark } from "../components/common.js";
import { ThemeToggle } from "../components/ThemeToggle.js";
import { useAuth, type NewPasswordChallenge } from "../auth/AuthContext.js";
import { authErrorMessage, PASSWORD_RULE_HINT, type AuthStep } from "../auth/cognitoIdp.js";
import { getCachedConfig } from "../lib/config.js";

const PASSWORD_MISMATCH = "두 비밀번호가 서로 달라요. 같은 비밀번호를 두 번 입력해주세요.";
const RESET_DONE = "비밀번호를 바꿨어요. 새 비밀번호로 로그인해주세요.";

type Step =
  | { kind: "signIn" }
  | { kind: "newPassword"; challenge: NewPasswordChallenge }
  | { kind: "forgot" }
  | { kind: "confirmForgot"; destination?: string };

export function Login(): JSX.Element {
  const { loginMock, notice } = useAuth();
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

        {!mock && <LoginForms />}

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

/** 실서비스 로그인 단계 전환(로그인 → 새 비밀번호 / 비밀번호 찾기 → 코드 입력). */
function LoginForms(): JSX.Element {
  const { signIn, completeNewPassword, requestPasswordReset, confirmPasswordReset, clearNotice } =
    useAuth();
  const [step, setStep] = useState<Step>({ kind: "signIn" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const go = (next: Step): void => {
    setError(null);
    setSuccess(null);
    setPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setCode("");
    setStep(next);
  };

  /** 제출 공통 — 로딩 표시 + 오류를 한국어 안내로 바꿔 보여준다. */
  const run = async (errStep: AuthStep, fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    clearNotice();
    try {
      await fn();
    } catch (e) {
      setError(authErrorMessage(e, errStep));
    } finally {
      setBusy(false);
    }
  };

  const onSignIn = (e: FormEvent): void => {
    e.preventDefault();
    void run("signIn", async () => {
      const res = await signIn(email, password);
      if (res.status === "NEW_PASSWORD_REQUIRED") go({ kind: "newPassword", challenge: res.challenge });
    });
  };

  const onNewPassword = (e: FormEvent): void => {
    e.preventDefault();
    if (step.kind !== "newPassword") return;
    if (newPassword !== confirmPassword) {
      setError(PASSWORD_MISMATCH);
      return;
    }
    const { challenge } = step;
    void run("newPassword", () => completeNewPassword(challenge, newPassword));
  };

  const onForgot = (e: FormEvent): void => {
    e.preventDefault();
    void run("forgot", async () => {
      const { destination } = await requestPasswordReset(email);
      go(destination ? { kind: "confirmForgot", destination } : { kind: "confirmForgot" });
    });
  };

  const onResend = (): void => {
    void run("forgot", async () => {
      const { destination } = await requestPasswordReset(email);
      setSuccess("인증 코드를 다시 보냈어요. 메일함을 확인해주세요.");
      setStep(destination ? { kind: "confirmForgot", destination } : { kind: "confirmForgot" });
    });
  };

  const onConfirmForgot = (e: FormEvent): void => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setError(PASSWORD_MISMATCH);
      return;
    }
    void run("confirmForgot", async () => {
      await confirmPasswordReset(email, code, newPassword);
      go({ kind: "signIn" });
      setSuccess(RESET_DONE);
    });
  };

  const banner = (
    <>
      {error && (
        <div className="notice error" role="alert">
          <TriangleAlert size={18} className="icon" />
          <div>{error}</div>
        </div>
      )}
      {success && (
        <div className="notice success" role="status">
          <CheckCircle2 size={18} className="icon" />
          <div>{success}</div>
        </div>
      )}
    </>
  );

  if (step.kind === "newPassword") {
    return (
      <form className="login-form" onSubmit={onNewPassword} noValidate>
        <h2 className="login-step-title">새 비밀번호를 정해주세요</h2>
        <div className="login-step-desc">
          처음 로그인하셨네요. 관리자가 알려준 임시 비밀번호 대신 앞으로 쓸 비밀번호를 정해주세요.
        </div>
        {banner}
        <PasswordField
          id="login-new-password"
          label="새 비밀번호"
          value={newPassword}
          onChange={setNewPassword}
          autoComplete="new-password"
          hint={PASSWORD_RULE_HINT}
        />
        <PasswordField
          id="login-new-password-confirm"
          label="새 비밀번호 확인"
          value={confirmPassword}
          onChange={setConfirmPassword}
          autoComplete="new-password"
        />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy || !newPassword || !confirmPassword}
        >
          <KeyRound size={16} className="icon" />
          {busy ? "저장하는 중…" : "비밀번호 정하고 시작하기"}
        </button>
        <BackLink onClick={() => go({ kind: "signIn" })} label="처음으로 돌아가기" />
      </form>
    );
  }

  if (step.kind === "forgot") {
    return (
      <form className="login-form" onSubmit={onForgot} noValidate>
        <h2 className="login-step-title">비밀번호 찾기</h2>
        <div className="login-step-desc">
          로그인에 쓰는 회사 이메일을 입력하면 비밀번호를 바꿀 수 있는 인증 코드를 보내드려요.
        </div>
        {banner}
        <EmailField value={email} onChange={setEmail} />
        <button type="submit" className="btn btn-primary" disabled={busy || !email.trim()}>
          <Mail size={16} className="icon" />
          {busy ? "보내는 중…" : "인증 코드 받기"}
        </button>
        <BackLink onClick={() => go({ kind: "signIn" })} label="로그인으로 돌아가기" />
      </form>
    );
  }

  if (step.kind === "confirmForgot") {
    return (
      <form className="login-form" onSubmit={onConfirmForgot} noValidate>
        <h2 className="login-step-title">새 비밀번호 설정</h2>
        <div className="login-step-desc">
          {step.destination ? <b>{step.destination}</b> : "입력하신 이메일"}(으)로 보낸 인증 코드를
          입력하고, 새 비밀번호를 정해주세요.
        </div>
        {banner}
        <div className="field">
          <label htmlFor="login-code">인증 코드</label>
          <input
            id="login-code"
            className="input mono"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <div className="hint">메일이 안 보이면 스팸함도 확인해주세요.</div>
        </div>
        <PasswordField
          id="login-reset-password"
          label="새 비밀번호"
          value={newPassword}
          onChange={setNewPassword}
          autoComplete="new-password"
          hint={PASSWORD_RULE_HINT}
        />
        <PasswordField
          id="login-reset-password-confirm"
          label="새 비밀번호 확인"
          value={confirmPassword}
          onChange={setConfirmPassword}
          autoComplete="new-password"
        />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy || !code.trim() || !newPassword || !confirmPassword}
        >
          <KeyRound size={16} className="icon" />
          {busy ? "바꾸는 중…" : "비밀번호 바꾸기"}
        </button>
        <div className="login-links">
          <button type="button" className="login-link" onClick={onResend} disabled={busy}>
            코드 다시 받기
          </button>
          <button type="button" className="login-link" onClick={() => go({ kind: "signIn" })}>
            로그인으로 돌아가기
          </button>
        </div>
      </form>
    );
  }

  return (
    <form className="login-form" onSubmit={onSignIn} noValidate>
      {banner}
      <EmailField value={email} onChange={setEmail} />
      <PasswordField
        id="login-password"
        label="비밀번호"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
      />
      <button type="submit" className="btn btn-primary" disabled={busy || !email.trim() || !password}>
        <LogIn size={16} className="icon" />
        {busy ? "로그인하는 중…" : "로그인"}
      </button>
      <div className="login-links">
        <button type="button" className="login-link" onClick={() => go({ kind: "forgot" })}>
          비밀번호를 잊으셨나요?
        </button>
      </div>
      <div className="login-help">
        계정이 없다면 관리자에게 초대를 요청해주세요. 처음 로그인할 때는 초대 메일의 임시 비밀번호를
        입력하면 돼요.
      </div>
    </form>
  );
}

function EmailField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}): JSX.Element {
  return (
    <div className="field">
      <label htmlFor="login-email">회사 이메일</label>
      <input
        id="login-email"
        className="input"
        type="email"
        autoComplete="username"
        placeholder="name@company.com"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  hint?: string;
}): JSX.Element {
  const [visible, setVisible] = useState(false);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="input-with-action">
        <input
          id={id}
          className="input"
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="input-action"
          aria-label={visible ? `${label} 숨기기` : `${label} 보기`}
          aria-pressed={visible}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

function BackLink({ onClick, label }: { onClick: () => void; label: string }): JSX.Element {
  return (
    <div className="login-links">
      <button type="button" className="login-link" onClick={onClick}>
        <ArrowLeft size={14} className="icon" />
        {label}
      </button>
    </div>
  );
}
