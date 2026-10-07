/**
 * 로그인 서버(cognito-idp) API 직접 호출 — D21 자체 로그인.
 * 외부 SDK 없이 fetch 1회로 끝난다. 사용하는 operation은 모두 비인증(서명 불필요)이다.
 *   POST {endpoint}
 *   Content-Type: application/x-amz-json-1.1
 *   X-Amz-Target: AWSCognitoIdentityProviderService.{Op}
 *
 * 실패는 IdpError(type=응답 `__type`의 예외 이름)로 던진다. 화면 문구는 authErrorMessage()가 만든다.
 * 이 파일의 문자열 중 사용자에게 보이는 것은 authErrorMessage()의 한국어 문구뿐이다(용어 사전: "Cognito" 금지).
 */

export type IdpOperation =
  | "InitiateAuth"
  | "RespondToAuthChallenge"
  | "ForgotPassword"
  | "ConfirmForgotPassword"
  | "RevokeToken";

/** 네트워크 자체 실패(서버에 닿지 못함)를 나타내는 type. */
export const NETWORK_ERROR = "NetworkError";

export class IdpError extends Error {
  /** Cognito 예외 이름(예: NotAuthorizedException) 또는 NETWORK_ERROR / "UnknownError". */
  readonly type: string;
  constructor(type: string, message: string) {
    super(message);
    this.name = "IdpError";
    this.type = type;
  }
}

export interface AuthenticationResult {
  IdToken?: string;
  AccessToken?: string;
  RefreshToken?: string;
  ExpiresIn?: number;
  TokenType?: string;
}

export interface InitiateAuthResponse {
  AuthenticationResult?: AuthenticationResult;
  ChallengeName?: string;
  Session?: string;
  ChallengeParameters?: Record<string, string>;
}

/** `__type`은 "NotAuthorizedException" 또는 "com.amazon...#NotAuthorizedException" 형태. */
function normalizeType(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "UnknownError";
  const hash = raw.lastIndexOf("#");
  const tail = hash >= 0 ? raw.slice(hash + 1) : raw;
  return tail.split(":")[0]!.trim() || "UnknownError";
}

export async function callIdp<T>(
  endpoint: string,
  op: IdpOperation,
  body: Record<string, unknown>,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": `AWSCognitoIdentityProviderService.${op}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new IdpError(NETWORK_ERROR, "network error");
  }
  let json: Record<string, unknown> = {};
  try {
    const text = await res.text();
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  if (!res.ok) {
    const type = normalizeType(json.__type ?? res.headers.get("x-amzn-errortype"));
    const message =
      (typeof json.message === "string" && json.message) ||
      (typeof json.Message === "string" && json.Message) ||
      "";
    throw new IdpError(type, message);
  }
  return json as T;
}

// ── operation 래퍼 ──

export function initiatePasswordAuth(
  endpoint: string,
  clientId: string,
  username: string,
  password: string,
): Promise<InitiateAuthResponse> {
  return callIdp<InitiateAuthResponse>(endpoint, "InitiateAuth", {
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: clientId,
    AuthParameters: { USERNAME: username, PASSWORD: password },
  });
}

export function initiateRefreshAuth(
  endpoint: string,
  clientId: string,
  refreshToken: string,
): Promise<InitiateAuthResponse> {
  return callIdp<InitiateAuthResponse>(endpoint, "InitiateAuth", {
    AuthFlow: "REFRESH_TOKEN_AUTH",
    ClientId: clientId,
    AuthParameters: { REFRESH_TOKEN: refreshToken },
  });
}

export function respondNewPassword(
  endpoint: string,
  clientId: string,
  session: string,
  username: string,
  newPassword: string,
): Promise<InitiateAuthResponse> {
  return callIdp<InitiateAuthResponse>(endpoint, "RespondToAuthChallenge", {
    ChallengeName: "NEW_PASSWORD_REQUIRED",
    ClientId: clientId,
    Session: session,
    ChallengeResponses: { USERNAME: username, NEW_PASSWORD: newPassword },
  });
}

export function forgotPassword(
  endpoint: string,
  clientId: string,
  username: string,
): Promise<{ CodeDeliveryDetails?: { Destination?: string; DeliveryMedium?: string } }> {
  return callIdp(endpoint, "ForgotPassword", { ClientId: clientId, Username: username });
}

export function confirmForgotPassword(
  endpoint: string,
  clientId: string,
  username: string,
  code: string,
  newPassword: string,
): Promise<Record<string, never>> {
  return callIdp(endpoint, "ConfirmForgotPassword", {
    ClientId: clientId,
    Username: username,
    ConfirmationCode: code,
    Password: newPassword,
  });
}

export function revokeToken(
  endpoint: string,
  clientId: string,
  refreshToken: string,
): Promise<Record<string, never>> {
  return callIdp(endpoint, "RevokeToken", { Token: refreshToken, ClientId: clientId });
}

// ── 화면 문구 매핑 ──

/** 어떤 화면에서 난 오류인지 — 같은 예외라도 화면에 따라 안내가 달라진다. */
export type AuthStep = "signIn" | "newPassword" | "forgot" | "confirmForgot";

export const PASSWORD_RULE_HINT =
  "12자 이상, 영문 대문자·소문자·숫자·특수문자를 모두 넣어주세요.";

/**
 * 로그인 서버 오류 → 비개발자용 한국어 안내.
 * 원문 message는 화면에 그대로 내보내지 않는다(영문·내부 용어 노출 방지). 분기 판단에만 쓴다.
 */
export function authErrorMessage(err: unknown, step: AuthStep): string {
  const type = err instanceof IdpError ? err.type : "UnknownError";
  const raw = err instanceof IdpError ? err.message.toLowerCase() : "";

  switch (type) {
    case NETWORK_ERROR:
      return "로그인 서버에 연결하지 못했어요. 인터넷(또는 사내망) 연결을 확인한 뒤 다시 시도해주세요.";
    case "NotAuthorizedException":
      if (raw.includes("attempts exceeded"))
        return "비밀번호를 여러 번 틀려 잠시 로그인이 막혔어요. 몇 분 뒤 다시 시도해주세요.";
      if (raw.includes("disabled"))
        return "사용이 중지된 계정이에요. 관리자에게 문의해주세요.";
      if (raw.includes("temporary password has expired"))
        return "임시 비밀번호의 사용 기간이 지났어요. 관리자에게 새 임시 비밀번호를 요청해주세요.";
      if (raw.includes("session") && (step === "newPassword" || raw.includes("expired")))
        return "입력 시간이 지났어요. 처음부터 다시 로그인해주세요.";
      if (step === "forgot" || step === "confirmForgot")
        return "이 계정은 지금 비밀번호를 다시 설정할 수 없어요. 관리자에게 문의해주세요.";
      return "이메일 또는 비밀번호가 맞지 않아요. 다시 확인해주세요.";
    case "UserNotFoundException":
      if (step === "forgot" || step === "confirmForgot")
        return "이 이메일로 등록된 계정을 찾지 못했어요. 이메일 주소를 확인하거나 관리자에게 문의해주세요.";
      return "이메일 또는 비밀번호가 맞지 않아요. 다시 확인해주세요.";
    case "PasswordResetRequiredException":
      return "비밀번호를 새로 정해야 하는 계정이에요. 아래 '비밀번호를 잊으셨나요?'를 눌러 인증 코드를 받아주세요.";
    case "UserNotConfirmedException":
      return "아직 사용할 준비가 끝나지 않은 계정이에요. 관리자에게 문의해주세요.";
    case "InvalidPasswordException":
      return `새 비밀번호가 규칙에 맞지 않아요. ${PASSWORD_RULE_HINT}`;
    case "PasswordHistoryPolicyViolationException":
      return "최근에 쓴 비밀번호는 다시 쓸 수 없어요. 다른 비밀번호를 정해주세요.";
    case "CodeMismatchException":
      return "인증 코드가 맞지 않아요. 이메일로 받은 코드를 다시 확인해주세요.";
    case "ExpiredCodeException":
      return "인증 코드의 유효 시간이 지났어요. '코드 다시 받기'를 눌러 새 코드를 받아주세요.";
    case "CodeDeliveryFailureException":
      return "인증 코드를 보내지 못했어요. 잠시 후 다시 시도해주세요.";
    case "LimitExceededException":
    case "TooManyRequestsException":
    case "TooManyFailedAttemptsException":
      return "요청이 너무 많았어요. 잠시 후 다시 시도해주세요.";
    case "InvalidParameterException":
      if (raw.includes("no registered") || raw.includes("verified"))
        return "이 계정은 비밀번호 찾기를 쓸 수 없어요. 관리자에게 비밀번호 재설정을 요청해주세요.";
      if (step === "newPassword" || step === "confirmForgot")
        return `새 비밀번호를 다시 확인해주세요. ${PASSWORD_RULE_HINT}`;
      return "입력한 내용을 다시 확인해주세요.";
    case "ResourceNotFoundException":
    case "InvalidUserPoolConfigurationException":
    case "UnsupportedOperationException":
      return "로그인 설정에 문제가 있어요. 관리자에게 문의해주세요.";
    default:
      return "로그인 중 문제가 생겼어요. 잠시 후 다시 시도하고, 계속되면 관리자에게 문의해주세요.";
  }
}
