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
  // status=FAILED일 때만 채워짐. 재시도 성공 시 사라지므로 optional.
  failureReason?: string; // 사용자용 한국어 요약(user·admin 모두 노출)
  failureDetail?: string; // 기술 상세 — admin 응답에만 포함(user 응답에는 없음)
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

// GET/POST /connections/{connId}/repos 응답 항목 — CodeCommit(AWS 저장소) 전용.
// 계약: 그 외 필드 없음. cloneUrlHttp를 앱 생성 body의 repoUrl로 사용한다.
export interface CodeCommitRepo {
  repoName: string;
  cloneUrlHttp: string;
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

// user용 권한 템플릿(앱 유형) 목록 항목 — GET /permission-templates.
// admin과 달리 policyDocument는 내려오지 않는다(민감 정보 비노출, api-requests.md #3).
export interface UserPermissionTemplate {
  permId: string;
  displayName: string;
}

// GET /subdomains/check 응답 — 서브도메인 실시간 중복/형식 확인 (api-requests.md #1).
// available=true면 사용 가능(reason 없음). false면 reason으로 원인 분기.
export interface SubdomainCheck {
  available: boolean;
  reason?: "INVALID" | "TAKEN";
}

// user용 네트워크(VPC) 목록 항목 — GET /vpcs (api-requests.md #5).
// 관리자 등록 VPC 중 앱 생성 마법사가 고를 수 있는 것만. 사용자 화면에서는 "네트워크"로 노출.
export interface RegisteredVpc {
  vpcId: string;
  label: string;
}

export interface AdminSettings {
  enabledProviders: string[];
  registeredVpcs: { vpcId: string; label: string }[];
  userAppQuota: number;
  allowInternetFacing: boolean;
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

// ── 모니터링 지표 (GET /apps/{id}/metrics — api-requests.md #6, backend 병렬 구현) ──
// 계약 shape: {data:{range, series:{requests:[{t,v}], cpu:[{t,v}], memory:[{t,v}]}}}.
export type MetricRange = "1h" | "6h" | "24h" | "7d";

export interface MetricPoint {
  t: number; // epoch ms (버킷 시작 시각)
  v: number; // requests=요청 수(정수), cpu/memory=사용률 백분율(0~100)
}

export interface AppMetrics {
  range: MetricRange;
  series: {
    requests: MetricPoint[];
    cpu: MetricPoint[];
    memory: MetricPoint[];
  };
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
