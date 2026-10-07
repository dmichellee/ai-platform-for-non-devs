/**
 * API 클라이언트 인터페이스 + HTTP 구현.
 * 응답 봉투({data} / {data:{items,nextToken}} / {error})를 여기서 언랩한다.
 * 계약(api-contract.md)에 정의된 엔드포인트만 노출한다.
 */
import type {
  AdminSettings,
  AdminStopResult,
  AlbRegistry,
  App,
  AppMetrics,
  CodeCommitRepo,
  ComputePreset,
  CreateAppRequest,
  Deployment,
  ListEnvelope,
  LogEvent,
  LogsEnvelope,
  MetricRange,
  PatchAppRequest,
  PatchAppResponse,
  PermissionTemplate,
  PlatformUser,
  Provider,
  RepoConnection,
  RestartResult,
  SingleEnvelope,
  SubdomainCheck,
  UserPermissionTemplate,
} from "./types.js";

/** 계약 에러 봉투를 던지는 오류. code로 분기, message는 그대로 노출 가능. */
export class ApiError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface ApiClient {
  // 앱
  listApps(): Promise<App[]>;
  getApp(appId: string): Promise<App>;
  createApp(body: CreateAppRequest): Promise<App>;
  patchApp(appId: string, body: PatchAppRequest): Promise<PatchAppResponse>;
  deleteApp(appId: string): Promise<{ appId: string; status: "DELETING" }>;
  // 배포
  deploy(appId: string): Promise<Deployment>;
  listDeployments(appId: string, limit?: number): Promise<Deployment[]>;
  rollback(appId: string, deploymentId: string): Promise<Deployment>;
  // 재시작 — 지금 버전 그대로 앱만 다시 켠다(빌드/배포 없음). ACTIVE 일 때만.
  restartApp(appId: string): Promise<RestartResult>;
  // 로그
  getLogs(appId: string, opts?: { limit?: number; nextToken?: string; startTime?: number }): Promise<{ events: LogEvent[]; nextToken?: string }>;
  // 모니터링 지표 (api-requests.md #6, backend 병렬 구현)
  getMetrics(appId: string, range: MetricRange): Promise<AppMetrics>;
  // 연결
  listConnections(): Promise<RepoConnection[]>;
  createConnection(provider: Provider, displayName: string): Promise<RepoConnection>;
  deleteConnection(connId: string): Promise<void>;
  // 연결 하위 — CodeCommit(AWS 저장소) 레포 (계약: /connections/{connId}/repos)
  listRepos(connId: string): Promise<CodeCommitRepo[]>;
  createRepo(connId: string, repoName: string): Promise<CodeCommitRepo>;
  // 계약(backend 병렬 구현): DELETE /connections/{connId}/repos/{repoName} → 204.
  // 409 REPO_IN_USE(사용 중인 앱 있음), 404 NOT_FOUND. repoName 은 접두어 포함 최종명.
  deleteRepo(connId: string, repoName: string): Promise<void>;
  // 앱 생성 마법사용 (user 권한) — api-requests.md #1~3, #5
  checkSubdomain(value: string): Promise<SubdomainCheck>;
  listPresets(): Promise<ComputePreset[]>;
  listPermTemplates(): Promise<UserPermissionTemplate[]>;
  // GET /providers — 관리자가 활성화한 저장소 provider 목록(연결 추가 화면용).
  listProviders(): Promise<Provider[]>;
  // 관리자
  adminGetSettings(): Promise<AdminSettings>;
  adminPutSettings(body: Omit<AdminSettings, "updatedAt">): Promise<AdminSettings>;
  adminListPresets(): Promise<ComputePreset[]>;
  adminCreatePreset(body: Partial<ComputePreset>): Promise<ComputePreset>;
  adminUpdatePreset(presetId: string, body: Partial<ComputePreset>): Promise<ComputePreset>;
  adminDeletePreset(presetId: string): Promise<void>;
  adminListPermTemplates(): Promise<PermissionTemplate[]>;
  adminCreatePermTemplate(body: { displayName: string; policyDocument: object }): Promise<PermissionTemplate>;
  adminUpdatePermTemplate(permId: string, body: { displayName?: string; policyDocument?: object }): Promise<PermissionTemplate>;
  adminDeletePermTemplate(permId: string): Promise<void>;
  adminListUsers(): Promise<PlatformUser[]>;
  adminInviteUser(email: string, group?: "admin" | "user"): Promise<{ username: string; email: string; group: string }>;
  adminPatchUser(username: string, body: { group?: string; enabled?: boolean }): Promise<{ username: string }>;
  adminListAllApps(status?: string): Promise<App[]>;
  adminAlbRegistry(): Promise<AlbRegistry[]>;
  // 강제 중지(재우기) — 관리자가 임의 사용자 앱을 즉시 잠재운다(api-requests.md #7).
  adminStopApp(appId: string): Promise<AdminStopResult>;
  // 관리자에 의한 타인 앱 삭제 — 소유자 검사 없이 삭제(api-requests.md #7).
  adminDeleteApp(appId: string): Promise<{ appId: string; status: "DELETING" }>;
}

/**
 * 인증 브릿지 — API 클라이언트가 세션 만료를 스스로 다루도록 AuthContext가 주입한다.
 * - ensureFreshToken: 요청 직전 유효 토큰 확보(만료 임박이면 조용히 갱신). 없으면 null.
 * - onUnauthorized: 401 수신 시 호출. 갱신 성공하면 새 토큰(재시도용), 실패면 세션 종료 후 null.
 */
export interface AuthBridge {
  ensureFreshToken: () => Promise<string | null>;
  onUnauthorized: () => Promise<string | null>;
}

export class HttpApiClient implements ApiClient {
  private readonly baseUrl: string;
  private readonly auth: AuthBridge;

  constructor(baseUrl: string, auth: AuthBridge) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.auth = auth;
  }

  /** 실제 HTTP 왕복 1회. CORS로 위장된 401은 fetch TypeError로 오므로 그것과 구분해 표시한다. */
  private async fetchOnce<T>(
    method: string,
    path: string,
    token: string | null,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, init);
    } catch {
      // 네트워크 오류. API GW authorizer의 401은 CORS 헤더가 없어 브라우저에서 여기로 온다.
      // 진짜 장애와 구분이 어려우므로 여기서 곧바로 로그아웃시키지 않는다(과도 로그아웃 방지).
      // 대신 NETWORK_ERROR로 표시하고, 만료는 선제 확보(ensureFreshToken)가 대부분 걸러낸다.
      throw new ApiError("NETWORK_ERROR", "연결이 원활하지 않아요. 잠시 후 다시 시도해주세요.", 0);
    }

    if (res.status === 204) return undefined as T;

    let json: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new ApiError("INTERNAL_ERROR", "응답을 해석하지 못했어요.", res.status);
      }
    }

    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } })?.error;
      throw new ApiError(
        err?.code ?? (res.status === 401 ? "UNAUTHENTICATED" : "INTERNAL_ERROR"),
        err?.message ?? "요청을 처리하지 못했어요.",
        res.status,
      );
    }
    return json as T;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    // 1) 선제 만료 확보 — 만료(임박)면 조용히 갱신, 불가면 null(그대로 진행 → 401 처리로 위임).
    const token = await this.auth.ensureFreshToken();
    try {
      return await this.fetchOnce<T>(method, path, token, body);
    } catch (e) {
      // 2) 401(UNAUTHENTICATED)만 갱신+재시도 1회. 그 외 에러는 그대로 던진다.
      if (e instanceof ApiError && e.code === "UNAUTHENTICATED") {
        const fresh = await this.auth.onUnauthorized();
        if (fresh) return this.fetchOnce<T>(method, path, fresh, body);
      }
      throw e;
    }
  }

  private async single<T>(method: string, path: string, body?: unknown): Promise<T> {
    const env = await this.request<SingleEnvelope<T>>(method, path, body);
    return env.data;
  }

  private async list<T>(method: string, path: string, body?: unknown): Promise<T[]> {
    const env = await this.request<ListEnvelope<T>>(method, path, body);
    return env.data.items;
  }

  // 앱
  listApps(): Promise<App[]> {
    return this.list<App>("GET", "/apps");
  }
  getApp(appId: string): Promise<App> {
    return this.single<App>("GET", `/apps/${appId}`);
  }
  createApp(b: CreateAppRequest): Promise<App> {
    return this.single<App>("POST", "/apps", b);
  }
  patchApp(appId: string, b: PatchAppRequest): Promise<PatchAppResponse> {
    return this.single<PatchAppResponse>("PATCH", `/apps/${appId}`, b);
  }
  deleteApp(appId: string): Promise<{ appId: string; status: "DELETING" }> {
    return this.single("DELETE", `/apps/${appId}`);
  }

  // 배포
  deploy(appId: string): Promise<Deployment> {
    return this.single<Deployment>("POST", `/apps/${appId}/deploy`);
  }
  listDeployments(appId: string, limit = 20): Promise<Deployment[]> {
    return this.list<Deployment>("GET", `/apps/${appId}/deployments?limit=${limit}`);
  }
  rollback(appId: string, deploymentId: string): Promise<Deployment> {
    return this.single<Deployment>("POST", `/apps/${appId}/rollback`, { deploymentId });
  }
  restartApp(appId: string): Promise<RestartResult> {
    return this.single<RestartResult>("POST", `/apps/${appId}/restart`);
  }

  // 로그
  async getLogs(
    appId: string,
    opts?: { limit?: number; nextToken?: string; startTime?: number },
  ): Promise<{ events: LogEvent[]; nextToken?: string }> {
    const q = new URLSearchParams();
    q.set("limit", String(opts?.limit ?? 100));
    if (opts?.nextToken) q.set("nextToken", opts.nextToken);
    if (opts?.startTime) q.set("startTime", String(opts.startTime));
    const env = await this.request<LogsEnvelope>("GET", `/apps/${appId}/logs?${q.toString()}`);
    return env.data;
  }

  // 모니터링 지표 — 계약 언랩: {data: AppMetrics}
  getMetrics(appId: string, range: MetricRange): Promise<AppMetrics> {
    return this.single<AppMetrics>("GET", `/apps/${appId}/metrics?range=${range}`);
  }

  // 연결
  listConnections(): Promise<RepoConnection[]> {
    return this.list<RepoConnection>("GET", "/connections");
  }
  createConnection(provider: Provider, displayName: string): Promise<RepoConnection> {
    return this.single<RepoConnection>("POST", "/connections", { provider, displayName });
  }
  async deleteConnection(connId: string): Promise<void> {
    await this.request<void>("DELETE", `/connections/${connId}`);
  }
  listRepos(connId: string): Promise<CodeCommitRepo[]> {
    return this.list<CodeCommitRepo>("GET", `/connections/${connId}/repos`);
  }
  createRepo(connId: string, repoName: string): Promise<CodeCommitRepo> {
    return this.single<CodeCommitRepo>("POST", `/connections/${connId}/repos`, { repoName });
  }
  async deleteRepo(connId: string, repoName: string): Promise<void> {
    // repoName 은 접두어 포함 최종명 — 경로에 안전하게 인코딩해 보낸다.
    await this.request<void>(
      "DELETE",
      `/connections/${connId}/repos/${encodeURIComponent(repoName)}`,
    );
  }

  // 앱 생성 마법사용 (user 권한) — api-requests.md #1~3
  checkSubdomain(value: string): Promise<SubdomainCheck> {
    return this.single<SubdomainCheck>(
      "GET",
      `/subdomains/check?value=${encodeURIComponent(value)}`,
    );
  }
  listPresets(): Promise<ComputePreset[]> {
    return this.list<ComputePreset>("GET", "/presets");
  }
  listPermTemplates(): Promise<UserPermissionTemplate[]> {
    return this.list<UserPermissionTemplate>("GET", "/permission-templates");
  }
  listProviders(): Promise<Provider[]> {
    return this.list<Provider>("GET", "/providers");
  }

  // 관리자
  adminGetSettings(): Promise<AdminSettings> {
    return this.single<AdminSettings>("GET", "/admin/settings");
  }
  adminPutSettings(b: Omit<AdminSettings, "updatedAt">): Promise<AdminSettings> {
    return this.single<AdminSettings>("PUT", "/admin/settings", b);
  }
  adminListPresets(): Promise<ComputePreset[]> {
    return this.list<ComputePreset>("GET", "/admin/presets");
  }
  adminCreatePreset(b: Partial<ComputePreset>): Promise<ComputePreset> {
    return this.single<ComputePreset>("POST", "/admin/presets", b);
  }
  adminUpdatePreset(presetId: string, b: Partial<ComputePreset>): Promise<ComputePreset> {
    return this.single<ComputePreset>("PUT", `/admin/presets/${presetId}`, b);
  }
  async adminDeletePreset(presetId: string): Promise<void> {
    await this.request<void>("DELETE", `/admin/presets/${presetId}`);
  }
  adminListPermTemplates(): Promise<PermissionTemplate[]> {
    return this.list<PermissionTemplate>("GET", "/admin/permission-templates");
  }
  adminCreatePermTemplate(b: { displayName: string; policyDocument: object }): Promise<PermissionTemplate> {
    return this.single<PermissionTemplate>("POST", "/admin/permission-templates", b);
  }
  adminUpdatePermTemplate(permId: string, b: { displayName?: string; policyDocument?: object }): Promise<PermissionTemplate> {
    return this.single<PermissionTemplate>("PUT", `/admin/permission-templates/${permId}`, b);
  }
  async adminDeletePermTemplate(permId: string): Promise<void> {
    await this.request<void>("DELETE", `/admin/permission-templates/${permId}`);
  }
  adminListUsers(): Promise<PlatformUser[]> {
    return this.list<PlatformUser>("GET", "/admin/users");
  }
  adminInviteUser(email: string, group?: "admin" | "user"): Promise<{ username: string; email: string; group: string }> {
    return this.single("POST", "/admin/users", group ? { email, group } : { email });
  }
  adminPatchUser(username: string, b: { group?: string; enabled?: boolean }): Promise<{ username: string }> {
    return this.single("PATCH", `/admin/users/${username}`, b);
  }
  adminListAllApps(status?: string): Promise<App[]> {
    return this.list<App>("GET", status ? `/admin/apps?status=${status}` : "/admin/apps");
  }
  adminAlbRegistry(): Promise<AlbRegistry[]> {
    return this.list<AlbRegistry>("GET", "/admin/alb-registry");
  }
  // POST /admin/apps/{id}/stop — 강제 중지(재우기). 응답: {appId, runtimeState:"SLEEPING", stopped}.
  adminStopApp(appId: string): Promise<AdminStopResult> {
    return this.single<AdminStopResult>("POST", `/admin/apps/${appId}/stop`);
  }
  // DELETE /admin/apps/{id} — 관리자에 의한 타인 앱 삭제. 응답: {appId,status:"DELETING"}.
  adminDeleteApp(appId: string): Promise<{ appId: string; status: "DELETING" }> {
    return this.single("DELETE", `/admin/apps/${appId}`);
  }
}
