/**
 * 상태 배지 — runtimeState/status를 시각적 점 + 한국어 라벨 쌍으로 표시.
 * 라벨·톤 매핑은 lib/labels.ts (단일 원본: design-system tokens.md 상태 색 매핑).
 */
import type { AppStatus, RuntimeState } from "../lib/types.js";
import {
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
 */
export function AppStatusBadge({
  status,
  runtimeState,
  variant = "status",
}: {
  status: AppStatus;
  runtimeState: RuntimeState;
  variant?: "status" | "pill";
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
  // ACTIVE → runtimeState
  return (
    <Badge tone={RUNTIME_TONE[runtimeState]} label={RUNTIME_LABEL[runtimeState]} variant={variant} />
  );
}
