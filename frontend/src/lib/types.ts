/**
 * API 계약 타입 — 백엔드 API 응답·요청 shape.
 * 여기 정의된 shape은 API 계약을 그대로 옮긴 것이다. 계약에 없는 필드를 추측해서 추가하지 않는다.
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

// secret-change: 비밀 설정값 저장 직후 서버가 시작한 재빌드 없는 재배포(D8).
export type DeploymentTrigger = "auto" | "manual" | "rollback" | "secret-change";

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
  // vpcId 없음 — VPC 선택 기능 폐기(플랫폼 VPC 단일 배치). 백엔드 응답에 없다(계약).
  autoDeployEnabled: boolean;
  sleepMode: SleepMode;
  schedule?: Schedule;
  envVars: Record<string, string>;
  // 비밀 설정값 KEY 목록(값·ARN 없음). 화면은 이 목록으로 비밀값 행을 그린다(D8).
  secretKeys: string[];
  status: AppStatus;
  runtimeState: RuntimeState;
  // status=FAILED일 때만 채워짐. 재시도 성공 시 사라지므로 optional.
  failureReason?: string; // 사용자용 한국어 요약(user·admin 모두 노출)
  failureDetail?: string; // 기술 상세 — admin 응답에만 포함(user 응답에는 없음)
  albArn?: string; // 내부용, 화면 미노출
  rulePriority?: number; // 내부용
  albIndex?: number; // 내부용, 화면 미노출 — 배정된 ALB 번호(없으면 0으로 간주). delta §8
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
  buildId?: string; // rollback(재배포) 접수 시 기록 — 내부 추적용, 화면 미노출
  createdAt: string;
  updatedAt: string;
  note?: string; // POST deploy/rollback 응답에만
}

// POST /apps/{id}/restart 응답 — 지금 버전 그대로 앱만 다시 켠다(배포 아님).
// 계약: {data:{appId, note}}. note 는 사용자에게 그대로 보여줄 한국어 안내.
export interface RestartResult {
  appId: string;
  note: string;
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

export interface AdminSettings {
  enabledProviders: string[];
  // registeredVpcs 는 계약상 응답에 여전히 존재할 수 있으나(플랫폼 VPC 자동 배치로 전환),
  // 관리자 설정 화면에서는 더 이상 편집하지 않는다(죽은 UI 제거). PUT body 에도 싣지 않는다.
  userAppQuota: number;
  allowInternetFacing: boolean;
  updatedAt?: string;
}

// GET /admin/alb-registry 항목 — delta §8 (D20 ALB 증설).
// ACTIVE: 운영 중 ALB. PROVISIONING: 증설 대기(albArn·vpcId 없음, ruleCount 0 또는 없음).
export type AlbStatus = "ACTIVE" | "PROVISIONING";
export type SchemeSlug = "internet" | "internal";

export interface AlbRegistry {
  albArn?: string; // PROVISIONING 항목에는 없다
  scheme: Scheme;
  schemeSlug: SchemeSlug;
  index: number; // 0 = 기본 ALB, 1 이상 = 증설
  status: AlbStatus;
  ruleCount: number;
  ruleLimit: number; // 90 (ALB_RULE_LIMIT)
  vpcId?: string;
}

// POST /admin/apps/{id}/stop 응답 — 계약: {appId, runtimeState:"SLEEPING", stopped}.
export interface AdminStopResult {
  appId: string;
  runtimeState: "SLEEPING";
  stopped: boolean;
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
  t: string; // ISO8601 UTC("2026-07-15T10:05:00Z") — 버킷 시작 시각(계약). 시간 오름차순.
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
// GET /apps/{id}/deployments/{deploymentId}/logs (2026-10-08 신설, QA M6) — 해당 배포의 검사·빌드·배포 단계 로그.
// 계약: {data:{events, nextToken?, source, stage?}}. 로그가 아직 없으면 events:[](200). 레코드 없음 404.
export type DeploymentLogSource = "validate-build" | "deploy" | "provisioner";
export interface DeploymentLogs {
  events: LogEvent[];
  nextToken?: string;
  source: DeploymentLogSource;
  stage?: "VALIDATING" | "DEPLOYING";
}
export interface DeploymentLogsEnvelope {
  data: DeploymentLogs;
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
  // vpcId 는 보내지 않는다 — 네트워크는 플랫폼이 자동 배치(계약: 서버는 받아도 무시).
  autoDeployEnabled?: boolean;
  sleepMode: SleepMode;
  schedule?: Schedule;
  // 평문 설정값(비밀 아님). secrets 와 분리 전송(계약 ④).
  envVars?: Record<string, string>;
  // 비밀 설정값 — 서버가 안전 보관. 응답 App.secretKeys 로 키 목록만 확인 가능.
  secrets?: Record<string, string>;
  cognitoProtect?: boolean;
}

/**
 * PATCH /apps/{id} 응답의 재배포 결과(D8 — 시크릿 변경 시 즉시 재배포).
 * 실제 시크릿 변경이 있는 PATCH 에서만 내려온다.
 *  - PENDING: 재빌드 없이 지금 버전으로 다시 배포를 접수(배포 이력에 trigger="secret-change").
 *  - SKIPPED/NOT_DEPLOYED: 아직 첫 배포 전 — 첫 배포 때 적용.
 *  - SKIPPED/IMAGE_NOT_FOUND·START_FAILED: 저장은 성공했지만 재배포를 시작 못 함 — '지금 배포'로 적용.
 * note: 서버가 주는 화면 노출용 한국어 안내. 있으면 그대로 우선 표시.
 */
export type RedeploySkipReason = "NOT_DEPLOYED" | "IMAGE_NOT_FOUND" | "START_FAILED";
export type RedeployResult =
  | { status: "PENDING"; deploymentId: string; note?: string }
  | { status: "SKIPPED"; reason: RedeploySkipReason; note?: string };

/**
 * PATCH /apps/{id} 응답의 자동 배포 토글 반영 결과(2026-10-08, QA M4).
 * autoDeployEnabled 가 실제로 바뀐 PATCH 에서만 내려온다(START_FAILED 재시도 예외). 서버가 배포 설정을 다시 적용(수 분).
 *  - APPLYING: 반영 중 — 몇 분 뒤 적용.
 *  - SKIPPED/START_FAILED: 저장은 유지, 바로 적용 못 함(같은 값으로 다시 저장하면 재시도).
 *  - SKIPPED/ALREADY_APPLYING: 이전 적용이 진행 중 → 이번 변경은 저장 안 됨(응답 autoDeployEnabled = 기존 값).
 *  - SKIPPED/NOT_READY: 저장은 됨, 앱이 준비되지 않아 바로 적용 못 함.
 * note: 화면에 그대로 노출 가능한 한국어.
 */
export type AutoDeploySkipReason = "START_FAILED" | "ALREADY_APPLYING" | "NOT_READY";
export type AutoDeployResult =
  | { status: "APPLYING"; note: string }
  | { status: "SKIPPED"; reason: AutoDeploySkipReason; note: string };

/** PATCH /apps/{id} 응답 data = 갱신된 App + (시크릿 변경 시) redeploy + (자동 배포 변경 시) autoDeploy. */
export type PatchAppResponse = App & { redeploy?: RedeployResult; autoDeploy?: AutoDeployResult };

export interface PatchAppRequest {
  autoDeployEnabled?: boolean;
  sleepMode?: SleepMode;
  schedule?: Schedule;
  // 평문 설정값 전체 교체(기존 규칙 유지).
  envVars?: Record<string, string>;
  // 새로/교체할 비밀 설정값(KEY→평문). 보낸 KEY 만 갱신(부분 갱신).
  secrets?: Record<string, string>;
  // 삭제할 비밀 설정값 KEY 목록. secrets 와 함께 보낼 수 있다.
  secretsRemove?: string[];
  cognitoProtect?: boolean;
}
