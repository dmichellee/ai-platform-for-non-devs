import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import {
  AuthProvider,
  SESSION_EXPIRED_MESSAGE,
  useAuth,
} from "../src/auth/AuthContext.js";
import { base64UrlEncode } from "../src/auth/tokens.js";
import type { RuntimeConfig } from "../src/lib/config.js";

/**
 * AuthContext 세션 갱신/만료 (문제 1 / D21) — 실서비스 config(mock=false)에서
 * refresh_token으로 조용히 갱신(cognito-idp InitiateAuth REFRESH_TOKEN_AUTH)하고,
 * 실패 시 세션 종료 + 로그인(/login) 이동 + 안내를 남긴다.
 */

const REAL_CONFIG: RuntimeConfig = {
  apiUrl: "https://api.test",
  userPoolId: "pool-1",
  userPoolClientId: "client-1",
  region: "ap-northeast-2",
  cognitoIdpEndpoint: "https://idp.test.example.com/",
  stage: "test",
  mock: false,
};

/** exp(초)로 idToken(형식적 JWT) 생성. */
function makeIdToken(sub: string, expEpochSec: number): string {
  const header = base64UrlEncode({ alg: "none", typ: "JWT" });
  const payload = base64UrlEncode({
    sub,
    email: "daeun@example.com",
    name: "이다은",
    "cognito:groups": ["user"],
    exp: expEpochSec,
  });
  return `${header}.${payload}.`;
}

/** 만료 상태(과거 exp) + refresh_token을 가진 세션을 localStorage에 심는다. */
function seedExpiredSessionWithRefresh(): void {
  const past = Math.floor(Date.now() / 1000) - 10;
  localStorage.setItem(
    "apphub-session",
    JSON.stringify({
      sub: "user-0001",
      email: "daeun@example.com",
      name: "이다은",
      groups: ["user"],
      idToken: makeIdToken("user-0001", past),
      refreshToken: "refresh-XYZ",
      expiresAt: past * 1000,
    }),
  );
}

interface Probe {
  ensure: () => Promise<string | null>;
  unauthorized: () => Promise<string | null>;
}
let probe: Probe;
let renderedNotice: string | null;
let ready = false;

function Capture(): JSX.Element {
  const { ensureFreshToken, handleUnauthorized, notice, session, ready: r } = useAuth();
  probe = { ensure: ensureFreshToken, unauthorized: handleUnauthorized };
  renderedNotice = notice;
  ready = r;
  return <div data-session={session ? "yes" : "no"}>{notice ?? ""}</div>;
}

/** 갱신된 IdToken을 돌려주는 InitiateAuth(REFRESH_TOKEN_AUTH) 응답(호출마다 새 Response — body 1회 소비 제약). */
function tokenEndpointOk(): Response {
  const fresh = makeIdToken("user-0001", Math.floor(Date.now() / 1000) + 3600);
  return new Response(
    JSON.stringify({
      AuthenticationResult: { IdToken: fresh, AccessToken: "acc", ExpiresIn: 3600, TokenType: "Bearer" },
      ChallengeParameters: {},
    }),
    { status: 200, headers: { "Content-Type": "application/x-amz-json-1.1" } },
  );
}

/**
 * 렌더 후 부트 복구(만료 세션의 refresh_token으로 조용한 갱신)가 끝날 때까지 기다린다.
 * 부트 refresh는 의도된 동작이므로, 이후 검증의 기준선을 맞추기 위해 mock 호출 기록을 비운다.
 */
async function settleBoot(fetchMock: ReturnType<typeof vi.fn>): Promise<void> {
  await waitFor(() => expect(ready).toBe(true));
  fetchMock.mockClear();
}

describe("AuthContext — 세션 갱신/만료", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    window.location.hash = "";
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("handleUnauthorized가 refresh 성공 시 새 토큰을 돌려주고 InitiateAuth REFRESH_TOKEN_AUTH로 요청한다", async () => {
    seedExpiredSessionWithRefresh();
    fetchMock.mockImplementation(async () => tokenEndpointOk());
    render(
      <AuthProvider config={REAL_CONFIG}>
        <Capture />
      </AuthProvider>,
    );
    await settleBoot(fetchMock);

    let token: string | null = null;
    await act(async () => {
      token = await probe.unauthorized();
    });

    expect(token).toBeTruthy();
    // 로그인 API 주소로 REFRESH_TOKEN_AUTH 요청을 보냈는지 (Hosted UI /oauth2/token 미사용)
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(REAL_CONFIG.cognitoIdpEndpoint);
    expect(String(url)).not.toContain("/oauth2/");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Amz-Target"]).toBe("AWSCognitoIdentityProviderService.InitiateAuth");
    expect(init.headers["Content-Type"]).toBe("application/x-amz-json-1.1");
    expect(JSON.parse(String(init.body))).toEqual({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: "client-1",
      AuthParameters: { REFRESH_TOKEN: "refresh-XYZ" },
    });
    // 응답에 RefreshToken이 없으면 기존 refresh_token을 유지한다
    const saved = JSON.parse(localStorage.getItem("apphub-session")!);
    expect(saved.refreshToken).toBe("refresh-XYZ");
  });

  it("refresh 실패(400 NotAuthorizedException)면 세션을 지우고 로그인 화면(/login)으로 보내며 만료 안내를 남긴다", async () => {
    seedExpiredSessionWithRefresh();
    // 부트 복구도, 이후 handleUnauthorized도 모두 실패(400).
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ __type: "NotAuthorizedException", message: "Refresh Token has been revoked" }),
          { status: 400 },
        ),
    );
    render(
      <AuthProvider config={REAL_CONFIG}>
        <Capture />
      </AuthProvider>,
    );
    await settleBoot(fetchMock);
    // 부트 복구 실패 시 세션은 복구되지 않는다(만료 세션 진입).
    expect(localStorage.getItem("apphub-session")).toBeNull();

    let token: string | null = "sentinel";
    await act(async () => {
      token = await probe.unauthorized();
    });

    expect(token).toBeNull();
    await waitFor(() => expect(renderedNotice).toBe(SESSION_EXPIRED_MESSAGE));
    expect(window.location.hash).toBe("#/login");
    expect(localStorage.getItem("apphub-session")).toBeNull();
  });

  it("만료 세션은 부트 시 refresh로 조용히 되살아나고, ensureFreshToken이 유효 토큰을 돌려준다", async () => {
    seedExpiredSessionWithRefresh();
    fetchMock.mockImplementation(async () => tokenEndpointOk());
    render(
      <AuthProvider config={REAL_CONFIG}>
        <Capture />
      </AuthProvider>,
    );
    await settleBoot(fetchMock);
    // 부트에서 되살아났으므로 세션이 다시 저장돼 있다
    expect(localStorage.getItem("apphub-session")).not.toBeNull();

    let token: string | null = null;
    await act(async () => {
      token = await probe.ensure();
    });
    expect(token).toBeTruthy();
  });

  it("동시 다발 401은 refresh를 1회로 합친다(토큰 엔드포인트 호출 1회)", async () => {
    seedExpiredSessionWithRefresh();
    fetchMock.mockImplementation(async () => tokenEndpointOk());
    render(
      <AuthProvider config={REAL_CONFIG}>
        <Capture />
      </AuthProvider>,
    );
    await settleBoot(fetchMock); // 부트 refresh 호출을 기준선에서 제외

    await act(async () => {
      await Promise.all([probe.unauthorized(), probe.unauthorized(), probe.unauthorized()]);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cognitoIdpEndpoint가 없으면 region으로 공용 로그인 API 주소를 만든다", async () => {
    seedExpiredSessionWithRefresh();
    fetchMock.mockImplementation(async () => tokenEndpointOk());
    const { cognitoIdpEndpoint: _omit, ...noEndpoint } = REAL_CONFIG;
    render(
      <AuthProvider config={noEndpoint}>
        <Capture />
      </AuthProvider>,
    );
    await waitFor(() => expect(ready).toBe(true));
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://cognito-idp.ap-northeast-2.amazonaws.com/",
    );
  });
});
