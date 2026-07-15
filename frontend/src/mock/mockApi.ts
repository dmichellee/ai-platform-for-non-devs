/**
 * 목 API 클라이언트 — 계약과 동일한 ApiClient 인터페이스를 픽스처로 구현.
 * 백엔드 없이 전 화면을 볼 수 있게 하고, 생성/수정/삭제는 메모리에서 반영한다.
 * 실제 배포/실행 API는 호출하지 않는다(요구 제약).
 */
import { ApiError, type ApiClient } from "../lib/api.js";
import { computeOwnerPrefix, type UserSession } from "../auth/tokens.js";
import type {
  AdminSettings,
  AlbRegistry,
  App,
  AppMetrics,
  CodeCommitRepo,
  ComputePreset,
  CreateAppRequest,
  Deployment,
  LogEvent,
  MetricRange,
  PatchAppRequest,
  PermissionTemplate,
  PlatformUser,
  Provider,
  RepoConnection,
  RestartResult,
  SubdomainCheck,
  UserPermissionTemplate,
} from "../lib/types.js";
import * as fx from "./fixtures.js";

const delay = (ms = 220): Promise<void> => new Promise((r) => setTimeout(r, ms));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// 목 모드에서 현재 세션을 읽는다 — AuthContext 와 동일한 localStorage 키.
// 서버가 하듯 저장소 이름 접두어({ownerPrefix}-)를 계산하기 위해 email/sub 가 필요하다.
const SESSION_STORAGE_KEY = "apphub-session";
function currentSession(): UserSession | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(SESSION_STORAGE_KEY) : null;
    return raw ? (JSON.parse(raw) as UserSession) : null;
  } catch {
    return null;
  }
}

export class MockApiClient implements ApiClient {
  private apps: App[] = clone(fx.mockApps);
  private otherApps: App[] = clone(fx.mockOtherApps);
  private deployments: Record<string, Deployment[]> = clone(fx.mockDeployments);
  private connections: RepoConnection[] = clone(fx.mockConnections);
  private repos: Record<string, CodeCommitRepo[]> = clone(fx.mockRepos);
  private presets: ComputePreset[] = clone(fx.mockPresets);
  private permTemplates: PermissionTemplate[] = clone(fx.mockPermTemplates);
  private settings: AdminSettings = clone(fx.mockSettings);
  private users: PlatformUser[] = clone(fx.mockUsers);
  private alb: AlbRegistry[] = clone(fx.mockAlbRegistry);

  private findApp(appId: string): App {
    const all = [...this.apps, ...this.otherApps];
    const app = all.find((a) => a.appId === appId);
    if (!app) throw new ApiError("NOT_FOUND", "앱을 찾을 수 없어요.", 404);
    return app;
  }

  async listApps(): Promise<App[]> {
    await delay();
    return clone(this.apps);
  }
  async getApp(appId: string): Promise<App> {
    await delay();
    return clone(this.findApp(appId));
  }
  async createApp(b: CreateAppRequest): Promise<App> {
    await delay(500);
    if (this.apps.length >= this.settings.userAppQuota) {
      throw new ApiError("QUOTA_EXCEEDED", "만들 수 있는 앱 개수를 초과했어요.", 409);
    }
    if (this.apps.some((a) => a.subdomain === b.subdomain)) {
      throw new ApiError("SUBDOMAIN_TAKEN", "이미 사용 중인 주소예요.", 409);
    }
    const nowIso = new Date().toISOString();
    // 비밀 설정값(secrets)은 서버가 Secrets Manager 에 저장하고 App.secretArns 에 KEY→ARN 만 남긴다.
    // 목: 각 KEY 에 대해 그럴듯한 ARN 을 만들어 준다(값 자체는 보관/노출하지 않음).
    const secretArns: Record<string, string> = {};
    for (const key of Object.keys(b.secrets ?? {})) {
      secretArns[key] = `arn:mock:secret/${b.subdomain}/${key}`;
    }
    const app: App = {
      appId: Math.random().toString(36).slice(2, 10),
      ownerId: fx.MOCK_USER_SUB,
      name: b.name,
      subdomain: b.subdomain,
      provider: b.provider,
      repoUrl: b.repoUrl,
      branch: b.branch ?? "main",
      ...(b.connectionId ? { connectionArn: `arn:mock:connection/${b.connectionId}` } : {}),
      presetId: b.presetId,
      permissionTemplateId: b.permissionTemplateId,
      scheme: b.scheme,
      // 네트워크는 플랫폼 자동 배치 — 프론트가 vpcId 를 안 보내거나 "platform" 을 보내도 서버가 기본값 처리.
      vpcId: b.vpcId ?? "platform",
      autoDeployEnabled: b.autoDeployEnabled ?? true,
      sleepMode: b.sleepMode,
      ...(b.schedule ? { schedule: b.schedule } : {}),
      envVars: b.envVars ?? {},
      secretArns,
      status: "CREATING",
      runtimeState: "SLEEPING",
      cognitoProtect: b.cognitoProtect ?? b.scheme === "internet-facing",
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.apps.unshift(app);
    // 목 데모: 3초 후 ACTIVE/RUNNING 으로 전이 (비동기 provision 흉내)
    setTimeout(() => {
      app.status = "ACTIVE";
      app.runtimeState = "RUNNING";
      app.updatedAt = new Date().toISOString();
    }, 3000);
    return clone(app);
  }
  async patchApp(appId: string, b: PatchAppRequest): Promise<App> {
    await delay();
    const app = this.findApp(appId);
    if (app.status === "DELETING") {
      throw new ApiError("INVALID_STATE", "삭제 중인 앱은 수정할 수 없어요.", 409);
    }
    if (b.autoDeployEnabled !== undefined) app.autoDeployEnabled = b.autoDeployEnabled;
    if (b.sleepMode !== undefined) app.sleepMode = b.sleepMode;
    if (b.schedule !== undefined) app.schedule = b.schedule;
    if (b.envVars !== undefined) app.envVars = b.envVars;
    if (b.cognitoProtect !== undefined) app.cognitoProtect = b.cognitoProtect;
    // 비밀 설정값: 보낸 KEY 만 새 ARN 부여(부분 갱신), secretsRemove 는 해당 KEY 제거.
    if (b.secrets) {
      for (const key of Object.keys(b.secrets)) {
        app.secretArns[key] = `arn:mock:secret/${app.subdomain}/${key}`;
      }
    }
    if (b.secretsRemove) {
      for (const key of b.secretsRemove) delete app.secretArns[key];
    }
    app.updatedAt = new Date().toISOString();
    return clone(app);
  }
  async deleteApp(appId: string): Promise<{ appId: string; status: "DELETING" }> {
    await delay();
    const app = this.findApp(appId);
    if (app.status === "CREATING") {
      throw new ApiError("INVALID_STATE", "만드는 중인 앱은 삭제할 수 없어요.", 409);
    }
    app.status = "DELETING";
    app.updatedAt = new Date().toISOString();
    return { appId, status: "DELETING" };
  }

  async deploy(appId: string): Promise<Deployment> {
    await delay();
    const app = this.findApp(appId);
    if (app.status !== "ACTIVE") {
      throw new ApiError("INVALID_STATE", "준비된 앱만 배포할 수 있어요.", 409);
    }
    const nowIso = new Date().toISOString();
    const dep: Deployment = {
      appId,
      deploymentId: nowIso,
      commitSha: Math.random().toString(16).slice(2, 9),
      commitMessage: "수동 배포",
      trigger: "manual",
      status: "PENDING",
      createdAt: nowIso,
      updatedAt: nowIso,
      note: "배포를 접수했어요. 진행 상황은 배포 이력에서 확인할 수 있어요.",
    };
    this.deployments[appId] = [dep, ...(this.deployments[appId] ?? [])];
    return clone(dep);
  }
  async listDeployments(appId: string, limit = 20): Promise<Deployment[]> {
    await delay();
    return clone((this.deployments[appId] ?? []).slice(0, limit));
  }
  async rollback(appId: string, deploymentId: string): Promise<Deployment> {
    await delay();
    const nowIso = new Date().toISOString();
    const dep: Deployment = {
      appId,
      deploymentId: nowIso,
      trigger: "rollback",
      status: "PENDING",
      commitMessage: `되돌리기 (${deploymentId})`,
      createdAt: nowIso,
      updatedAt: nowIso,
      note: "이전 버전으로 되돌리기를 접수했어요.",
    };
    this.deployments[appId] = [dep, ...(this.deployments[appId] ?? [])];
    return clone(dep);
  }

  // POST /apps/{id}/restart — 지금 버전 그대로 앱만 다시 켠다(빌드/배포 없음).
  // 계약 에러: SLEEPING 은 자동 기상 안내(409), 그 외 비ACTIVE 는 준비 상태 안내(409).
  async restartApp(appId: string): Promise<RestartResult> {
    await delay();
    const app = this.findApp(appId);
    if (app.status === "ACTIVE" && app.runtimeState === "SLEEPING") {
      throw new ApiError(
        "INVALID_STATE",
        "앱이 잠자는 중이에요. 접속 주소로 들어가면 자동으로 켜져요.",
        409,
      );
    }
    if (app.status !== "ACTIVE") {
      throw new ApiError(
        "INVALID_STATE",
        "앱이 준비된 상태(정상)일 때만 다시 시작할 수 있어요.",
        409,
      );
    }
    return {
      appId,
      note: "앱을 다시 시작하고 있어요. 잠시 후(약 1분) 새로고침해 주세요.",
    };
  }

  async getLogs(
    appId: string,
    _opts?: { limit?: number; nextToken?: string; startTime?: number },
  ): Promise<{ events: LogEvent[]; nextToken?: string }> {
    await delay(180);
    return { events: clone(fx.mockLogs[appId] ?? []) };
  }

  // 모니터링 지표(목) — 계약 shape 그대로. RUNNING 앱은 그럴듯한 시계열,
  // 그 외(SLEEPING/CREATING/FAILED)는 빈 series 로 "데이터 없음" 상태를 재현한다.
  async getMetrics(appId: string, range: MetricRange): Promise<AppMetrics> {
    await delay(240);
    const app = this.findApp(appId);
    const hasData = app.status === "ACTIVE" && app.runtimeState === "RUNNING";
    if (!hasData) {
      return { range, series: { requests: [], cpu: [], memory: [] } };
    }
    return { range, series: fx.buildMockMetrics(range) };
  }

  async listConnections(): Promise<RepoConnection[]> {
    await delay();
    return clone(this.connections);
  }
  async createConnection(provider: Provider, displayName: string): Promise<RepoConnection> {
    await delay();
    const nowIso = new Date().toISOString();
    const needsAuth = provider !== "codecommit";
    const conn: RepoConnection = {
      connId: `conn-${Math.random().toString(36).slice(2, 8)}`,
      ownerId: fx.MOCK_USER_SUB,
      provider,
      connectionArn: `arn:mock:connection/${Math.random().toString(16).slice(2, 6)}`,
      status: needsAuth ? "PENDING" : "AVAILABLE",
      displayName,
      createdAt: nowIso,
      updatedAt: nowIso,
      needsAuthorization: needsAuth,
    };
    this.connections.unshift(conn);
    return clone(conn);
  }
  async deleteConnection(connId: string): Promise<void> {
    await delay();
    this.connections = this.connections.filter((c) => c.connId !== connId);
    delete this.repos[connId];
  }

  // ── CodeCommit(AWS 저장소) 레포 — 계약 /connections/{connId}/repos ──
  private codecommitConn(connId: string): RepoConnection {
    const conn = this.connections.find((c) => c.connId === connId);
    // 본인 연결이 아니면 존재 여부를 흘리지 않고 404 (계약).
    if (!conn) throw new ApiError("NOT_FOUND", "저장소 연결을 찾을 수 없어요.", 404);
    if (conn.provider !== "codecommit") {
      throw new ApiError("VALIDATION_ERROR", "AWS 저장소 연결에서만 목록을 불러올 수 있어요.", 400);
    }
    return conn;
  }
  async listRepos(connId: string): Promise<CodeCommitRepo[]> {
    await delay();
    this.codecommitConn(connId);
    return clone(this.repos[connId] ?? []);
  }
  // 계약: body.repoName 은 **base 이름**. 서버(목)가 앞에 `{ownerPrefix}-` 를 붙여 최종 이름을 만들고,
  // 응답 repoName 은 접두어 포함 최종 이름이다. (프론트 미리보기와 동일한 접두어 규칙을 목도 구현.)
  async createRepo(connId: string, repoName: string): Promise<CodeCommitRepo> {
    await delay(320);
    this.codecommitConn(connId);
    const base = repoName;
    // base 이름 규칙(계약): 소문자·숫자로 시작·끝, 가운데 -/_/. 허용, .git 접미사 금지.
    const baseValid =
      /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(base) && !base.endsWith(".git");
    if (!baseValid) {
      throw new ApiError(
        "VALIDATION_ERROR",
        "저장소 이름은 소문자·숫자로 시작하고 끝나야 하며, 가운데에만 -, _, . 를 쓸 수 있어요.",
        400,
      );
    }
    // 서버측 접두어 강제 부착 — 현재 세션의 email/sub 로 접두어 계산(없으면 접두어 없이).
    const prefix = computeOwnerPrefix(currentSession());
    const finalName = prefix ? `${prefix}-${base}` : base;
    // 전체(접두어+base) 길이 ≤ 100자.
    if (finalName.length > 100) {
      throw new ApiError(
        "VALIDATION_ERROR",
        "저장소 이름이 너무 길어요. 뒷부분을 줄여주세요.",
        400,
      );
    }
    // 계정 전체 동명 레포 중복 → 409 (목: 모든 연결의 최종 이름을 통틀어 검사).
    const taken = Object.values(this.repos).some((list) => list.some((r) => r.repoName === finalName));
    if (taken) {
      throw new ApiError("REPO_NAME_TAKEN", "이미 같은 이름의 저장소가 있어요. 다른 이름을 써주세요.", 409);
    }
    const repo: CodeCommitRepo = {
      repoName: finalName,
      cloneUrlHttp: `https://git-codecommit.example/v1/repos/${finalName}`,
    };
    this.repos[connId] = [...(this.repos[connId] ?? []), repo];
    return clone(repo);
  }
  // 계약(backend 병렬): DELETE /connections/{connId}/repos/{repoName} → 204.
  // - 본인 codecommit 연결이 아니면 404(위 codecommitConn 규칙 재사용).
  // - 해당 연결에 그 이름의 레포가 없으면 404 NOT_FOUND.
  // - 그 레포(cloneUrlHttp)를 쓰는 앱이 하나라도 있으면 409 REPO_IN_USE(코드 삭제 방지).
  async deleteRepo(connId: string, repoName: string): Promise<void> {
    await delay(320);
    this.codecommitConn(connId);
    const list = this.repos[connId] ?? [];
    const repo = list.find((r) => r.repoName === repoName);
    if (!repo) throw new ApiError("NOT_FOUND", "저장소를 찾을 수 없어요.", 404);
    // 이 레포를 쓰는 앱이 있으면 삭제 불가(본인+타인 전체 대조 — 서버도 계정 범위로 검사).
    const inUse = [...this.apps, ...this.otherApps].some((a) => a.repoUrl === repo.cloneUrlHttp);
    if (inUse) {
      throw new ApiError(
        "REPO_IN_USE",
        "이 저장소를 사용 중인 앱이 있어요. 먼저 그 앱을 삭제한 뒤 다시 시도해주세요.",
        409,
      );
    }
    this.repos[connId] = list.filter((r) => r.repoName !== repoName);
  }

  // ── 앱 생성 마법사용 (user 권한) — api-requests.md #1~3 ──
  // 서브도메인 형식 규칙: 3~40자, 소문자·숫자·하이픈, 앞뒤 하이픈 금지, 예약어 금지 (계약 POST /apps 검증과 정합).
  private static readonly RESERVED_SUBDOMAINS = new Set(["www", "api", "admin", "app", "apps"]);
  async checkSubdomain(value: string): Promise<SubdomainCheck> {
    await delay(160);
    const v = value.trim();
    const validFormat = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(v);
    if (!validFormat || v.length < 3 || v.length > 40 || MockApiClient.RESERVED_SUBDOMAINS.has(v)) {
      return { available: false, reason: "INVALID" };
    }
    // 기존 목 앱(본인+타인 전체)의 서브도메인과 대조 → 전역 중복.
    const taken = [...this.apps, ...this.otherApps].some((a) => a.subdomain === v);
    if (taken) return { available: false, reason: "TAKEN" };
    return { available: true };
  }
  async listPresets(): Promise<ComputePreset[]> {
    await delay();
    return clone(this.presets);
  }
  async listPermTemplates(): Promise<UserPermissionTemplate[]> {
    await delay();
    // user 응답은 policyDocument 제외 (admin과 동일 목록에서 민감 필드만 뺀다).
    return this.permTemplates.map((t) => ({ permId: t.permId, displayName: t.displayName }));
  }
  async listProviders(): Promise<Provider[]> {
    await delay();
    // GET /providers — 관리자가 활성화한 provider만(연결 추가 화면용). 설정과 동일 원본.
    return this.settings.enabledProviders as Provider[];
  }

  async adminGetSettings(): Promise<AdminSettings> {
    await delay();
    return clone(this.settings);
  }
  async adminPutSettings(b: Omit<AdminSettings, "updatedAt">): Promise<AdminSettings> {
    await delay();
    // 관리자 설정 화면에서 더 이상 편집하지 않는 필드(registeredVpcs — 플랫폼 자동 배치로 전환,
    // logRetentionDays — 미사용)는 body 에 오지 않는다. 서버가 보유한 기존 값을 보존해 병합한다.
    this.settings = { ...this.settings, ...b, updatedAt: new Date().toISOString() };
    return clone(this.settings);
  }
  async adminListPresets(): Promise<ComputePreset[]> {
    await delay();
    return clone(this.presets);
  }
  async adminCreatePreset(b: Partial<ComputePreset>): Promise<ComputePreset> {
    await delay();
    // 계약: presetId 는 **키를 생략**하면 서버가 자동 발급. **키가 있으면 빈/공백 불가**(400).
    // (어제 추가된 빈ID 방어와 정합 — 프론트는 create 시 presetId 키 자체를 보내지 않아야 한다.)
    if ("presetId" in b && (typeof b.presetId !== "string" || b.presetId.trim() === "")) {
      throw new ApiError("VALIDATION_ERROR", "식별자가 비어 있어요.", 400);
    }
    const p: ComputePreset = {
      presetId: b.presetId ?? `preset-${Math.random().toString(36).slice(2, 7)}`,
      displayName: b.displayName ?? "새 프리셋",
      cpu: b.cpu ?? 512,
      memory: b.memory ?? 1024,
      minCount: b.minCount ?? 1,
      maxCount: b.maxCount ?? 2,
      scaleMetric: b.scaleMetric ?? "cpu",
      scaleThreshold: b.scaleThreshold ?? 70,
    };
    this.presets.push(p);
    return clone(p);
  }
  async adminUpdatePreset(presetId: string, b: Partial<ComputePreset>): Promise<ComputePreset> {
    await delay();
    const p = this.presets.find((x) => x.presetId === presetId);
    if (!p) throw new ApiError("PRESET_NOT_FOUND", "프리셋을 찾을 수 없어요.", 400);
    Object.assign(p, b);
    return clone(p);
  }
  async adminDeletePreset(presetId: string): Promise<void> {
    await delay();
    this.presets = this.presets.filter((x) => x.presetId !== presetId);
  }
  async adminListPermTemplates(): Promise<PermissionTemplate[]> {
    await delay();
    return clone(this.permTemplates);
  }
  async adminCreatePermTemplate(b: { displayName: string; policyDocument: object }): Promise<PermissionTemplate> {
    await delay();
    // 계약: permId 는 생략 시 자동 발급, **키가 있으면 빈/공백 불가**(400). (이슈 2 정합 — 프론트는
    // create 시 permId 키를 아예 보내지 않는다.) 방어적으로 permId 키가 섞여 오면 검증한다.
    const permIdKey = (b as { permId?: unknown }).permId;
    if ("permId" in b && (typeof permIdKey !== "string" || permIdKey.trim() === "")) {
      throw new ApiError("VALIDATION_ERROR", "식별자가 비어 있어요.", 400);
    }
    const t: PermissionTemplate = {
      permId: `perm-${Math.random().toString(36).slice(2, 7)}`,
      displayName: b.displayName,
      policyDocument: b.policyDocument,
    };
    this.permTemplates.push(t);
    return clone(t);
  }
  async adminUpdatePermTemplate(permId: string, b: { displayName?: string; policyDocument?: object }): Promise<PermissionTemplate> {
    await delay();
    const t = this.permTemplates.find((x) => x.permId === permId);
    if (!t) throw new ApiError("PERMISSION_TEMPLATE_NOT_FOUND", "권한 템플릿을 찾을 수 없어요.", 400);
    if (b.displayName !== undefined) t.displayName = b.displayName;
    if (b.policyDocument !== undefined) t.policyDocument = b.policyDocument;
    return clone(t);
  }
  async adminDeletePermTemplate(permId: string): Promise<void> {
    await delay();
    this.permTemplates = this.permTemplates.filter((x) => x.permId !== permId);
  }
  async adminListUsers(): Promise<PlatformUser[]> {
    await delay();
    return clone(this.users);
  }
  async adminInviteUser(email: string, group?: "admin" | "user"): Promise<{ username: string; email: string; group: string }> {
    await delay();
    const username = `user-${Math.random().toString(36).slice(2, 7)}`;
    this.users.push({ username, email, enabled: true, status: "FORCE_CHANGE_PASSWORD", groups: [group ?? "user"], createdAt: new Date().toISOString() });
    return { username, email, group: group ?? "user" };
  }
  async adminPatchUser(username: string, b: { group?: string; enabled?: boolean }): Promise<{ username: string }> {
    await delay();
    const u = this.users.find((x) => x.username === username);
    if (!u) throw new ApiError("NOT_FOUND", "사용자를 찾을 수 없어요.", 404);
    if (b.enabled !== undefined) u.enabled = b.enabled;
    if (b.group !== undefined) u.groups = b.group === "admin" ? ["admin", "user"] : ["user"];
    return { username };
  }
  async adminListAllApps(status?: string): Promise<App[]> {
    await delay();
    const all = [...this.apps, ...this.otherApps];
    return clone(status ? all.filter((a) => a.status === status) : all);
  }
  async adminAlbRegistry(): Promise<AlbRegistry[]> {
    await delay();
    return clone(this.alb);
  }
  // POST /admin/apps/{id}/stop — 강제 중지(재우기). ACTIVE 앱만 잠재울 수 있다.
  async adminStopApp(appId: string): Promise<App> {
    await delay();
    const app = this.findApp(appId);
    if (app.status !== "ACTIVE") {
      throw new ApiError("INVALID_STATE", "준비된 앱만 재울 수 있어요.", 409);
    }
    app.runtimeState = "SLEEPING";
    app.updatedAt = new Date().toISOString();
    return clone(app);
  }
  // DELETE /admin/apps/{id} — 관리자에 의한 타인 앱 삭제(소유자 검사 없음). 상태 기계는 deleteApp 과 동일.
  async adminDeleteApp(appId: string): Promise<{ appId: string; status: "DELETING" }> {
    await delay();
    const app = this.findApp(appId);
    if (app.status === "CREATING") {
      throw new ApiError("INVALID_STATE", "만드는 중인 앱은 삭제할 수 없어요.", 409);
    }
    app.status = "DELETING";
    app.updatedAt = new Date().toISOString();
    return { appId, status: "DELETING" };
  }
}
