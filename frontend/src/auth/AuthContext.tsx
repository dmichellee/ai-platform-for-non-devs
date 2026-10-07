/**
 * 인증 컨텍스트 — D21 자체 로그인. 로그인 서버(cognito-idp) API를 fetch로 직접 호출한다(외부 SDK 없음).
 *   로그인        InitiateAuth(USER_PASSWORD_AUTH)
 *   첫 로그인     RespondToAuthChallenge(NEW_PASSWORD_REQUIRED)
 *   비밀번호 찾기 ForgotPassword / ConfirmForgotPassword
 *   갱신          InitiateAuth(REFRESH_TOKEN_AUTH)  (tokens.refreshTokens)
 *   로그아웃      RevokeToken
 * 그룹 기반(admin/user) 화면 분기의 단일 판단 지점. Hosted UI 리다이렉트·/oauth2/* 는 쓰지 않는다.
 *
 * 목 모드(config.mock=true)에서는 로그인 서버 없이 "사용자로 둘러보기 / 관리자로 둘러보기" 버튼으로 세션을 만든다 → QA 우회.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { navigate } from "../lib/router.js";
import { resolveCognitoIdpEndpoint, type RuntimeConfig } from "../lib/config.js";
import {
  confirmForgotPassword,
  forgotPassword,
  IdpError,
  initiatePasswordAuth,
  respondNewPassword,
  revokeToken,
  type InitiateAuthResponse,
} from "./cognitoIdp.js";
import {
  base64UrlEncode,
  isAdmin,
  isExpired,
  needsRefresh,
  refreshTokens,
  sessionFromTokens,
  type UserSession,
} from "./tokens.js";

const STORAGE_KEY = "apphub-session";

/** 세션이 만료로 종료됐을 때 로그인 화면에 보여줄 안내. */
export const SESSION_EXPIRED_MESSAGE = "로그인이 만료됐어요. 다시 로그인해주세요.";

/** 첫 로그인(임시 비밀번호) — 새 비밀번호 설정에 필요한 값. 화면이 들고 있다가 completeNewPassword에 넘긴다. */
export interface NewPasswordChallenge {
  session: string;
  username: string;
}

export type SignInResult =
  | { status: "SIGNED_IN" }
  | { status: "NEW_PASSWORD_REQUIRED"; challenge: NewPasswordChallenge };

interface AuthState {
  session: UserSession | null;
  ready: boolean;
  isAdmin: boolean;
  /** 만료 등으로 세션이 강제 종료됐을 때의 안내(로그인 화면에서 노출). */
  notice: string | null;
  clearNotice: () => void;
  /** 이메일/비밀번호 로그인. 실패는 IdpError를 던진다(화면이 authErrorMessage로 안내). */
  signIn: (email: string, password: string) => Promise<SignInResult>;
  /** 첫 로그인 새 비밀번호 설정 → 성공 시 바로 로그인 상태. */
  completeNewPassword: (challenge: NewPasswordChallenge, newPassword: string) => Promise<void>;
  /** 비밀번호 찾기 — 인증 코드 발송. destination은 가려진 이메일(예: d***@e***). */
  requestPasswordReset: (email: string) => Promise<{ destination?: string }>;
  /** 인증 코드 + 새 비밀번호로 재설정. 성공 후 화면이 다시 로그인하게 한다. */
  confirmPasswordReset: (email: string, code: string, newPassword: string) => Promise<void>;
  loginMock: (group: "user" | "admin") => void; // 목 모드 우회
  logout: () => void;
  getToken: () => string | null;
  /**
   * API 호출 직전 선제 토큰 확보. 만료(임박)면 조용히 refresh 시도.
   * 유효 토큰을 돌려주고, 갱신 불가면 세션 종료 후 null.
   */
  ensureFreshToken: () => Promise<string | null>;
  /**
   * 401(UNAUTHENTICATED) 수신 시 호출. refresh 시도해 새 토큰을 돌려주고(재시도용),
   * 실패면 세션 종료 + 로그인 이동 후 null.
   */
  handleUnauthorized: () => Promise<string | null>;
}

const AuthContext = createContext<AuthState | null>(null);

function loadStoredRaw(): UserSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as UserSession;
  } catch {
    return null;
  }
}

/** 유효한(미만료) 저장 세션만. 만료됐으면 null. */
function loadStored(): UserSession | null {
  const s = loadStoredRaw();
  if (!s) return null;
  if (s.expiresAt && Date.now() > s.expiresAt) return null;
  return s;
}

/** 만료 여부를 무시하고 저장 세션 원본을 읽는다(만료된 세션의 refresh_token 복구용). */
function loadStoredIgnoringExpiry(): UserSession | null {
  return loadStoredRaw();
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

export function AuthProvider({
  config,
  children,
}: {
  config: RuntimeConfig;
  children: ReactNode;
}): JSX.Element {
  const [session, setSession] = useState<UserSession | null>(null);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // 최신 세션을 동기 참조로 유지 — 콜백(ensureFreshToken/handleUnauthorized)이
  // stale 클로저 없이 현재 세션을 읽도록. refreshInFlight는 동시 401 폭주 시 refresh 1회로 합침.
  const endpoint = resolveCognitoIdpEndpoint(config);
  const sessionRef = useRef<UserSession | null>(null);
  sessionRef.current = session;
  const refreshInFlight = useRef<Promise<UserSession | null> | null>(null);

  const applySession = useCallback((s: UserSession | null): void => {
    sessionRef.current = s;
    setSession(s);
    store(s);
  }, []);

  /**
   * refresh 1회 실행(동시 호출은 합침). 성공 시 세션 반영, 실패 시 null.
   * refreshTokenOverride: 부트 복구처럼 in-memory 세션이 아직 없을 때 명시 전달.
   */
  const doRefresh = useCallback(
    async (refreshTokenOverride?: string): Promise<UserSession | null> => {
      if (refreshInFlight.current) return refreshInFlight.current;
      if (config.mock) return sessionRef.current; // 목 모드는 갱신 불필요(만료 우회).
      // 명시 override → 현재 in-memory 세션의 refresh_token → 저장소(만료 포함) 순으로 복구.
      const refreshToken =
        refreshTokenOverride ??
        sessionRef.current?.refreshToken ??
        loadStoredIgnoringExpiry()?.refreshToken;
      if (!refreshToken || !endpoint) return null;
      const p = (async () => {
        const next = await refreshTokens(
          { userPoolClientId: config.userPoolClientId, endpoint },
          refreshToken,
        );
        if (next) applySession(next);
        return next;
      })();
      refreshInFlight.current = p;
      try {
        return await p;
      } finally {
        refreshInFlight.current = null;
      }
    },
    [config, endpoint, applySession],
  );

  /** 세션 종료 + 로그인 화면으로. 안내 문구를 남긴다(로그인 화면이 노출). */
  const endSession = useCallback(
    (reason: string): void => {
      applySession(null);
      setNotice(reason);
      navigate("/login");
    },
    [applySession],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 저장된 세션. 만료됐어도 refresh_token이 있으면 조용히 갱신 시도(열어둔 탭 만료 복구).
      //    만료 세션의 refresh_token은 applySession(null)이 저장소를 비우기 전에 미리 확보한다.
      const stored = loadStored();
      const expiredRefreshToken = stored ? undefined : loadStoredIgnoringExpiry()?.refreshToken;
      if (!cancelled) applySession(stored);
      if (!stored && !config.mock && endpoint && expiredRefreshToken) {
        const refreshed = await doRefresh(expiredRefreshToken).catch(() => null);
        if (!cancelled && refreshed) setNotice(null);
      }
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [config, endpoint, applySession, doRefresh]);

  /** 로그인 API 주소 — 설정 누락이면 설정 오류로 던진다(화면은 "로그인 설정에 문제" 안내). */
  const requireEndpoint = useCallback((): string => {
    if (!endpoint) throw new IdpError("InvalidUserPoolConfigurationException", "endpoint missing");
    return endpoint;
  }, [endpoint]);

  /** 토큰 응답 → 세션 반영. 토큰이 없으면 예상 밖 응답으로 본다. */
  const acceptTokens = useCallback(
    (res: InitiateAuthResponse): void => {
      const idToken = res.AuthenticationResult?.IdToken;
      const s = idToken ? sessionFromTokens(idToken, res.AuthenticationResult?.RefreshToken) : null;
      if (!s) throw new IdpError(res.ChallengeName ? "UnsupportedChallenge" : "UnknownError", "no tokens");
      applySession(s);
      setNotice(null);
    },
    [applySession],
  );

  const signIn = useCallback(
    async (email: string, password: string): Promise<SignInResult> => {
      const username = email.trim();
      const res = await initiatePasswordAuth(
        requireEndpoint(),
        config.userPoolClientId,
        username,
        password,
      );
      if (res.ChallengeName === "NEW_PASSWORD_REQUIRED" && res.Session) {
        return {
          status: "NEW_PASSWORD_REQUIRED",
          challenge: {
            session: res.Session,
            // 이메일 별칭 로그인 — 챌린지 응답에는 실제 사용자 이름(USER_ID_FOR_SRP)을 쓴다.
            username: res.ChallengeParameters?.USER_ID_FOR_SRP || username,
          },
        };
      }
      acceptTokens(res);
      return { status: "SIGNED_IN" };
    },
    [config, requireEndpoint, acceptTokens],
  );

  const completeNewPassword = useCallback(
    async (challenge: NewPasswordChallenge, newPassword: string): Promise<void> => {
      const res = await respondNewPassword(
        requireEndpoint(),
        config.userPoolClientId,
        challenge.session,
        challenge.username,
        newPassword,
      );
      acceptTokens(res);
    },
    [config, requireEndpoint, acceptTokens],
  );

  const requestPasswordReset = useCallback(
    async (email: string): Promise<{ destination?: string }> => {
      const res = await forgotPassword(requireEndpoint(), config.userPoolClientId, email.trim());
      const destination = res.CodeDeliveryDetails?.Destination;
      return destination ? { destination } : {};
    },
    [config, requireEndpoint],
  );

  const confirmPasswordReset = useCallback(
    async (email: string, code: string, newPassword: string): Promise<void> => {
      await confirmForgotPassword(
        requireEndpoint(),
        config.userPoolClientId,
        email.trim(),
        code.trim(),
        newPassword,
      );
    },
    [config, requireEndpoint],
  );

  const loginMock = useCallback(
    (group: "user" | "admin") => {
      applySession(makeMockSession(group));
      setNotice(null);
    },
    [applySession],
  );

  /**
   * 로그아웃 — 화면은 즉시 로그인으로 돌리고, refresh_token 폐기(RevokeToken)는 뒤에서 보낸다.
   * 폐기 실패(네트워크 등)여도 로컬 세션은 이미 지웠으므로 사용자에게 오류를 보이지 않는다.
   */
  const logout = useCallback(() => {
    const refreshToken = sessionRef.current?.refreshToken;
    applySession(null);
    setNotice(null);
    navigate("/login");
    if (!config.mock && endpoint && refreshToken) {
      void revokeToken(endpoint, config.userPoolClientId, refreshToken).catch(() => undefined);
    }
  }, [config, endpoint, applySession]);

  const getToken = useCallback(() => session?.idToken ?? null, [session]);

  const clearNotice = useCallback(() => setNotice(null), []);

  /**
   * API 호출 직전 선제 토큰 확보. 유효하면 그대로, 만료(임박)면 조용히 refresh.
   * 목 모드는 항상 현재 토큰(만료 우회). refresh 불가/실패면 세션 종료 후 null.
   */
  const ensureFreshToken = useCallback(async (): Promise<string | null> => {
    const current = sessionRef.current;
    if (config.mock) return current?.idToken ?? null;
    if (current && !needsRefresh(current)) return current.idToken;
    // 만료(임박) — refresh 시도. current가 없거나(부트 복구) 만료면 doRefresh가 판단.
    const refreshed = await doRefresh();
    if (refreshed) return refreshed.idToken;
    // refresh 불가: 이미 만료된 세션이면 종료. 아직 유효(임박만)하면 기존 토큰 유지.
    if (current && !isExpired(current)) return current.idToken;
    if (current) endSession(SESSION_EXPIRED_MESSAGE);
    return null;
  }, [config, doRefresh, endSession]);

  /**
   * 401(UNAUTHENTICATED) 수신 시. refresh 성공하면 새 토큰(원 요청 재시도용),
   * 실패면 세션 종료 + 로그인 이동 후 null.
   */
  const handleUnauthorized = useCallback(async (): Promise<string | null> => {
    if (config.mock) return null; // 목 모드에서는 401 자체가 발생하지 않음.
    const refreshed = await doRefresh();
    if (refreshed) return refreshed.idToken;
    endSession(SESSION_EXPIRED_MESSAGE);
    return null;
  }, [config, doRefresh, endSession]);

  const value = useMemo<AuthState>(
    () => ({
      session,
      ready,
      isAdmin: isAdmin(session),
      notice,
      clearNotice,
      signIn,
      completeNewPassword,
      requestPasswordReset,
      confirmPasswordReset,
      loginMock,
      logout,
      getToken,
      ensureFreshToken,
      handleUnauthorized,
    }),
    [
      session,
      ready,
      notice,
      clearNotice,
      signIn,
      completeNewPassword,
      requestPasswordReset,
      confirmPasswordReset,
      loginMock,
      logout,
      getToken,
      ensureFreshToken,
      handleUnauthorized,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth는 AuthProvider 안에서만 사용할 수 있습니다.");
  return ctx;
}
