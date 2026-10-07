/**
 * 화면 자동 갱신 규칙(QA N6) — 대시보드·앱 상세·배포 상세가 공유한다.
 *
 * - 전이 상태(만드는 중/삭제 중/깨우는 중, 또는 배포 진행 중)가 하나라도 있으면 5초마다,
 *   없으면 30초마다 다시 불러온다. 탭이 숨겨지면 useQuery 가 알아서 멈춘다.
 * - 삭제 접수 직후에는 서버 목록이 아직 바뀌지 않았어도 카드를 "삭제 중"으로 보이게 한다
 *   (낙관적 갱신). 목록이 DELETING 을 돌려주거나 앱이 사라지면 표시를 해제한다.
 */
import type { App, DeploymentStatus } from "./types.js";

export const POLL_FAST_MS = 5_000;
export const POLL_SLOW_MS = 30_000;

const IN_PROGRESS: readonly DeploymentStatus[] = ["PENDING", "VALIDATING", "BUILDING", "DEPLOYING"];

export function isDeploymentInProgress(status: DeploymentStatus | undefined): boolean {
  return status !== undefined && IN_PROGRESS.includes(status);
}

/** 앱 하나가 곧 바뀔 상태(전이 중)인지. */
export function isAppTransitional(app: Pick<App, "status" | "runtimeState">): boolean {
  return app.status === "CREATING" || app.status === "DELETING" || app.runtimeState === "WAKING";
}

/** 전이 중이면 5초, 아니면 30초. */
export function pollInterval(transitional: boolean): number {
  return transitional ? POLL_FAST_MS : POLL_SLOW_MS;
}

// ── 삭제 낙관적 갱신 — 화면 이동(상세 → 대시보드)을 넘어 유지되도록 모듈 수준에 둔다 ──
const pendingDeletes = new Set<string>();

export function markDeleting(appId: string): void {
  pendingDeletes.add(appId);
}

/**
 * 서버 목록에 삭제 접수 표시를 덧씌운다. 서버가 이미 DELETING 을 주거나 목록에서 빠진 앱은
 * 표시를 해제한다(더 이상 덧씌울 필요 없음).
 */
export function applyPendingDeletes(apps: App[]): App[] {
  const present = new Set(apps.map((a) => a.appId));
  for (const id of [...pendingDeletes]) if (!present.has(id)) pendingDeletes.delete(id);
  return apps.map((a) => {
    if (!pendingDeletes.has(a.appId)) return a;
    if (a.status === "DELETING") {
      pendingDeletes.delete(a.appId);
      return a;
    }
    return { ...a, status: "DELETING" };
  });
}

export function resetPendingDeletesForTest(): void {
  pendingDeletes.clear();
}
