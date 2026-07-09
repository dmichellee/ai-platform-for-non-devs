/**
 * API 계약 타입 — 단일 원본은 _workspace/contracts/api-contract.md.
 * 여기 정의된 shape은 계약 문서를 그대로 옮긴 것이다. 계약에 없는 필드를 추측해서 추가하지 않는다.
 */

// ── 리터럴 유니온 (상태 기계 — apphub-conventions 5장 / 계약 상태 기계) ──
export type Provider = "codecommit" | "github" | "gitlab";
export type Scheme = "internet-facing" | "internal";
export type SleepMode = "always-on" | "on-demand" | "schedule";
export type AppStatus = "CREATING" | "ACTIVE" | "FAILED" | "DELETING";
export type RuntimeState = "RUNNING" | "WAKING" | "SLEEPING";

export type DeploymentStatus =
  | "PENDING"
  | "VALIDATING"
  | "BUILDING"
  | "DEPLOYING"
  | "SUCCEEDED"
  | "FAILED";

export type FailureCategory =
  | "DOCKERFILE_MISSING"
  | "DOCKERFILE_INVALID"
  | "BUILD_FAILED"
  | "HEALTHCHECK_FAILED"
  | "SOURCE_UNAVAILABLE"
  | "DEPLOY_FAILED"
  | "INTERNAL_ERROR";

export type DeploymentTrigger = "auto" | "manual" | "rollback";

export type ConnectionStatus = "PENDING" | "AVAILABLE" | "ERROR";

export interface Schedule {
  startTime: string; // "HH:MM"
  stopTime: string; // "HH:MM"
  days: number[];
  timezone: string;
}

// ── 엔티티 (계약 "엔티티 응답 shape") ──
export interface App {
  appId: string;
  ownerId: string;
  name: string;
  subdomain: string;
  provider: Provider;
  repoUrl: string;
  branch: string;
  connectionArn?: string;
  presetId: string;
  permissionTemplateId: string;
  scheme: Scheme;
  vpcId: string;
  autoDeployEnabled: boolean;
  sleepMode: SleepMode;
  schedule?: Schedule;
  envVars: Record<string, string>;
  secretArns: Record<string, string>;
  status: AppStatus;
  runtimeState: RuntimeState;
  albArn?: string; // 내부용, 화면 미노출
  rulePriority?: number; // 내부용
  cognitoProtect: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Deployment {
  appId: string;
  deploymentId: string;
  commitSha?: string;
  commitMessage?: string;
  trigger: DeploymentTrigger;
  status: DeploymentStatus;
  failureCategory?: FailureCategory;
  pipelineExecutionId?: string;
  logsLocation?: string;
  createdAt: string;
  updatedAt: string;
  note?: string; // POST deploy/rollback 응답에만
}

export interface RepoConnection {
  connId: string;
  ownerId: string;
  provider: Provider;
  connectionArn: string;
  status: ConnectionStatus;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  needsAuthorization?: boolean; // POST 응답에만
}

export interface ComputePreset {
  presetId: string;
  displayName: string;
  cpu: number;
  memory: number;
  minCount: number;
  maxCount: number;
  scaleMetric: "cpu" | "requests";
  scaleThreshold: number;
}

export interface PermissionTemplate {
  permId: string;
  displayName: string;
  policyDocument: object;
}

export interface AdminSettings {
  enabledProviders: string[];
  registeredVpcs: { vpcId: string; label: string }[];
  userAppQuota: number;
  allowInternetFacing: boolean;
  allowedBaseImages: string[];
  logRetentionDays: number;
  updatedAt?: string;
}

export interface AlbRegistry {
  albArn: string;
  scheme: Scheme;
  vpcId: string;
  ruleCount: number;
}

export interface PlatformUser {
  username: string;
  email: string;
  enabled: boolean;
  status: string;
  groups: string[];
  createdAt?: string;
}

export interface LogEvent {
  timestamp: number;
  message: string;
}

// ── 응답 봉투 (계약 3장) ──
export interface ApiErrorBody {
  code: string;
  message: string;
}

export interface SingleEnvelope<T> {
  data: T;
}
export interface ListEnvelope<T> {
  data: { items: T[]; nextToken?: string };
}
export interface LogsEnvelope {
  data: { events: LogEvent[]; nextToken?: string };
}
export interface ErrorEnvelope {
  error: ApiErrorBody;
}

// ── 요청 body ──
export interface CreateAppRequest {
  name: string;
  subdomain: string;
  provider: Provider;
  repoUrl: string;
  branch?: string;
  connectionId?: string;
  presetId: string;
  permissionTemplateId: string;
  scheme: Scheme;
  vpcId: string;
  autoDeployEnabled?: boolean;
  sleepMode: SleepMode;
  schedule?: Schedule;
  envVars?: Record<string, string>;
  cognitoProtect?: boolean;
}

export interface PatchAppRequest {
  autoDeployEnabled?: boolean;
  sleepMode?: SleepMode;
  schedule?: Schedule;
  envVars?: Record<string, string>;
  cognitoProtect?: boolean;
}
