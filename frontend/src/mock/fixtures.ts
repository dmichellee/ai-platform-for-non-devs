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
    vpcId: "vpc-01",
    autoDeployEnabled: true,
    sleepMode: "on-demand",
    envVars: { GREETING: "안녕하세요" },
    secretArns: { OPENAI_API_KEY: "arn:mock:secret/openai" },
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
    repoUrl: "https://git.example.internal/sales-board",
    branch: "main",
    presetId: "preset-small",
    permissionTemplateId: "perm-basic",
    scheme: "internal",
    vpcId: "vpc-01",
    autoDeployEnabled: false,
    sleepMode: "schedule",
    schedule: { startTime: "09:00", stopTime: "19:00", days: [1, 2, 3, 4, 5], timezone: "Asia/Seoul" },
    envVars: {},
    secretArns: {},
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
    vpcId: "vpc-01",
    autoDeployEnabled: true,
    sleepMode: "on-demand",
    envVars: {},
    secretArns: {},
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
    vpcId: "vpc-01",
    autoDeployEnabled: true,
    sleepMode: "always-on",
    envVars: {},
    secretArns: {},
    status: "FAILED",
    runtimeState: "SLEEPING",
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
    vpcId: "vpc-01",
    autoDeployEnabled: true,
    sleepMode: "always-on",
    envVars: {},
    secretArns: {},
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
export const mockRepos: Record<string, CodeCommitRepo[]> = {
  "conn-0003": [
    { repoName: "sales-board", cloneUrlHttp: "https://git-codecommit.example/v1/repos/sales-board" },
    { repoName: "meeting-notes", cloneUrlHttp: "https://git-codecommit.example/v1/repos/meeting-notes" },
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
  registeredVpcs: [{ vpcId: "vpc-01", label: "메인 VPC (ap-northeast-2)" }],
  userAppQuota: 5,
  allowInternetFacing: true,
  allowedBaseImages: ["public.ecr.aws/docker/library/node", "public.ecr.aws/docker/library/python"],
  logRetentionDays: 30,
  updatedAt: iso(1000 * 60 * 60 * 24 * 2),
};

export const mockAlbRegistry: AlbRegistry[] = [
  { albArn: "arn:mock:alb/internet-1", scheme: "internet-facing", vpcId: "vpc-01", ruleCount: 3 },
  { albArn: "arn:mock:alb/internal-1", scheme: "internal", vpcId: "vpc-01", ruleCount: 41 },
];

export const mockUsers: PlatformUser[] = [
  { username: "user-0001", email: "daeun@example.com", enabled: true, status: "CONFIRMED", groups: ["user"], createdAt: iso(1000 * 60 * 60 * 24 * 40) },
  { username: "user-0002", email: "hyunwoo@example.com", enabled: true, status: "CONFIRMED", groups: ["user"], createdAt: iso(1000 * 60 * 60 * 24 * 25) },
  { username: "admin-0001", email: "admin@example.com", enabled: true, status: "CONFIRMED", groups: ["admin", "user"], createdAt: iso(1000 * 60 * 60 * 24 * 60) },
  { username: "user-0003", email: "jimin@example.com", enabled: false, status: "CONFIRMED", groups: ["user"], createdAt: iso(1000 * 60 * 60 * 24 * 3) },
];
