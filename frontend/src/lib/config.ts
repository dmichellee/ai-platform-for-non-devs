/**
 * 런타임 설정 주입 — 빌드에 하드코딩하지 않는다.
 * deploy.sh가 stack-outputs(ApiUrl/UserPoolId/UserPoolClientId/CloudFrontDomain 등)를
 * public/config.json 형태로 S3에 올리고, SPA가 부팅 시 fetch 한다.
 *
 * 설정이 없거나(로컬/QA) mock=true 이면 목 모드로 동작한다 → 실제 백엔드 없이 전 화면 열람 가능.
 */

export interface RuntimeConfig {
  apiUrl: string;
  userPoolId: string;
  userPoolClientId: string;
  /**
   * 더 이상 SPA가 쓰지 않는다(D21 자체 로그인 — Hosted UI 미사용). 구 config.json 호환을 위해 타입만 남기며 무시한다.
   * @deprecated
   */
  cognitoDomain?: string;
  /**
   * 로그인 API(cognito-idp) 호출 주소. public 모드는 공용 엔드포인트, private 모드는 VPC 엔드포인트 DNS.
   * 미지정 시 `https://cognito-idp.{region}.amazonaws.com/` (resolveCognitoIdpEndpoint).
   */
  cognitoIdpEndpoint?: string;
  region?: string;
  /** @deprecated Hosted UI 콜백용이었다. D21 이후 사용하지 않는다. */
  redirectUri?: string;
  stage?: string;
  /**
   * Kiro 설정 번들(.zip) 다운로드 경로 — OS별 2개(Mac / Windows).
   * CloudFront가 SPA와 같은 오리진에서 `/kiro-config/*` behavior로 자산 버킷을 서빙하므로
   * (platform Output KiroConfigUrlPath) 기본값은 SPA-상대 경로다. API 왕복 없음(정적 다운로드).
   * deploy.sh는 이 값들을 config.json에 주입하지 않으므로(기본 경로 폴백이 정상 동작),
   * override가 없어도 완벽히 동작한다. 사설 CDN 등으로 재정의하고 싶을 때만 넣는다.
   */
  kiroConfigUrlMac?: string;
  kiroConfigUrlWindows?: string;
  /**
   * 앱 접속 도메인(예: apps-dev.example.com). 화면에서 `{subdomain}.{appsDomain}`
   * 실제 접속 주소를 보여주는 데 쓴다. deploy.sh가 config.json에 넣는다.
   */
  appsDomain?: string;
  /** true면 API를 목으로 처리하고 로그인도 우회한다. QA/데모용. */
  mock: boolean;
}

/**
 * 로그인 API 주소 결정 — config.cognitoIdpEndpoint 우선, 없으면 region(없으면 userPoolId 접두어
 * `ap-northeast-2_xxx`)으로 공용 엔드포인트를 만든다. 둘 다 없으면 null(로그인 불가 — 설정 오류).
 */
export function resolveCognitoIdpEndpoint(cfg: RuntimeConfig): string | null {
  if (cfg.cognitoIdpEndpoint) return cfg.cognitoIdpEndpoint;
  const region = cfg.region || (cfg.userPoolId.includes("_") ? cfg.userPoolId.split("_")[0] : "");
  if (!region) return null;
  return `https://cognito-idp.${region}.amazonaws.com/`;
}

/**
 * 앱 접속 도메인 라벨 — config.json의 appsDomain(예: apps-dev.example.com).
 * 값이 없으면 자리표시("apps.회사도메인")로 폴백(목/로컬).
 */
export function appsDomainLabel(): string {
  return getCachedConfig()?.appsDomain ?? "apps.회사도메인";
}

/**
 * Kiro 설정 다운로드 기본 경로(SPA-상대) — OS별 2개.
 * config.json에 override(kiroConfigUrlMac / kiroConfigUrlWindows)가 없을 때 폴백.
 * CloudFront `/kiro-config/*` 와일드카드가 두 경로를 모두 서빙한다.
 */
export const DEFAULT_KIRO_CONFIG_URL_MAC = "/kiro-config/kiro-config-mac.zip";
export const DEFAULT_KIRO_CONFIG_URL_WINDOWS = "/kiro-config/kiro-config-windows.zip";

const DEFAULT_MOCK_CONFIG: RuntimeConfig = {
  apiUrl: "",
  userPoolId: "",
  userPoolClientId: "",
  stage: "local",
  mock: true,
};

let cached: RuntimeConfig | null = null;

/** config.json 을 읽는다. 실패하면 목 모드 설정을 돌려준다. */
export async function loadConfig(): Promise<RuntimeConfig> {
  if (cached) return cached;

  // 빌드 타임 env 로 강제 목 모드(로컬 dev). VITE_MOCK=1 이면 config.json 을 건너뛴다.
  const forceMock =
    typeof import.meta !== "undefined" &&
    (import.meta as { env?: Record<string, string> }).env?.VITE_MOCK === "1";

  if (forceMock) {
    cached = { ...DEFAULT_MOCK_CONFIG };
    return cached;
  }

  try {
    const res = await fetch("/config.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`config.json ${res.status}`);
    const raw = (await res.json()) as Partial<RuntimeConfig>;
    const cfg: RuntimeConfig = {
      apiUrl: raw.apiUrl ?? "",
      userPoolId: raw.userPoolId ?? "",
      userPoolClientId: raw.userPoolClientId ?? "",
      stage: raw.stage ?? "dev",
      // apiUrl/userPool 정보가 비면 실서비스로 볼 수 없으니 목 모드.
      mock: raw.mock ?? !(raw.apiUrl && raw.userPoolId && raw.userPoolClientId),
    };
    // cognitoDomain 은 읽지 않는다(D21 — 있어도 무시).
    if (raw.cognitoIdpEndpoint) cfg.cognitoIdpEndpoint = raw.cognitoIdpEndpoint;
    if (raw.region) cfg.region = raw.region;
    if (raw.kiroConfigUrlMac) cfg.kiroConfigUrlMac = raw.kiroConfigUrlMac;
    if (raw.kiroConfigUrlWindows) cfg.kiroConfigUrlWindows = raw.kiroConfigUrlWindows;
    if (raw.appsDomain) cfg.appsDomain = raw.appsDomain;
    cached = cfg;
    return cfg;
  } catch {
    // config.json 없음 → 로컬/데모. 목 모드.
    const cfg = { ...DEFAULT_MOCK_CONFIG };
    cached = cfg;
    return cfg;
  }
}

/** 이미 로드된 설정 (loadConfig 이후에만 유효). 테스트에서 주입 가능. */
export function setConfigForTest(cfg: RuntimeConfig): void {
  cached = cfg;
}

export function getCachedConfig(): RuntimeConfig | null {
  return cached;
}
