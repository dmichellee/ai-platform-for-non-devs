/**
 * 목 데이터 — QA/데모가 백엔드 없이 전 화면을 볼 수 있게 하는 픽스처.
 * 계약(api-contract.md)의 shape을 정확히 따른다. 조직 식별정보 금지(가공된 예시명만).
 */
import type {
  AdminSettings,
  AlbRegistry,
  App,
  CodeCommitRepo,
  ComputePreset,
  Deployment,
  MetricPoint,
  MetricRange,
  PermissionTemplate,
  PlatformUser,
  RepoConnection,
} from "../lib/types.js";

const now = Date.now();
const iso = (msAgo: number): string => new Date(now - msAgo).toISOString();

export const MOCK_USER_SUB = "user-0001";

export const mockApps: App[] = [
  {
    appId: "a1b2c3d4",
    ownerId: MOCK_USER_SUB,
    name: "고객문의 챗봇",
    subdomain: "chat-bot",
    provider: "github",
    repoUrl: "https://github.com/example/chat-bot",
    branch: "main",
    connectionArn: "arn:mock:connection/1",
    presetId: "preset-medium",
    permissionTemplateId: "perm-ai",
    scheme: "internal",
    autoDeployEnabled: true,
    sleepMode: "on-demand",
    envVars: { GREETING: "안녕하세요" },
    secretKeys: ["OPENAI_API_KEY"],
    status: "ACTIVE",
    runtimeState: "RUNNING",
    cognitoProtect: false,
    createdAt: iso(1000 * 60 * 60 * 24 * 12),
    updatedAt: iso(1000 * 60 * 60 * 2),
  },
  {
    appId: "e5f6a7b8",
    ownerId: MOCK_USER_SUB,
    name: "매출 대시보드",
    subdomain: "sales-board",
    provider: "codecommit",
    // 이 앱은 AWS 저장소(CodeCommit) 레포 daeun-sales-board 를 쓴다 → 그 레포는 삭제 시 REPO_IN_USE.
    repoUrl: "https://git-codecommit.example/v1/repos/daeun-sales-board",
    branch: "main",
    presetId: "preset-small",
    permissionTemplateId: "perm-basic",
    scheme: "internal",
    autoDeployEnabled: false,
    sleepMode: "schedule",
    schedule: { startTime: "09:00", stopTime: "19:00", days: [1, 2, 3, 4, 5], timezone: "Asia/Seoul" },
    envVars: {},
    secretKeys: [],
    status: "ACTIVE",
    runtimeState: "SLEEPING",
    cognitoProtect: false,
    createdAt: iso(1000 * 60 * 60 * 24 * 30),
    updatedAt: iso(1000 * 60 * 60 * 24 * 3),
  },
  {
    appId: "c9d0e1f2",
    ownerId: MOCK_USER_SUB,
    name: "회의록 정리 도구",
    subdomain: "meeting-notes",
    provider: "github",
    repoUrl: "https://github.com/example/meeting-notes",
    branch: "main",
    connectionArn: "arn:mock:connection/1",
    presetId: "preset-medium",
    permissionTemplateId: "perm-ai",
    scheme: "internal",
    autoDeployEnabled: true,
    sleepMode: "on-demand",
    envVars: {},
    secretKeys: [],
    status: "ACTIVE",
    runtimeState: "WAKING",
    cognitoProtect: false,
    createdAt: iso(1000 * 60 * 60 * 24 * 5),
    updatedAt: iso(1000 * 60 * 30),
  },
  {
    appId: "99887766",
    ownerId: MOCK_USER_SUB,
    name: "재고 알림봇",
    subdomain: "stock-alert",
    provider: "gitlab",
    repoUrl: "https://gitlab.com/example/stock-alert",
    branch: "main",
    connectionArn: "arn:mock:connection/2",
    presetId: "preset-small",
    permissionTemplateId: "perm-basic",
    scheme: "internal",
    autoDeployEnabled: true,
    sleepMode: "always-on",
    envVars: {},
    secretKeys: [],
    status: "FAILED",
    runtimeState: "SLEEPING",
    failureReason:
      "배포 준비(빌드 환경 구성) 중 문제가 발생했어요. 다시 시도하거나 관리자에게 문의해주세요.",
    // failureDetail 은 admin 응답에만 — 목 데이터에는 user 관점을 기본으로 둔다(있어도 무해).
    cognitoProtect: false,
    createdAt: iso(1000 * 60 * 60 * 24 * 1),
    updatedAt: iso(1000 * 60 * 5),
  },
  {
    appId: "11223344",
    ownerId: MOCK_USER_SUB,
    name: "외부 랜딩 페이지",
    subdomain: "landing",
    provider: "github",
    repoUrl: "https://github.com/example/landing",
    branch: "main",
    connectionArn: "arn:mock:connection/1",
    presetId: "preset-large",
    permissionTemplateId: "perm-basic",
    scheme: "internet-facing",
    autoDeployEnabled: true,
    sleepMode: "always-on",
    envVars: {},
    secretKeys: [],
    status: "CREATING",
    runtimeState: "SLEEPING",
    cognitoProtect: true,
    createdAt: iso(1000 * 60 * 2),
    updatedAt: iso(1000 * 60 * 1),
  },
];

// 다른 소유자 앱 (관리자 전체 현황용)
export const mockOtherApps: App[] = [
  {
    ...mockApps[0]!,
    appId: "77aa88bb",
    ownerId: "user-0002",
    name: "인사 FAQ 봇",
    subdomain: "hr-faq",
    runtimeState: "RUNNING",
    status: "ACTIVE",
  },
];

export const mockDeployments: Record<string, Deployment[]> = {
  a1b2c3d4: [
    {
      appId: "a1b2c3d4",
      deploymentId: iso(1000 * 60 * 60 * 2),
      commitSha: "9f3c1a2",
      commitMessage: "환영 문구 수정",
      trigger: "auto",
      status: "SUCCEEDED",
      createdAt: iso(1000 * 60 * 60 * 2),
      updatedAt: iso(1000 * 60 * 60 * 2),
    },
    {
      appId: "a1b2c3d4",
      deploymentId: iso(1000 * 60 * 60 * 26),
      commitSha: "1b8e7d0",
      commitMessage: "초기 배포",
      trigger: "auto",
      status: "SUCCEEDED",
      createdAt: iso(1000 * 60 * 60 * 26),
      updatedAt: iso(1000 * 60 * 60 * 26),
    },
  ],
  "99887766": [
    {
      appId: "99887766",
      deploymentId: iso(1000 * 60 * 5),
      commitSha: "aa11bb2",
      commitMessage: "알림 로직 추가",
      trigger: "auto",
      status: "FAILED",
      failureCategory: "BUILD_FAILED",
      logsLocation: "/apphub/dev/app/99887766",
      createdAt: iso(1000 * 60 * 5),
      updatedAt: iso(1000 * 60 * 5),
    },
  ],
  c9d0e1f2: [
    {
      appId: "c9d0e1f2",
      deploymentId: iso(1000 * 60 * 30),
      commitSha: "cc44dd5",
      commitMessage: "요약 품질 개선",
      trigger: "manual",
      status: "DEPLOYING",
      createdAt: iso(1000 * 60 * 30),
      updatedAt: iso(1000 * 60 * 28),
    },
  ],
};

export const mockLogs: Record<string, { timestamp: number; message: string }[]> = {
  a1b2c3d4: Array.from({ length: 40 }, (_, i) => ({
    timestamp: now - (40 - i) * 3000,
    message:
      i % 5 === 0
        ? `[info] 요청 처리 완료 GET /health 200 (${2 + (i % 7)}ms)`
        : `[info] 채팅 응답 생성 완료 tokens=${120 + i * 3}`,
  })),
  "99887766": [
    { timestamp: now - 9000, message: "[build] Step 3/8 : RUN npm install" },
    { timestamp: now - 6000, message: "[build] npm ERR! code ERESOLVE" },
    { timestamp: now - 3000, message: "[build] npm ERR! peer dependency conflict: react@19" },
    { timestamp: now - 1000, message: "[build] The command '/bin/sh -c npm install' returned a non-zero code: 1" },
  ],
};

export const mockConnections: RepoConnection[] = [
  {
    connId: "conn-0001",
    ownerId: MOCK_USER_SUB,
    provider: "github",
    connectionArn: "arn:mock:connection/1",
    status: "AVAILABLE",
    displayName: "회사 GitHub",
    createdAt: iso(1000 * 60 * 60 * 24 * 20),
    updatedAt: iso(1000 * 60 * 60 * 24 * 20),
  },
  {
    connId: "conn-0002",
    ownerId: MOCK_USER_SUB,
    provider: "gitlab",
    connectionArn: "arn:mock:connection/2",
    status: "PENDING",
    displayName: "사내 GitLab",
    createdAt: iso(1000 * 60 * 10),
    updatedAt: iso(1000 * 60 * 10),
  },
  {
    connId: "conn-0003",
    ownerId: MOCK_USER_SUB,
    provider: "codecommit",
    connectionArn: "arn:mock:connection/3",
    status: "AVAILABLE",
    displayName: "AWS 저장소",
    createdAt: iso(1000 * 60 * 60 * 24 * 4),
    updatedAt: iso(1000 * 60 * 60 * 24 * 4),
  },
];

// CodeCommit(AWS 저장소) 레포 — 사용자가 AppHub로 만든 것만 소유권 추적(계약).
// key = connId. 조직 식별정보 금지 → example 호스트/가공명.
// 저장 이름은 접두어 포함 최종 이름(서버가 {ownerPrefix}- 부착) — 목 세션(user) 접두어는 "daeun".
export const mockRepos: Record<string, CodeCommitRepo[]> = {
  "conn-0003": [
    { repoName: "daeun-sales-board", cloneUrlHttp: "https://git-codecommit.example/v1/repos/daeun-sales-board" },
    { repoName: "daeun-meeting-notes", cloneUrlHttp: "https://git-codecommit.example/v1/repos/daeun-meeting-notes" },
  ],
};

export const mockPresets: ComputePreset[] = [
  { presetId: "preset-small", displayName: "작게", cpu: 512, memory: 1024, minCount: 1, maxCount: 2, scaleMetric: "cpu", scaleThreshold: 70 },
  { presetId: "preset-medium", displayName: "보통", cpu: 1024, memory: 2048, minCount: 1, maxCount: 4, scaleMetric: "cpu", scaleThreshold: 65 },
  { presetId: "preset-large", displayName: "크게", cpu: 2048, memory: 4096, minCount: 2, maxCount: 8, scaleMetric: "requests", scaleThreshold: 500 },
];

export const mockPermTemplates: PermissionTemplate[] = [
  { permId: "perm-basic", displayName: "기본 (권한 없음)", policyDocument: { Version: "2012-10-17", Statement: [] } },
  {
    permId: "perm-ai",
    displayName: "AI 기능 사용",
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: ["bedrock:InvokeModel"], Resource: "*" }],
    },
  },
];

export const mockSettings: AdminSettings = {
  enabledProviders: ["codecommit", "github", "gitlab"],
  userAppQuota: 5,
  allowInternetFacing: true,
  updatedAt: iso(1000 * 60 * 60 * 24 * 2),
};

// delta §8 — ACTIVE ALB(index 오름차순) + 증설 대기(PROVISIONING, albArn 없음).
export const mockAlbRegistry: AlbRegistry[] = [
  {
    albArn: "arn:aws:elasticloadbalancing:ap-northeast-2:111122223333:loadbalancer/app/apphub-dev-internet-alb/0a1b2c3d4e5f6a7b",
    scheme: "internet-facing",
    schemeSlug: "internet",
    index: 0,
    status: "ACTIVE",
    ruleCount: 3,
    ruleLimit: 90,
    vpcId: "vpc-0a1b2c3d",
  },
  {
    albArn: "arn:aws:elasticloadbalancing:ap-northeast-2:111122223333:loadbalancer/app/apphub-dev-internal-alb/1b2c3d4e5f6a7b8c",
    scheme: "internal",
    schemeSlug: "internal",
    index: 0,
    status: "ACTIVE",
    ruleCount: 84,
    ruleLimit: 90,
    vpcId: "vpc-0a1b2c3d",
  },
  {
    scheme: "internal",
    schemeSlug: "internal",
    index: 1,
    status: "PROVISIONING",
    ruleCount: 0,
    ruleLimit: 90,
  },
];

export const mockUsers: PlatformUser[] = [
  { username: "user-0001", email: "daeun@example.com", enabled: true, status: "CONFIRMED", groups: ["user"], createdAt: iso(1000 * 60 * 60 * 24 * 40) },
  { username: "user-0002", email: "hyunwoo@example.com", enabled: true, status: "CONFIRMED", groups: ["user"], createdAt: iso(1000 * 60 * 60 * 24 * 25) },
  { username: "admin-0001", email: "admin@example.com", enabled: true, status: "CONFIRMED", groups: ["admin", "user"], createdAt: iso(1000 * 60 * 60 * 24 * 60) },
  { username: "user-0003", email: "jimin@example.com", enabled: false, status: "CONFIRMED", groups: ["user"], createdAt: iso(1000 * 60 * 60 * 24 * 3) },
];

// ── 모니터링 지표(목) — range별 그럴듯한 시계열 (api-requests.md #6) ──
// 버킷 개수/간격은 range에 따라 달라진다. 값은 결정적 sine+노이즈로 "살아 있는" 그래프처럼 보이게.
const RANGE_BUCKETS: Record<MetricRange, { points: number; stepMs: number }> = {
  "1h": { points: 30, stepMs: 2 * 60 * 1000 }, // 2분 간격 × 30 = 1시간
  "6h": { points: 36, stepMs: 10 * 60 * 1000 }, // 10분 간격 × 36 = 6시간
  "24h": { points: 48, stepMs: 30 * 60 * 1000 }, // 30분 간격 × 48 = 24시간
  "7d": { points: 42, stepMs: 4 * 60 * 60 * 1000 }, // 4시간 간격 × 42 = 7일
};

/** 결정적 시계열 생성기 — 외부 랜덤 없이 재현 가능한 값. seed로 series별 위상 차이를 준다. */
function series(points: number, stepMs: number, seed: number, base: number, amp: number, max: number): MetricPoint[] {
  const end = now;
  const start = end - (points - 1) * stepMs;
  return Array.from({ length: points }, (_, i) => {
    const t = new Date(start + i * stepMs).toISOString().replace(/\.\d{3}Z$/, "Z");
    const wave = Math.sin((i + seed) / 4) * amp + Math.sin((i + seed) / 1.7) * (amp / 3);
    const drift = Math.cos((i + seed) / 9) * (amp / 2);
    const v = Math.max(0, Math.min(max, Math.round(base + wave + drift)));
    return { t, v };
  });
}

export function buildMockMetrics(range: MetricRange): {
  requests: MetricPoint[];
  cpu: MetricPoint[];
  memory: MetricPoint[];
} {
  const { points, stepMs } = RANGE_BUCKETS[range];
  return {
    requests: series(points, stepMs, 0, 120, 90, 400), // 요청 수
    cpu: series(points, stepMs, 3, 42, 22, 100), // CPU 사용률 %
    memory: series(points, stepMs, 6, 58, 12, 100), // 메모리 사용률 %
  };
}
