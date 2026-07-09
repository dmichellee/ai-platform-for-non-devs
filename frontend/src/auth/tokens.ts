/**
 * JWT 처리 — Cognito idToken에서 sub/이메일/그룹을 읽고 만료를 판단한다.
 * (검증은 API Gateway authorizer의 몫. 프론트는 클레임 파싱과 갱신 시점 판단만 한다.)
 */

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
  cognitoDomain?: string;
  userPoolClientId: string;
}

/**
 * refresh_token으로 idToken을 조용히 갱신한다(Cognito token endpoint, grant_type=refresh_token).
 * - refresh_token은 응답에 포함되지 않으므로 기존 값을 유지한다.
 * - 실패(만료된 refresh_token, 도메인 없음, 네트워크 오류 등)면 null을 돌려준다.
 *   호출 측이 null을 받으면 세션 클리어 + 로그인으로 보내는 판단을 한다.
 * code 교환(exchangeCodeForTokens)과 같은 엔드포인트/응답 형식을 쓴다.
 */
export async function refreshTokens(
  deps: RefreshDeps,
  refreshToken: string,
): Promise<UserSession | null> {
  if (!deps.cognitoDomain || !refreshToken) return null;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: deps.userPoolClientId,
    refresh_token: refreshToken,
  });
  let res: Response;
  try {
    res = await fetch(`https://${deps.cognitoDomain}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let json: { id_token?: string; refresh_token?: string };
  try {
    json = (await res.json()) as { id_token?: string; refresh_token?: string };
  } catch {
    return null;
  }
  if (!json.id_token) return null;
  // refresh_token 회전(rotation)을 켠 경우 새 값이 올 수 있고, 아니면 기존 값 유지.
  return sessionFromTokens(json.id_token, json.refresh_token ?? refreshToken);
}
