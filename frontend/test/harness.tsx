/**
 * 테스트 하네스 — 목 설정 + 목/주입 API + 인증 컨텍스트로 화면을 감싼다.
 * 로그인 우회: config.mock=true 로 두고 세션을 localStorage에 심어 즉시 인증 상태로 만든다.
 */
import type { ReactNode } from "react";
import { render, type RenderResult } from "@testing-library/react";
import { AuthProvider } from "../src/auth/AuthContext.js";
import { ApiProvider } from "../src/lib/ApiProvider.js";
import { setConfigForTest, type RuntimeConfig } from "../src/lib/config.js";
import type { ApiClient } from "../src/lib/api.js";
import { MockApiClient } from "../src/mock/mockApi.js";
import { base64UrlEncode } from "../src/auth/tokens.js";

export const MOCK_CONFIG: RuntimeConfig = {
  apiUrl: "",
  userPoolId: "",
  userPoolClientId: "",
  stage: "test",
  mock: true,
};

const b64 = base64UrlEncode;

/** 세션 클레임 재정의 옵션 — 표시명 폴백 검증용(name 없음/email만/둘 다 없음). */
export interface SeedOverrides {
  /** null이면 name 클레임 자체를 제거(Cognito name 미설정 상황 재현). */
  name?: string | null;
  /** null이면 email을 빈 문자열로(둘 다 없는 상황 재현). */
  email?: string | null;
}

/** 목 세션을 localStorage에 심는다 (로그인 우회). overrides로 name/email 없는 경우도 재현. */
export function seedSession(
  group: "user" | "admin" = "user",
  overrides: SeedOverrides = {},
): void {
  const name = overrides.name === undefined ? (group === "admin" ? "관리자" : "이다은") : overrides.name;
  const email =
    overrides.email === undefined
      ? group === "admin"
        ? "admin@example.com"
        : "daeun@example.com"
      : (overrides.email ?? "");
  const claims = {
    sub: group === "admin" ? "admin-0001" : "user-0001",
    email,
    ...(name ? { name } : {}),
    "cognito:groups": group === "admin" ? ["admin", "user"] : ["user"],
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const idToken = `${b64({ alg: "none" })}.${b64(claims)}.`;
  localStorage.setItem(
    "apphub-session",
    JSON.stringify({
      sub: claims.sub,
      email,
      ...(name ? { name } : {}),
      groups: claims["cognito:groups"],
      idToken,
      expiresAt: claims.exp * 1000,
    }),
  );
}

export function setHash(hash: string): void {
  window.location.hash = hash.startsWith("#") ? hash : `#${hash}`;
}

/** 화면을 프로바이더로 감싸 렌더. api를 주입하면 목 대신 그 클라이언트를 쓴다. */
export function renderWithProviders(ui: ReactNode, api?: ApiClient): RenderResult {
  setConfigForTest(MOCK_CONFIG);
  const client = api ?? new MockApiClient();
  return render(
    <AuthProvider config={MOCK_CONFIG}>
      <ApiProvider
        config={MOCK_CONFIG}
        auth={{
          ensureFreshToken: async () => "test-token",
          onUnauthorized: async () => null,
        }}
        client={client}
      >
        {ui}
      </ApiProvider>
    </AuthProvider>,
  );
}
