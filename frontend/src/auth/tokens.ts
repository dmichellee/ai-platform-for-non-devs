/**
 * JWT 처리 — Cognito idToken에서 sub/이메일/그룹을 읽고 만료를 판단한다.
 * (검증은 API Gateway authorizer의 몫. 프론트는 클레임 파싱과 갱신 시점 판단만 한다.)
 */
import { initiateRefreshAuth } from "./cognitoIdp.js";

export interface UserSession {
  sub: string;
  email: string;
  name?: string;
  groups: string[];
  idToken: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms
}

export function isAdmin(session: UserSession | null): boolean {
  return !!session && session.groups.includes("admin");
}

/**
 * 세션에서 화면에 표시할 이름을 뽑는다.
 * 우선순위: name(있으면) → email의 로컬파트(@ 앞) → 세션 없거나 둘 다 없으면 null.
 * null이면 호출 측에서 "님"만 단독으로 쓰도록 한다(예: "안녕하세요, 님").
 */
export function sessionDisplayName(session: UserSession | null): string | null {
  const name = session?.name?.trim();
  if (name) return name;
  const local = session?.email?.split("@")[0]?.trim();
  if (local) return local;
  return null;
}

/** 아바타/이니셜용 첫 글자. 표시명이 없으면 "나". */
export function sessionInitial(session: UserSession | null): string {
  return (sessionDisplayName(session) ?? "나").slice(0, 1);
}

/**
 * 저장소 이름 소유자 접두어 — 서버(POST /connections/{connId}/repos)가 base 이름 앞에
 * `{ownerPrefix}-` 를 강제 부착한다. 프론트는 미리보기·목 생성에서 **동일 규칙**을 구현한다.
 *
 * 규칙(백엔드와 합의):
 *  1) session.email 의 로컬파트(@ 앞)를 소문자화
 *  2) `[a-z0-9._-]` 외 문자는 `-` 로 치환
 *  3) 앞뒤 구분자(`-`,`.`,`_`) 제거
 *  4) email 없거나 결과가 비면 → session.sub 앞 8자 (같은 정제 규칙 적용)
 * 세션 자체가 없거나 둘 다 비면 빈 문자열("")을 돌려준다(호출 측이 접두어 없음으로 처리).
 */
export function computeOwnerPrefix(session: UserSession | null): string {
  const sanitize = (raw: string): string =>
    raw
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-._]+|[-._]+$/g, "");

  const local = session?.email?.split("@")[0] ?? "";
  const fromEmail = sanitize(local);
  if (fromEmail) return fromEmail;

  const sub = session?.sub ?? "";
  const fromSub = sanitize(sub.slice(0, 8));
  return fromSub;
}

interface IdTokenClaims {
  sub?: string;
  email?: string;
  name?: string;
  exp?: number;
  "cognito:groups"?: string[];
}

function base64UrlDecode(input: string): string {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
  // UTF-8 디코드 (한글 클레임 대비)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** UTF-8 안전 base64url 인코드 (한글 클레임 대비). */
export function base64UrlEncode(obj: object): string {
  const utf8 = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const byte of utf8) bin += String.fromCharCode(byte);
  const b64 = typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeIdToken(idToken: string): IdTokenClaims | null {
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = base64UrlDecode(parts[1]);
    return JSON.parse(payload) as IdTokenClaims;
  } catch {
    return null;
  }
}

export function sessionFromTokens(idToken: string, refreshToken?: string): UserSession | null {
  const claims = decodeIdToken(idToken);
  if (!claims?.sub) return null;
  return {
    sub: claims.sub,
    email: claims.email ?? "",
    ...(claims.name ? { name: claims.name } : {}),
    groups: claims["cognito:groups"] ?? ["user"],
    idToken,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt: (claims.exp ?? Math.floor(Date.now() / 1000) + 3600) * 1000,
  };
}

/** 만료 임박으로 보는 여유(ms). 이 시간 안이면 선제 갱신한다. */
export const REFRESH_LEEWAY_MS = 60_000;

/** 만료 60초 이내면 갱신 필요로 본다. */
export function needsRefresh(session: UserSession | null): boolean {
  if (!session) return false;
  return Date.now() > session.expiresAt - REFRESH_LEEWAY_MS;
}

/** 이미 만료된 세션인지(여유 없이 실제 만료 시각 기준). */
export function isExpired(session: UserSession | null): boolean {
  if (!session) return true;
  return Date.now() > session.expiresAt;
}

export interface RefreshDeps {
  /** 로그인 API 주소(resolveCognitoIdpEndpoint 결과). */
  endpoint?: string | null;
  userPoolClientId: string;
}

/**
 * refresh_token으로 idToken을 조용히 갱신한다(cognito-idp InitiateAuth REFRESH_TOKEN_AUTH — D21).
 * - 응답에 RefreshToken이 없으면(회전 미사용) 기존 값을 유지한다.
 * - 실패(만료·폐기된 refresh_token, 주소 없음, 네트워크 오류 등)면 null을 돌려준다.
 *   호출 측이 null을 받으면 세션 클리어 + 로그인으로 보내는 판단을 한다.
 */
export async function refreshTokens(
  deps: RefreshDeps,
  refreshToken: string,
): Promise<UserSession | null> {
  if (!deps.endpoint || !refreshToken) return null;
  try {
    const res = await initiateRefreshAuth(deps.endpoint, deps.userPoolClientId, refreshToken);
    const idToken = res.AuthenticationResult?.IdToken;
    if (!idToken) return null;
    return sessionFromTokens(idToken, res.AuthenticationResult?.RefreshToken ?? refreshToken);
  } catch {
    return null;
  }
}
