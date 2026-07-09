/**
 * 사용자 노출 문구 매핑 — 단일 원본은 apphub-conventions SKILL.md (§4 failureCategory, §6 용어 사전).
 * AWS 내부 용어는 사용자 화면에 절대 노출하지 않는다. 관리자 화면은 기술 용어 허용.
 */
import type {
  AppStatus,
  ConnectionStatus,
  DeploymentStatus,
  FailureCategory,
  Provider,
  RuntimeState,
  Scheme,
  SleepMode,
} from "./types.js";

// ── failureCategory → "Kiro에게 …요청하세요" 행동 지침 (conventions §4) ──
export const FAILURE_GUIDANCE: Record<FailureCategory, string> = {
  DOCKERFILE_MISSING:
    "배포에 필요한 설정 파일(Dockerfile)이 없어요. Kiro에게 '이 앱을 배포 표준에 맞게 준비해줘'라고 요청한 뒤 다시 push 해주세요.",
  DOCKERFILE_INVALID:
    "앱 설정이 배포 표준과 달라요. Kiro에게 '배포 표준(8080 포트, /health 응답)에 맞춰줘'라고 요청하세요.",
  BUILD_FAILED:
    "앱을 빌드하는 중 오류가 발생했어요. 아래 로그 마지막 부분을 복사해 Kiro에게 '이 빌드 오류를 고쳐줘'라고 전달하세요.",
  HEALTHCHECK_FAILED:
    "앱이 시작됐지만 상태 확인(/health)에 응답하지 않아요. Kiro에게 '/health 경로에 200 응답을 추가해줘'라고 요청하세요.",
  SOURCE_UNAVAILABLE:
    "코드 저장소에 접근할 수 없어요. '저장소 연결' 메뉴에서 연결 상태를 확인해주세요.",
  DEPLOY_FAILED:
    "새 버전 적용에 실패해서 이전 버전으로 되돌렸어요. 문제가 반복되면 관리자에게 문의해주세요.",
  INTERNAL_ERROR: "플랫폼 내부 문제예요. 관리자에게 문의해주세요.",
};

export function failureGuidance(cat?: FailureCategory): string {
  if (!cat) return "배포 중 문제가 발생했어요. 관리자에게 문의해주세요.";
  return FAILURE_GUIDANCE[cat];
}

// ── runtimeState → 한국어 라벨 + 배지 톤 (design-system tokens.md 상태 색 매핑) ──
export type BadgeTone = "running" | "sleeping" | "waking" | "fail" | "pending";

export const RUNTIME_LABEL: Record<RuntimeState, string> = {
  RUNNING: "실행 중",
  WAKING: "깨우는 중",
  SLEEPING: "잠자는 중",
};

export const RUNTIME_TONE: Record<RuntimeState, BadgeTone> = {
  RUNNING: "running",
  WAKING: "waking",
  SLEEPING: "sleeping",
};

// ── App.status → 한국어 라벨 (사용자 화면) ──
export const STATUS_LABEL: Record<AppStatus, string> = {
  CREATING: "만드는 중",
  ACTIVE: "준비됨",
  FAILED: "실패",
  DELETING: "삭제 중",
};

// status=FAILED는 두 원인(생성 실패 / 삭제 실패) — updatedAt 이전 상태를 알 수 없으므로 안내 문구는 중립적으로.
export function statusHint(status: AppStatus): string {
  switch (status) {
    case "CREATING":
      return "앱을 준비하고 있어요. 잠시만 기다려주세요.";
    case "FAILED":
      return "앱 준비 또는 정리 중 문제가 발생했어요. 자세한 내용은 배포 이력을 확인하거나 관리자에게 문의해주세요.";
    case "DELETING":
      return "앱을 정리하고 있어요.";
    case "ACTIVE":
      return "";
  }
}

// ── Deployment.status → 사용자 화면 단계 라벨 (가져오기→검사→빌드→배포→확인) ──
export const DEPLOY_STATUS_LABEL: Record<DeploymentStatus, string> = {
  PENDING: "대기 중",
  VALIDATING: "검사 중",
  BUILDING: "빌드 중",
  DEPLOYING: "배포 중",
  SUCCEEDED: "완료",
  FAILED: "실패",
};

// 배포 상세 진행 단계 (DESIGN 6장: 가져오기→검사→빌드→배포→확인)
export const DEPLOY_STEPS: { key: string; label: string; reaches: DeploymentStatus[] }[] = [
  { key: "fetch", label: "가져오기", reaches: ["PENDING"] },
  { key: "validate", label: "검사", reaches: ["VALIDATING"] },
  { key: "build", label: "빌드", reaches: ["BUILDING"] },
  { key: "deploy", label: "배포", reaches: ["DEPLOYING"] },
  { key: "confirm", label: "확인", reaches: ["SUCCEEDED"] },
];

// ── sleepMode → 사용자 옵션 라벨 (DESIGN 3.5: 항상 켜두기 / 쓸 때만 켜기(권장) / 시간표대로) ──
export const SLEEP_MODE_LABEL: Record<SleepMode, string> = {
  "always-on": "항상 켜두기",
  "on-demand": "쓸 때만 켜기 (권장)",
  schedule: "시간표대로",
};

export const SLEEP_MODE_DESC: Record<SleepMode, string> = {
  "always-on": "언제 접속해도 바로 열려요. 대신 쉬는 시간에도 계속 켜져 있어요.",
  "on-demand":
    "쓰지 않을 땐 잠들고, 접속하면 자동으로 깨어나요. 처음 접속 시 30초~1분 정도 걸릴 수 있어요.",
  schedule: "정해둔 시간대에만 켜져 있어요. (예: 평일 09:00–19:00)",
};

// ── scheme → 공개 범위 라벨 (용어 사전: internet-facing/internal 금지) ──
export const SCHEME_LABEL: Record<Scheme, string> = {
  "internet-facing": "회사 밖에서도 접속",
  internal: "사내에서만",
};

export const SCHEME_DESC: Record<Scheme, string> = {
  "internet-facing": "인터넷에서 접속할 수 있어요. 관리자 승인이 필요할 수 있어요.",
  internal: "회사 네트워크 안에서만 접속할 수 있어요. (권장)",
};

// ── provider → 저장소 종류 라벨 ──
export const PROVIDER_LABEL: Record<Provider, string> = {
  codecommit: "AWS 저장소(CodeCommit)",
  github: "GitHub",
  gitlab: "GitLab",
};

// ── 저장소 연결 상태 (레포 연결 관리 화면) ──
export const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  AVAILABLE: "사용 가능",
  PENDING: "승인 대기 중",
  ERROR: "연결 오류",
};

export const CONNECTION_TONE: Record<ConnectionStatus, BadgeTone> = {
  AVAILABLE: "running",
  PENDING: "pending",
  ERROR: "fail",
};

// ── 에러 코드 → 보조 안내 (계약 에러 사전. message는 그대로 노출, code로 부가 힌트) ──
export function errorFallbackMessage(code?: string): string {
  switch (code) {
    case "QUOTA_EXCEEDED":
      return "만들 수 있는 앱 개수를 초과했어요. 쓰지 않는 앱을 삭제한 뒤 다시 시도해주세요.";
    case "SUBDOMAIN_TAKEN":
      return "이미 사용 중인 주소예요. 다른 주소를 입력해주세요.";
    case "SUBDOMAIN_INVALID":
      return "주소 형식이 올바르지 않아요. 소문자·숫자·하이픈만, 3~40자로 입력해주세요.";
    case "CONNECTION_NOT_READY":
      return "저장소 연결이 아직 승인되지 않았어요. '저장소 연결' 메뉴에서 승인을 완료해주세요.";
    case "INTERNET_FACING_NOT_ALLOWED":
      return "회사 밖 접속은 현재 허용되지 않았어요. 관리자에게 문의해주세요.";
    case "FORBIDDEN":
      return "이 작업을 수행할 권한이 없어요.";
    case "NOT_FOUND":
      return "대상을 찾을 수 없어요.";
    case "INVALID_STATE":
      return "지금 상태에서는 이 작업을 할 수 없어요.";
    default:
      return "요청을 처리하지 못했어요. 잠시 후 다시 시도해주세요.";
  }
}
