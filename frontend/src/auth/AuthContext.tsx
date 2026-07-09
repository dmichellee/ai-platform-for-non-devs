/**
 * 인증 컨텍스트 — Cognito Hosted UI(authorization code + PKCE 없는 implicit-free code grant는
 * 클라이언트 시크릿이 없어야 하므로, SPA용 public client는 token 엔드포인트 code 교환을 쓴다) 흐름 +
 * 목 모드 로그인 우회. 그룹 기반(admin/user) 화면 분기의 단일 판단 지점.
 *
 * 목 모드(config.mock=true)에서는 Cognito 없이 "사용자로 로그인 / 관리자로 로그인" 버튼으로 세션을 만든다 → QA 우회.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { RuntimeConfig } from "../lib/config.js";
import { base64UrlEncode, isAdmin, sessionFromTokens, type UserSession } from "./tokens.js";

const STORAGE_KEY = "apphub-session";

interface AuthState {
  session: UserSession | null;
  ready: boolean;
  isAdmin: boolean;
  loginRedirect: () => void; // Hosted UI 로 이동 (실서비스)
  loginMock: (group: "user" | "admin") => void; // 목 모드 우회
  logout: () => void;
  getToken: () => string | null;
}

const AuthContext = createContext<AuthState | null>(null);

function loadStored(): UserSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as UserSession;
    if (s.expiresAt && Date.now() > s.expiresAt) return null;
    return s;
  } catch {
    return null;
  }
}

function store(session: UserSession | null): void {
  try {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* noop */
  }
}

/** 목 세션 생성 — 서명 없는 형식적 JWT(헤더.페이로드.) 로 sub/그룹만 담는다. */
function makeMockSession(group: "user" | "admin"): UserSession {
  const claims = {
    sub: group === "admin" ? "admin-0001" : "user-0001",
    email: group === "admin" ? "admin@example.com" : "daeun@example.com",
    name: group === "admin" ? "관리자" : "이다은",
    "cognito:groups": group === "admin" ? ["admin", "user"] : ["user"],
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const token = `${base64UrlEncode({ alg: "none", typ: "JWT" })}.${base64UrlEncode(claims)}.`;
  return sessionFromTokens(token)!;
}

async function exchangeCodeForTokens(
  cfg: RuntimeConfig,
  code: string,
): Promise<UserSession | null> {
  if (!cfg.cognitoDomain) return null;
  const redirectUri = cfg.redirectUri ?? window.location.origin;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: cfg.userPoolClientId,
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetch(`https://${cfg.cognitoDomain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { id_token?: string; refresh_token?: string };
  if (!json.id_token) return null;
  return sessionFromTokens(json.id_token, json.refresh_token);
}

export function AuthProvider({
  config,
  children,
}: {
  config: RuntimeConfig;
  children: ReactNode;
}): JSX.Element {
  const [session, setSession] = useState<UserSession | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 1) Hosted UI 콜백 처리 (?code=...)
      const params = new URLSearchParams(window.location.search);
      const code = params.get("code");
      if (code && !config.mock) {
        const s = await exchangeCodeForTokens(config, code);
        if (!cancelled && s) {
          setSession(s);
          store(s);
        }
        // URL 정리
        window.history.replaceState({}, "", window.location.pathname + window.location.hash);
        if (!cancelled) setReady(true);
        return;
      }
      // 2) 저장된 세션
      const stored = loadStored();
      if (!cancelled) {
        setSession(stored);
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config]);

  const loginRedirect = useCallback(() => {
    if (!config.cognitoDomain) return;
    const redirectUri = cfg_redirect(config);
    const url = new URL(`https://${config.cognitoDomain}/oauth2/authorize`);
    url.searchParams.set("client_id", config.userPoolClientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("redirect_uri", redirectUri);
    window.location.assign(url.toString());
  }, [config]);

  const loginMock = useCallback((group: "user" | "admin") => {
    const s = makeMockSession(group);
    setSession(s);
    store(s);
  }, []);

  const logout = useCallback(() => {
    setSession(null);
    store(null);
    if (!config.mock && config.cognitoDomain) {
      const url = new URL(`https://${config.cognitoDomain}/logout`);
      url.searchParams.set("client_id", config.userPoolClientId);
      url.searchParams.set("logout_uri", cfg_redirect(config));
      window.location.assign(url.toString());
    }
  }, [config]);

  const getToken = useCallback(() => session?.idToken ?? null, [session]);

  const value = useMemo<AuthState>(
    () => ({
      session,
      ready,
      isAdmin: isAdmin(session),
      loginRedirect,
      loginMock,
      logout,
      getToken,
    }),
    [session, ready, loginRedirect, loginMock, logout, getToken],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function cfg_redirect(config: RuntimeConfig): string {
  return config.redirectUri ?? window.location.origin;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth는 AuthProvider 안에서만 사용할 수 있습니다.");
  return ctx;
}
