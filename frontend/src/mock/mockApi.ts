/**
 * 목 API 클라이언트 — 계약과 동일한 ApiClient 인터페이스를 픽스처로 구현.
 * 백엔드 없이 전 화면을 볼 수 있게 하고, 생성/수정/삭제는 메모리에서 반영한다.
 * 실제 배포/실행 API는 호출하지 않는다(요구 제약).
 */
import { ApiError, type ApiClient } from "../lib/api.js";
import type {
  AdminSettings,
  AlbRegistry,
  App,
  CodeCommitRepo,
  ComputePreset,
  CreateAppRequest,
  Deployment,
  LogEvent,
  PatchAppRequest,
  PermissionTemplate,
  PlatformUser,
  Provider,
  RepoConnection,
} from "../lib/types.js";
import * as fx from "./fixtures.js";

const delay = (ms = 220): Promise<void> => new Promise((r) => setTimeout(r, ms));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

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
      vpcId: b.vpcId,
      autoDeployEnabled: b.autoDeployEnabled ?? true,
      sleepMode: b.sleepMode,
      ...(b.schedule ? { schedule: b.schedule } : {}),
      envVars: b.envVars ?? {},
      secretArns: {},
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

  async getLogs(
    appId: string,
    _opts?: { limit?: number; nextToken?: string; startTime?: number },
  ): Promise<{ events: LogEvent[]; nextToken?: string }> {
    await delay(180);
    return { events: clone(fx.mockLogs[appId] ?? []) };
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
  async createRepo(connId: string, repoName: string): Promise<CodeCommitRepo> {
    await delay(320);
    this.codecommitConn(connId);
    // 이름 규칙(계약): 소문자·숫자로 시작·끝, 가운데 -/_/. 허용, 1~100자, .git 접미사 금지.
    const valid = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(repoName) && repoName.length <= 100 && !repoName.endsWith(".git");
    if (!valid) {
      throw new ApiError(
        "VALIDATION_ERROR",
        "저장소 이름은 소문자·숫자로 시작하고 끝나야 하며, 가운데에만 -, _, . 를 쓸 수 있어요.",
        400,
      );
    }
    // 계정 전체 동명 레포 중복 → 409 (목: 모든 연결의 레포 이름을 통틀어 검사).
    const taken = Object.values(this.repos).some((list) => list.some((r) => r.repoName === repoName));
    if (taken) {
      throw new ApiError("REPO_NAME_TAKEN", "이미 같은 이름의 저장소가 있어요. 다른 이름을 써주세요.", 409);
    }
    const repo: CodeCommitRepo = {
      repoName,
      cloneUrlHttp: `https://git-codecommit.example/v1/repos/${repoName}`,
    };
    this.repos[connId] = [...(this.repos[connId] ?? []), repo];
    return clone(repo);
  }

  async adminGetSettings(): Promise<AdminSettings> {
    await delay();
    return clone(this.settings);
  }
  async adminPutSettings(b: Omit<AdminSettings, "updatedAt">): Promise<AdminSettings> {
    await delay();
    this.settings = { ...b, updatedAt: new Date().toISOString() };
    return clone(this.settings);
  }
  async adminListPresets(): Promise<ComputePreset[]> {
    await delay();
    return clone(this.presets);
  }
  async adminCreatePreset(b: Partial<ComputePreset>): Promise<ComputePreset> {
    await delay();
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
    const t: PermissionTemplate = { permId: `perm-${Math.random().toString(36).slice(2, 7)}`, ...b };
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
}
