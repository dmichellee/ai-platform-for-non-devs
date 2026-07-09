import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiError, HttpApiClient, type AuthBridge } from "../src/lib/api.js";

/**
 * HttpApiClient 세션 만료 처리 (문제 1) — 실제 클라이언트 코드 경로.
 * - 요청 직전 ensureFreshToken으로 유효 토큰 확보(선제 갱신).
 * - 401(UNAUTHENTICATED) 수신 시 onUnauthorized로 갱신 시도 후, 새 토큰이 나오면 원 요청 1회 재시도.
 * - onUnauthorized가 null(갱신 실패)이면 재시도 없이 UNAUTHENTICATED를 던진다(호출 측이 로그아웃 처리).
 * - CORS로 위장된 401(fetch TypeError)은 NETWORK_ERROR로 표시하고, 여기서 로그아웃시키지 않는다.
 */

const BASE = "https://api.test";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeAuth(overrides: Partial<AuthBridge> = {}): AuthBridge {
  return {
    ensureFreshToken: vi.fn(async () => "token-A"),
    onUnauthorized: vi.fn(async () => null),
    ...overrides,
  };
}

describe("HttpApiClient — 세션 만료/401 처리", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("요청 직전 ensureFreshToken이 준 토큰을 Authorization 헤더로 보낸다(선제 확보)", async () => {
    const auth = makeAuth({ ensureFreshToken: vi.fn(async () => "fresh-token") });
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { items: [] } }));
    const client = new HttpApiClient(BASE, auth);

    await client.listApps();

    expect(auth.ensureFreshToken).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer fresh-token");
  });

  it("401 → onUnauthorized가 새 토큰을 주면 원 요청을 새 토큰으로 1회 재시도해 성공한다", async () => {
    const onUnauthorized = vi.fn(async () => "token-B");
    const auth = makeAuth({ ensureFreshToken: vi.fn(async () => "token-A"), onUnauthorized });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { code: "UNAUTHENTICATED", message: "만료" } }, 401))
      .mockResolvedValueOnce(jsonResponse({ data: { items: [{ appId: "a1" }] } }));
    const client = new HttpApiClient(BASE, auth);

    const apps = await client.listApps();

    expect(apps).toEqual([{ appId: "a1" }]);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 재시도 요청은 갱신된 토큰을 쓴다
    const [, retryInit] = fetchMock.mock.calls[1];
    expect((retryInit.headers as Record<string, string>)["Authorization"]).toBe("Bearer token-B");
  });

  it("401 → onUnauthorized가 null(갱신 실패)이면 재시도 없이 UNAUTHENTICATED를 던진다", async () => {
    const onUnauthorized = vi.fn(async () => null);
    const auth = makeAuth({ onUnauthorized });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: "UNAUTHENTICATED", message: "만료" } }, 401),
    );
    const client = new HttpApiClient(BASE, auth);

    await expect(client.listApps()).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 재시도 없음
  });

  it("body 있는 요청도 401 재시도 시 동일 body로 다시 보낸다", async () => {
    const auth = makeAuth({ onUnauthorized: vi.fn(async () => "token-B") });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { code: "UNAUTHENTICATED", message: "만료" } }, 401))
      .mockResolvedValueOnce(jsonResponse({ data: { connId: "c1", provider: "codecommit" } }));
    const client = new HttpApiClient(BASE, auth);

    await client.createConnection("codecommit", "회사 저장소");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, firstInit] = fetchMock.mock.calls[0];
    const [, retryInit] = fetchMock.mock.calls[1];
    expect(retryInit.body).toBe(firstInit.body);
    expect(JSON.parse(retryInit.body as string)).toMatchObject({ provider: "codecommit" });
  });

  it("네트워크 오류(fetch throw, CORS 위장 401 포함)는 NETWORK_ERROR로 표시하고 자동 로그아웃하지 않는다", async () => {
    const onUnauthorized = vi.fn(async () => null);
    const auth = makeAuth({ onUnauthorized });
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const client = new HttpApiClient(BASE, auth);

    await expect(client.listApps()).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    // 네트워크 실패는 401 경로가 아니므로 onUnauthorized(로그아웃 트리거)를 부르지 않는다
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("일반 오류(500 등)는 갱신/재시도 없이 그대로 던진다", async () => {
    const onUnauthorized = vi.fn(async () => "token-B");
    const auth = makeAuth({ onUnauthorized });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: "INTERNAL_ERROR", message: "서버 오류" } }, 500),
    );
    const client = new HttpApiClient(BASE, auth);

    await expect(client.listApps()).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
