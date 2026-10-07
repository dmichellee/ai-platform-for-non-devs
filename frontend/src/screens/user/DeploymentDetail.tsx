/**
 * 배포 상세 — 단계별 진행(가져오기→검사·빌드→배포→확인) + 실패 시 유형별 한국어 안내 + 배포 단계 로그.
 * failureCategory → 안내 문구 매핑은 lib/labels.ts (apphub-conventions §4).
 * 로그(QA M6): 앱 실행 로그가 아니라 이 배포의 검사·빌드·배포 단계 로그
 * (GET /apps/{id}/deployments/{deploymentId}/logs). 실패 안내의 "아래 로그 마지막 부분"이 이 영역이다.
 * 진행 중인 배포면 배포 기록과 로그를 5초마다 다시 불러온다.
 */
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, ChevronDown, Copy, RotateCcw, ScrollText } from "lucide-react";
import {
  BackLink,
  ErrorNotice,
  Modal,
  Skeleton,
  TopBar,
  relTime,
} from "../../components/common.js";
import { useApi, useMutation, useQuery } from "../../lib/ApiProvider.js";
import { POLL_FAST_MS, isDeploymentInProgress } from "../../lib/liveStatus.js";
import { logKey, logText, mergeNewestFirst } from "../../lib/logs.js";
import { useNavigate } from "../../lib/router.js";
import { useAuth } from "../../auth/AuthContext.js";
import { sessionInitial } from "../../auth/tokens.js";
import type { Deployment, DeploymentLogs, LogEvent } from "../../lib/types.js";
import {
  DEPLOYMENT_LOG_EMPTY,
  DEPLOYMENT_LOG_SOURCE_LABEL,
  DEPLOY_STEPS,
  failedStepIndex,
  failureGuidance,
} from "../../lib/labels.js";

export function DeploymentDetail({
  appId,
  deploymentId,
}: {
  appId: string;
  deploymentId: string;
}): JSX.Element {
  const nav = useNavigate();
  const { session, logout } = useAuth();

  // 배포 이력에서 해당 배포를 찾는다(단건 조회 엔드포인트는 계약에 없음 → 목록에서 필터).
  // 진행 중이면 5초마다 다시 불러와 단계 표시를 갱신한다(끝나면 멈춤).
  const { data: deps, loading, error } = useQuery<Deployment[]>(
    (a) => a.listDeployments(appId, 20),
    [appId],
    {
      refetchInterval: (d) =>
        isDeploymentInProgress(d?.find((x) => x.deploymentId === deploymentId)?.status)
          ? POLL_FAST_MS
          : false,
    },
  );
  const dep = deps?.find((d) => d.deploymentId === deploymentId);

  const rollbackMut = useMutation<string, Deployment>((a, id) => a.rollback(appId, id));
  const [confirmRollback, setConfirmRollback] = useState(false);

  const userInitial = sessionInitial(session);
  const failed = dep?.status === "FAILED";
  // 배포 로그 응답의 stage — failureCategory 로 실패 칸을 못 정할 때의 폴백(QA F-L1).
  const [logStage, setLogStage] = useState<DeploymentLogs["stage"]>();
  // 진행 중: 현재 칸 = status 를 reaches 에 포함하는 단계.
  // 실패: 레코드가 도달 단계를 담지 않으므로 failureCategory(→ 로그 stage → 첫 칸)로 실패 칸을 정한다.
  const currentIdx = !dep
    ? -1
    : failed
      ? failedStepIndex(dep.failureCategory, logStage)
      : DEPLOY_STEPS.findIndex((s) => s.reaches.includes(dep.status));

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
                  : i === currentIdx
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

          {/* 배포 단계 로그 — 실패 안내가 가리키는 "아래 로그" */}
          <DeploymentLogPanel
            appId={appId}
            deploymentId={deploymentId}
            status={dep.status}
            failed={failed}
            onStage={setLogStage}
          />
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

// ── 배포 단계 로그 ──
// 출처(source)는 사용자 용어로만 보여준다(검사·빌드 로그 / 배포 로그 / 앱 준비 로그).
// 계약: 최신이 [0] → 화면도 최신이 위. "이전 로그 더 보기"는 nextToken 으로 더 오래된 페이지를 아래에 잇는다.
// 실패 안내가 "로그 마지막 부분을 복사"하라고 하므로 "마지막 부분 복사" 버튼이 최근 기록을
// 시간순(위→아래로 읽히게)으로 복사해 준다.
const DEPLOY_LOG_PAGE = 200;
const COPY_TAIL_LINES = 50;

function DeploymentLogPanel({
  appId,
  deploymentId,
  status,
  failed,
  onStage,
}: {
  appId: string;
  deploymentId: string;
  status: Deployment["status"];
  failed: boolean;
  onStage: (stage: DeploymentLogs["stage"]) => void;
}): JSX.Element {
  const api = useApi();
  const inProgress = isDeploymentInProgress(status);
  // status 를 deps 에 넣어 단계가 바뀌거나 끝나는 순간 한 번 더 받는다(마지막 줄 누락 방지).
  const head = useQuery<DeploymentLogs>(
    (a) => a.getDeploymentLogs(appId, deploymentId, { limit: DEPLOY_LOG_PAGE }),
    [appId, deploymentId, status],
    { refetchInterval: inProgress ? POLL_FAST_MS : false },
  );
  const [older, setOlder] = useState<LogEvent[]>([]);
  const [olderToken, setOlderToken] = useState<string | undefined | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [copied, setCopied] = useState(false);
  const nextToken = olderToken === null ? head.data?.nextToken : olderToken;

  const events = useMemo(() => mergeNewestFirst(head.data?.events ?? [], older), [head.data, older]);
  const stage = head.data?.stage;
  useEffect(() => onStage(stage), [stage, onStage]);
  const sourceLabel = head.data ? DEPLOYMENT_LOG_SOURCE_LABEL[head.data.source] : "배포 단계 로그";

  const loadMore = async (): Promise<void> => {
    if (!nextToken) return;
    setLoadingMore(true);
    try {
      const res = await api.getDeploymentLogs(appId, deploymentId, {
        limit: DEPLOY_LOG_PAGE,
        nextToken,
      });
      setOlder((prev) => [...prev, ...res.events]);
      setOlderToken(res.nextToken);
    } catch {
      /* 다음에 다시 누르면 재시도 */
    } finally {
      setLoadingMore(false);
    }
  };

  const copyTail = async (): Promise<void> => {
    // 최근 N줄을 시간순으로(오래된 줄 → 최신 줄) — Kiro 에 붙여 넣었을 때 자연스럽게 읽히도록.
    const text = events
      .slice(0, COPY_TAIL_LINES)
      .reverse()
      .map(logText)
      .join("\n");
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-head-row">
        <h4 style={{ margin: 0 }}>
          <ScrollText size={16} className="icon" />
          {sourceLabel}
        </h4>
        {events.length > 0 && (
          <button type="button" className="btn btn-ghost" onClick={() => void copyTail()}>
            <Copy size={15} className="icon" />
            {copied ? "복사했어요" : "마지막 부분 복사"}
          </button>
        )}
      </div>
      <p className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
        가장 최근 기록이 맨 위에 있어요.
        {failed && " '마지막 부분 복사'를 누르면 최근 기록을 복사해요."}
        {inProgress && " 배포가 진행 중이라 5초마다 새 기록을 불러와요."}
      </p>
      {head.loading && !head.data ? (
        <Skeleton height={160} />
      ) : head.error && !head.data ? (
        <ErrorNotice error={head.error} />
      ) : events.length === 0 ? (
        <p className="muted" role="status">
          {DEPLOYMENT_LOG_EMPTY}
        </p>
      ) : (
        <>
          <div className="log-viewer" role="log" aria-label={sourceLabel}>
            {events.map((e) => (
              <div key={logKey(e)} className="log-line">
                <span className="ts">{new Date(e.timestamp).toLocaleTimeString("ko-KR")}</span>
                {logText(e)}
              </div>
            ))}
          </div>
          {nextToken && (
            <button
              type="button"
              className="btn btn-ghost mt3"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              <ChevronDown size={15} className="icon" />
              {loadingMore ? "불러오는 중…" : "이전 로그 더 보기"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
