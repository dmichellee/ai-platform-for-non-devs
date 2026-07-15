/**
 * 상태 배지 — runtimeState/status를 시각적 점 + 한국어 라벨 쌍으로 표시.
 * 라벨·톤 매핑은 lib/labels.ts (단일 원본: design-system tokens.md 상태 색 매핑).
 */
import type { AppStatus, RuntimeState } from "../lib/types.js";
import {
  FIRST_DEPLOY_PENDING_LABEL,
  RUNTIME_LABEL,
  RUNTIME_TONE,
  STATUS_LABEL,
  type BadgeTone,
} from "../lib/labels.js";

export function Badge({
  tone,
  label,
  variant = "status",
}: {
  tone: BadgeTone;
  label: string;
  variant?: "status" | "pill";
}): JSX.Element {
  // pill 톤 클래스는 status와 이름이 다름(run/sleep/wake/fail/pending)
  const pillTone: Record<BadgeTone, string> = {
    running: "run",
    sleeping: "sleep",
    waking: "wake",
    fail: "fail",
    pending: "pending",
  };
  const cls = variant === "pill" ? `pill ${pillTone[tone]}` : `status ${tone}`;
  return (
    <span className={cls}>
      <span className="dot" aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * 사용자 화면 카드/상세용 상태 배지.
 * 우선순위: status가 진행/문제 상태면 그걸, ACTIVE면 runtimeState를 보여준다.
 *
 * pendingFirstDeploy: status=ACTIVE 이지만 첫 배포가 아직 성공하지 않은 경우 true.
 *   이때는 runtimeState(기본값 SLEEPING="잠자는 중")를 보여주면 "한 번도 뜬 적 없는데 잠들었다"는
 *   오해를 주므로 "준비 중"(pending 톤)으로 덮는다. 첫 배포 완료 여부는 배포 목록을 조회해야 알 수 있어
 *   그 조회를 하는 화면(앱 상세 상단)에서만 이 옵션을 켠다. 카드 목록 등 다른 사용처는 기본값(false).
 */
export function AppStatusBadge({
  status,
  runtimeState,
  variant = "status",
  pendingFirstDeploy = false,
}: {
  status: AppStatus;
  runtimeState: RuntimeState;
  variant?: "status" | "pill";
  pendingFirstDeploy?: boolean;
}): JSX.Element {
  if (status === "FAILED") {
    return <Badge tone="fail" label="실패" variant={variant} />;
  }
  if (status === "CREATING") {
    return <Badge tone="pending" label={STATUS_LABEL.CREATING} variant={variant} />;
  }
  if (status === "DELETING") {
    return <Badge tone="pending" label={STATUS_LABEL.DELETING} variant={variant} />;
  }
  // ACTIVE 이지만 첫 배포가 아직 성공하지 않았으면 "준비 중"으로.
  if (pendingFirstDeploy) {
    return <Badge tone="pending" label={FIRST_DEPLOY_PENDING_LABEL} variant={variant} />;
  }
  // ACTIVE → runtimeState
  return (
    <Badge tone={RUNTIME_TONE[runtimeState]} label={RUNTIME_LABEL[runtimeState]} variant={variant} />
  );
}
