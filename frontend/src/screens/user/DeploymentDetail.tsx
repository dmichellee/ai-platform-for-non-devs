/**
 * 배포 상세 — 단계별 진행(가져오기→검사·빌드→배포→확인) + 실패 시 유형별 한국어 안내 + 로그.
 * failureCategory → 안내 문구 매핑은 lib/labels.ts (apphub-conventions §4).
 */
import { useEffect, useState } from "react";
import { AlertTriangle, Check, RotateCcw } from "lucide-react";
import {
  BackLink,
  ErrorNotice,
  Modal,
  Skeleton,
  TopBar,
  relTime,
} from "../../components/common.js";
import { useApi, useMutation, useQuery } from "../../lib/ApiProvider.js";
import { useNavigate } from "../../lib/router.js";
import { useAuth } from "../../auth/AuthContext.js";
import { sessionInitial } from "../../auth/tokens.js";
import type { Deployment, LogEvent } from "../../lib/types.js";
import { DEPLOY_STEPS, failureGuidance } from "../../lib/labels.js";

export function DeploymentDetail({
  appId,
  deploymentId,
}: {
  appId: string;
  deploymentId: string;
}): JSX.Element {
  const nav = useNavigate();
  const api = useApi();
  const { session, logout } = useAuth();
  const [logs, setLogs] = useState<LogEvent[]>([]);

  // 배포 이력에서 해당 배포를 찾는다(단건 조회 엔드포인트는 계약에 없음 → 목록에서 필터).
  const { data: deps, loading, error } = useQuery<Deployment[]>(
    (a) => a.listDeployments(appId, 20),
    [appId],
  );
  const dep = deps?.find((d) => d.deploymentId === deploymentId);

  const rollbackMut = useMutation<string, Deployment>((a, id) => a.rollback(appId, id));
  const [confirmRollback, setConfirmRollback] = useState(false);

  useEffect(() => {
    if (dep?.status !== "FAILED") return;
    void api
      .getLogs(appId, { limit: 100 })
      .then((r) => setLogs(r.events))
      .catch(() => undefined);
  }, [api, appId, dep?.status]);

  const userInitial = sessionInitial(session);
  const failed = dep?.status === "FAILED";
  // 현재 칸 = status 를 reaches 에 포함하는 단계. FAILED 는 어느 칸에도 없어 -1 → 아래에서
  // 첫 칸을 실패로 표시한다(실패 레코드는 도달 단계를 따로 담지 않음).
  const currentIdx = dep ? DEPLOY_STEPS.findIndex((s) => s.reaches.includes(dep.status)) : -1;

  return (
    <div className="wrap">
      <TopBar userInitial={userInitial} onLogout={logout} />
      <BackLink label="앱 상세로" onClick={() => nav(`/apps/${appId}`)} />

      {loading && <Skeleton height={80} count={2} />}
      {error && <ErrorNotice error={error} />}
      {!loading && !error && !dep && (
        <div className="panel">
          <p className="muted">해당 배포 기록을 찾을 수 없어요.</p>
        </div>
      )}

      {dep && (
        <>
          <div className="page-head">
            <div>
              <h2>배포 진행 상황</h2>
              <div className="desc">
                {dep.commitMessage ?? "배포"} · {relTime(dep.createdAt)}
                {dep.commitSha && <span className="mono muted"> · {dep.commitSha}</span>}
              </div>
            </div>
            {dep.trigger !== "rollback" && dep.status === "SUCCEEDED" && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setConfirmRollback(true)}
              >
                <RotateCcw size={15} className="icon" />이 버전으로 되돌리기
              </button>
            )}
          </div>

          {/* 단계 진행 */}
          <div className="deploy-steps" aria-label="배포 단계">
            {DEPLOY_STEPS.map((s, i) => {
              const state = failed
                ? i < currentIdx
                  ? "done"
                  : i === Math.max(currentIdx, 0)
                    ? "failed"
                    : ""
                : i < currentIdx
                  ? "done"
                  : i === currentIdx
                    ? "current"
                    : "";
              return (
                <span key={s.key} className={`dstep ${state}`}>
                  {state === "done" && <Check size={14} className="icon" />}
                  {state === "failed" && <AlertTriangle size={14} className="icon" />}
                  {s.label}
                </span>
              );
            })}
          </div>

          {/* 실패 안내 */}
          {failed && (
            <div className="notice error" role="alert">
              <AlertTriangle size={18} className="icon" />
              <div>{failureGuidance(dep.failureCategory)}</div>
            </div>
          )}

          {dep.note && !failed && (
            <div className="notice info">
              <Check size={18} className="icon" />
              <div>{dep.note}</div>
            </div>
          )}

          {/* 실패 시 로그 */}
          {failed && (
            <div className="panel">
              <h4>배포 로그 (마지막 부분)</h4>
              {logs.length === 0 ? (
                <p className="muted">로그를 불러오는 중이거나 표시할 로그가 없어요.</p>
              ) : (
                <div className="log-viewer" role="log">
                  {logs.map((e, i) => (
                    <div key={i} className="log-line">
                      <span className="ts">{new Date(e.timestamp).toLocaleTimeString("ko-KR")}</span>
                      {e.message}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {confirmRollback && dep && (
        <Modal title="이 버전으로 되돌릴까요?" onClose={() => setConfirmRollback(false)}>
          <p>
            이 배포 시점의 코드로 앱을 다시 배포해요. 다시 빌드하지 않아 빠르게 적용돼요.
          </p>
          {rollbackMut.error && <ErrorNotice error={rollbackMut.error} />}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmRollback(false)}>
              취소
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={rollbackMut.loading}
              onClick={async () => {
                try {
                  await rollbackMut.run(dep.deploymentId);
                  setConfirmRollback(false);
                  nav(`/apps/${appId}`);
                } catch {
                  /* 에러 표시 */
                }
              }}
            >
              {rollbackMut.loading ? "접수 중…" : "되돌리기"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
