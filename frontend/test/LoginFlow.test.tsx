import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { AuthProvider, useAuth } from "../src/auth/AuthContext.js";
import { Login } from "../src/screens/Login.js";
import { base64UrlEncode } from "../src/auth/tokens.js";
import { authErrorMessage, IdpError, NETWORK_ERROR } from "../src/auth/cognitoIdp.js";
import { setConfigForTest, type RuntimeConfig } from "../src/lib/config.js";

/**
 * D21 자체 로그인 — 로그인 서버(cognito-idp) API를 fetch로 직접 호출하는 흐름.
 * fetch를 X-Amz-Target 별로 라우팅하는 mock으로 성공/첫 로그인/오류 매핑/비밀번호 찾기/로그아웃을 검증한다.
 */

const ENDPOINT = "https://idp.test.example.com/";
const REAL_CONFIG: RuntimeConfig = {
  apiUrl: "https://api.test",
  userPoolId: "ap-northeast-2_pool",
  userPoolClientId: "client-1",
  region: "ap-northeast-2",
  cognitoIdpEndpoint: ENDPOINT,
  stage: "test",
  mock: false,
};

function idToken(email = "daeun@example.com"): string {
  return `${base64UrlEncode({ alg: "none" })}.${base64UrlEncode({
    sub: "user-0001",
    email,
    name: "이다은",
    "cognito:groups": ["user"],
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.`;
}

type Handler = (body: Record<string, unknown>) => Response | Promise<Response>;

function ok(json: unknown): Response {
  return new Response(JSON.stringify(json), {
    status: 200,
    headers: { "Content-Type": "application/x-amz-json-1.1" },
  });
}
function fail(type: string, message = ""): Response {
  return new Response(JSON.stringify({ __type: type, message }), { status: 400 });
}
const TOKENS = (): Response =>
  ok({ AuthenticationResult: { IdToken: idToken(), RefreshToken: "refresh-1", AccessToken: "acc" } });

let fetchMock: ReturnType<typeof vi.fn>;
let handlers: Record<string, Handler>;

/** X-Amz-Target의 operation 이름으로 라우팅. 호출 기록은 calls()로 본다. */
function installFetch(): void {
  fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const target = (init.headers as Record<string, string>)["X-Amz-Target"] ?? "";
    const op = target.replace("AWSCognitoIdentityProviderService.", "");
    const h = handlers[op];
    if (!h) return fail("UnknownOperationException");
    return h(JSON.parse(String(init.body)));
  });
  vi.stubGlobal("fetch", fetchMock);
}
function calls(op: string): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit & { headers: Record<string, string> }).headers["X-Amz-Target"] === `AWSCognitoIdentityProviderService.${op}`)
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

let logoutFn: () => void = () => undefined;

/** 앱 셸 축소판 — 세션 없으면 로그인 화면, 있으면 로그인 완료 표시. */
function Shell(): JSX.Element {
  const { session, ready, logout } = useAuth();
  logoutFn = logout;
  if (!ready) return <div>loading</div>;
  if (!session) return <Login />;
  return <div>로그인 완료: {session.email}</div>;
}

function renderLogin(config: RuntimeConfig = REAL_CONFIG): void {
  setConfigForTest(config);
  render(
    <AuthProvider config={config}>
      <Shell />
    </AuthProvider>,
  );
}

async function fillSignIn(email: string, password: string): Promise<void> {
  fireEvent.change(await screen.findByLabelText("회사 이메일"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "로그인" }));
}

describe("D21 자체 로그인 — 화면 흐름", () => {
  beforeEach(() => {
    localStorage.clear();
    window.location.hash = "";
    handlers = {};
    installFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("이메일/비밀번호로 로그인하면 USER_PASSWORD_AUTH로 요청하고 세션(refresh_token 포함)을 저장한다", async () => {
    handlers.InitiateAuth = () => TOKENS();
    renderLogin();
    await fillSignIn("  daeun@example.com ", "Secret-Passw0rd!");

    await screen.findByText("로그인 완료: daeun@example.com");
    const [body] = calls("InitiateAuth");
    expect(body).toEqual({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: "client-1",
      AuthParameters: { USERNAME: "daeun@example.com", PASSWORD: "Secret-Passw0rd!" },
    });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(ENDPOINT);
    const saved = JSON.parse(localStorage.getItem("apphub-session")!);
    expect(saved.refreshToken).toBe("refresh-1");
    expect(saved.groups).toEqual(["user"]);
  });

  it("입력 전에는 로그인 버튼이 비활성이고, 비밀번호 보기 토글이 있다", async () => {
    renderLogin();
    expect(await screen.findByRole("button", { name: "로그인" })).toBeDisabled();
    const pw = screen.getByLabelText("비밀번호");
    expect(pw).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "비밀번호 보기" }));
    expect(pw).toHaveAttribute("type", "text");
  });

  it("첫 로그인(NEW_PASSWORD_REQUIRED)이면 새 비밀번호 화면을 보여주고, 확인이 다르면 막고, 같으면 RespondToAuthChallenge로 로그인한다", async () => {
    handlers.InitiateAuth = () =>
      ok({
        ChallengeName: "NEW_PASSWORD_REQUIRED",
        Session: "sess-1",
        ChallengeParameters: { USER_ID_FOR_SRP: "uuid-0001", requiredAttributes: "[]" },
      });
    handlers.RespondToAuthChallenge = () => TOKENS();
    renderLogin();
    await fillSignIn("daeun@example.com", "Temp-Passw0rd!");

    await screen.findByText("새 비밀번호를 정해주세요");
    expect(screen.getByText(/12자 이상/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("새 비밀번호"), { target: { value: "New-Passw0rd!!" } });
    fireEvent.change(screen.getByLabelText("새 비밀번호 확인"), { target: { value: "Different-1!!" } });
    fireEvent.click(screen.getByRole("button", { name: /비밀번호 정하고 시작하기/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("두 비밀번호가 서로 달라요");
    expect(calls("RespondToAuthChallenge")).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("새 비밀번호 확인"), { target: { value: "New-Passw0rd!!" } });
    fireEvent.click(screen.getByRole("button", { name: /비밀번호 정하고 시작하기/ }));
    await screen.findByText("로그인 완료: daeun@example.com");
    expect(calls("RespondToAuthChallenge")[0]).toEqual({
      ChallengeName: "NEW_PASSWORD_REQUIRED",
      ClientId: "client-1",
      Session: "sess-1",
      ChallengeResponses: { USERNAME: "uuid-0001", NEW_PASSWORD: "New-Passw0rd!!" },
    });
  });

  it("새 비밀번호가 규칙에 안 맞으면(InvalidPasswordException) 규칙을 안내한다", async () => {
    handlers.InitiateAuth = () => ok({ ChallengeName: "NEW_PASSWORD_REQUIRED", Session: "s", ChallengeParameters: {} });
    handlers.RespondToAuthChallenge = () => fail("InvalidPasswordException", "Password does not conform to policy");
    renderLogin();
    await fillSignIn("daeun@example.com", "Temp-Passw0rd!");
    await screen.findByText("새 비밀번호를 정해주세요");
    fireEvent.change(screen.getByLabelText("새 비밀번호"), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText("새 비밀번호 확인"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: /비밀번호 정하고 시작하기/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("새 비밀번호가 규칙에 맞지 않아요");
    // 첫 로그인 화면에 머문다 — 처음으로 돌아갈 길이 있다
    expect(screen.getByRole("button", { name: /처음으로 돌아가기/ })).toBeInTheDocument();
  });

  it.each([
    ["NotAuthorizedException", "Incorrect username or password.", "이메일 또는 비밀번호가 맞지 않아요"],
    ["UserNotFoundException", "User does not exist.", "이메일 또는 비밀번호가 맞지 않아요"],
    ["NotAuthorizedException", "Password attempts exceeded", "여러 번 틀려"],
    ["NotAuthorizedException", "User is disabled.", "사용이 중지된 계정"],
    ["NotAuthorizedException", "Temporary password has expired and must be reset by an administrator.", "임시 비밀번호의 사용 기간이 지났어요"],
    ["PasswordResetRequiredException", "Password reset required for the user", "비밀번호를 새로 정해야 하는 계정"],
    ["LimitExceededException", "Attempt limit exceeded", "요청이 너무 많았어요"],
    ["SomethingWeirdException", "", "로그인 중 문제가 생겼어요"],
  ])("로그인 오류 %s(%s) → 한국어 안내", async (type, message, expected) => {
    handlers.InitiateAuth = () => fail(type, message);
    renderLogin();
    await fillSignIn("daeun@example.com", "wrong");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(expected);
    // 원문 영문 메시지·내부 예외 이름은 화면에 노출하지 않는다
    expect(alert.textContent).not.toContain(type);
    if (message) expect(alert.textContent).not.toContain(message);
    expect(localStorage.getItem("apphub-session")).toBeNull();
  });

  it("네트워크 실패면 연결 확인 안내를 보여준다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    renderLogin();
    await fillSignIn("daeun@example.com", "pw");
    expect(await screen.findByRole("alert")).toHaveTextContent("로그인 서버에 연결하지 못했어요");
  });

  it("비밀번호 찾기: 코드 발송(ForgotPassword) → 코드+새 비밀번호(ConfirmForgotPassword) → 로그인 화면으로 돌아와 완료 안내", async () => {
    handlers.ForgotPassword = () =>
      ok({ CodeDeliveryDetails: { Destination: "d***@e***", DeliveryMedium: "EMAIL", AttributeName: "email" } });
    let confirmAttempts = 0;
    handlers.ConfirmForgotPassword = () => {
      confirmAttempts += 1;
      return confirmAttempts === 1 ? fail("CodeMismatchException", "Invalid verification code") : ok({});
    };
    renderLogin();
    fireEvent.click(await screen.findByRole("button", { name: "비밀번호를 잊으셨나요?" }));
    await screen.findByText("비밀번호 찾기");
    fireEvent.change(screen.getByLabelText("회사 이메일"), { target: { value: "daeun@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /인증 코드 받기/ }));

    await screen.findByText("새 비밀번호 설정");
    expect(screen.getByText("d***@e***")).toBeInTheDocument();
    expect(calls("ForgotPassword")[0]).toEqual({ ClientId: "client-1", Username: "daeun@example.com" });

    const fill = (codeVal: string): void => {
      fireEvent.change(screen.getByLabelText("인증 코드"), { target: { value: codeVal } });
      fireEvent.change(screen.getByLabelText("새 비밀번호"), { target: { value: "New-Passw0rd!!" } });
      fireEvent.change(screen.getByLabelText("새 비밀번호 확인"), { target: { value: "New-Passw0rd!!" } });
      fireEvent.click(screen.getByRole("button", { name: /비밀번호 바꾸기/ }));
    };
    fill("000000");
    expect(await screen.findByRole("alert")).toHaveTextContent("인증 코드가 맞지 않아요");

    fill(" 123456 ");
    await screen.findByText("비밀번호를 바꿨어요. 새 비밀번호로 로그인해주세요.");
    expect(calls("ConfirmForgotPassword")[1]).toEqual({
      ClientId: "client-1",
      Username: "daeun@example.com",
      ConfirmationCode: "123456",
      Password: "New-Passw0rd!!",
    });
    // 로그인 화면으로 돌아왔고 이메일은 남아 있다
    expect(screen.getByRole("button", { name: "로그인" })).toBeInTheDocument();
    expect(screen.getByLabelText("회사 이메일")).toHaveValue("daeun@example.com");
  });

  it("비밀번호 찾기: 코드 다시 받기는 ForgotPassword를 다시 호출한다", async () => {
    handlers.ForgotPassword = () => ok({ CodeDeliveryDetails: { Destination: "d***@e***" } });
    renderLogin();
    fireEvent.click(await screen.findByRole("button", { name: "비밀번호를 잊으셨나요?" }));
    fireEvent.change(screen.getByLabelText("회사 이메일"), { target: { value: "daeun@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /인증 코드 받기/ }));
    await screen.findByText("새 비밀번호 설정");
    fireEvent.click(screen.getByRole("button", { name: "코드 다시 받기" }));
    await screen.findByText(/인증 코드를 다시 보냈어요/);
    expect(calls("ForgotPassword")).toHaveLength(2);
  });

  it("로그아웃하면 RevokeToken으로 refresh_token을 폐기하고 로그인 화면으로 돌아간다", async () => {
    handlers.InitiateAuth = () => TOKENS();
    handlers.RevokeToken = () => ok({});
    renderLogin();
    await fillSignIn("daeun@example.com", "Secret-Passw0rd!");
    await screen.findByText("로그인 완료: daeun@example.com");

    act(() => logoutFn());
    expect(await screen.findByRole("button", { name: "로그인" })).toBeInTheDocument();
    expect(localStorage.getItem("apphub-session")).toBeNull();
    expect(window.location.hash).toBe("#/login");
    await waitFor(() =>
      expect(calls("RevokeToken")).toEqual([{ Token: "refresh-1", ClientId: "client-1" }]),
    );
  });

  it("RevokeToken이 실패해도 로그아웃은 완료된다(오류 미노출)", async () => {
    handlers.InitiateAuth = () => TOKENS();
    handlers.RevokeToken = () => fail("InternalErrorException");
    renderLogin();
    await fillSignIn("daeun@example.com", "Secret-Passw0rd!");
    await screen.findByText("로그인 완료: daeun@example.com");
    act(() => logoutFn());
    await screen.findByRole("button", { name: "로그인" });
    await waitFor(() => expect(calls("RevokeToken")).toHaveLength(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("목 모드에서는 입력 폼 없이 둘러보기 우회 버튼을 보여주고 로그인 서버를 부르지 않는다", async () => {
    renderLogin({ ...REAL_CONFIG, mock: true });
    fireEvent.click(await screen.findByRole("button", { name: /관리자로 둘러보기/ }));
    await screen.findByText("로그인 완료: admin@example.com");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("authErrorMessage — 단계별 매핑", () => {
  const err = (type: string, msg = ""): IdpError => new IdpError(type, msg);

  it("비밀번호 찾기 단계의 UserNotFound는 계정 확인 안내", () => {
    expect(authErrorMessage(err("UserNotFoundException"), "forgot")).toContain("등록된 계정을 찾지 못했어요");
  });
  it("만료된 인증 코드는 다시 받기 안내", () => {
    expect(authErrorMessage(err("ExpiredCodeException"), "confirmForgot")).toContain("코드 다시 받기");
  });
  it("첫 로그인 세션 만료는 처음부터 다시 안내", () => {
    expect(
      authErrorMessage(err("NotAuthorizedException", "Invalid session for the user, session is expired."), "newPassword"),
    ).toContain("처음부터 다시 로그인");
  });
  it("검증된 이메일 없는 계정의 비밀번호 찾기", () => {
    expect(
      authErrorMessage(
        err("InvalidParameterException", "Cannot reset password for the user as there is no registered/verified email or phone_number"),
        "forgot",
      ),
    ).toContain("관리자에게 비밀번호 재설정");
  });
  it("네트워크/설정 오류", () => {
    expect(authErrorMessage(err(NETWORK_ERROR), "signIn")).toContain("연결하지 못했어요");
    expect(authErrorMessage(err("ResourceNotFoundException"), "signIn")).toContain("로그인 설정에 문제");
  });
  it("어떤 안내에도 'Cognito'가 들어가지 않는다", () => {
    const types = [
      "NotAuthorizedException", "UserNotFoundException", "PasswordResetRequiredException",
      "InvalidPasswordException", "CodeMismatchException", "ExpiredCodeException",
      "LimitExceededException", "InvalidParameterException", "ResourceNotFoundException", NETWORK_ERROR, "X",
    ];
    for (const t of types)
      for (const s of ["signIn", "newPassword", "forgot", "confirmForgot"] as const)
        expect(authErrorMessage(err(t), s)).not.toMatch(/cognito/i);
  });
});
