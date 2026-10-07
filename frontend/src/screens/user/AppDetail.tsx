/**
 * 앱 상세 — 4개 탭으로 재편:
 *   개요       : 상태(runtimeState 포함)·접속 URL·앱 정보 요약·실패 사유(FailureNotice)
 *   배포 이력  : 성공/실패 모든 배포 리스트(→ 배포 상세) + "실행 로그 보기" 접이식 섹션
 *   모니터링   : 접속량/CPU 사용률/메모리 사용률 시계열 차트(range 선택)
 *   설정       : 환경변수·가동 방식·자동배포
 * WAKING 상태면 "깨우는 중" 대기 안내를 상단에 보여준다.
 * 탭은 ?tab= 쿼리로 딥링크 가능(관리자 화면과 동일한 방식).
 */
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cpu,
  ExternalLink,
  History,
  Info,
  KeyRound,
  MemoryStick,
  Play,
  RefreshCw,
  Rocket,
  ScrollText,
  Settings,
  Trash2,
} from "lucide-react";
import { AppStatusBadge, Badge } from "../../components/StatusBadge.js";
import {
  BackLink,
  ErrorNotice,
  InfoNotice,
  Modal,
  Skeleton,
  Toggle,
  TopBar,
  relTime,
} from "../../components/common.js";
import { Sparkline } from "../../components/Sparkline.js";
import { useApi, useMutation, useQuery } from "../../lib/ApiProvider.js";
import {
  DEFAULT_SCHEDULE,
  ScheduleEditor,
  isScheduleValid,
} from "../../components/ScheduleEditor.js";
import { navigate, useNavigate, useRoute } from "../../lib/router.js";
import { useAuth } from "../../auth/AuthContext.js";
import { appsDomainLabel, frontendMode } from "../../lib/config.js";
import { sessionInitial } from "../../auth/tokens.js";
import type {
  App,
  AppMetrics,
  Deployment,
  LogEvent,
  MetricPoint,
  MetricRange,
  PatchAppRequest,
  PatchAppResponse,
  RedeployResult,
  RestartResult,
  Schedule,
  SleepMode,
} from "../../lib/types.js";
import {
  DEPLOY_STATUS_LABEL,
  DEPLOY_TRIGGER_LABEL,
  FIRST_DEPLOY_ACTION_DISABLED_HINT,
  FIRST_DEPLOY_PENDING_HINT,
  METRIC_RANGE_LABEL,
  METRIC_RANGE_ORDER,
  PROTECT_DESC_TEXT,
  PROTECT_DETAIL_TEXT,
  PROTECT_UNAVAILABLE_TEXT,
  REDEPLOY_PENDING_MESSAGE,
  REDEPLOY_SKIPPED_MESSAGE,
  SCHEME_LABEL,
  SLEEP_MODE_DESC,
  SLEEP_MODE_LABEL,
  statusHint,
} from "../../lib/labels.js";

type Tab = "overview" | "deployments" | "monitoring" | "settings";

const TAB_ORDER: Tab[] = ["overview", "deployments", "monitoring", "settings"];
const TAB_META: Record<Tab, { label: string; icon: JSX.Element }> = {
  overview: { label: "개요", icon: <Info size={15} className="icon" /> },
  deployments: { label: "배포 이력", icon: <History size={15} className="icon" /> },
  monitoring: { label: "모니터링", icon: <Activity size={15} className="icon" /> },
  settings: { label: "설정", icon: <Settings size={15} className="icon" /> },
};

function isTab(v: string | null): v is Tab {
  return v !== null && (TAB_ORDER as string[]).includes(v);
}

export function AppDetail({ appId }: { appId: string }): JSX.Element {
  const nav = useNavigate();
  const route = useRoute();
  const { session, logout } = useAuth();
  // 딥링크: ?tab= 값이 유효하면 그 탭에서 시작. 없으면 개요.
  const routeTab = route.query.get("tab");
  const tab: Tab = isTab(routeTab) ? routeTab : "overview";
  // 탭 전환 = 같은 경로에 ?tab= 쿼리만 바꿔 이동(뒤로가기로 탭 이동 취소 가능, 새로고침에도 유지).
  const setTab = (t: Tab): void => navigate(`/apps/${appId}${t === "overview" ? "" : `?tab=${t}`}`);

  const { data: app, loading, error, reload } = useQuery<App>((a) => a.getApp(appId), [appId]);

  // "첫 배포 완료(everDeployed)" 판정 — App 응답에는 이 정보가 없어 배포 목록으로 판정한다.
  // status=ACTIVE 로 전이했더라도 첫 배포(앱 빌드·기동)가 끝나기 전이면 runtimeState 는 아직
  // 기본값(SLEEPING)이라 "잠자는 중"으로 오해되고, "지금 배포/재시작/열기"도 눌러선 안 된다.
  // 이 조회는 상세 상단에서만 한다(카드 목록 등 다른 화면은 배포 목록을 모르므로 이 판정을 하지 않음).
  const { data: deployments, reload: reloadDeployments } = useQuery<Deployment[]>(
    (a) => a.listDeployments(appId),
    [appId],
  );
  // null = 아직 판정 보류(로딩/실패). true/false = 확정.
  const everDeployed: boolean | null = deployments
    ? deployments.some((d) => d.status === "SUCCEEDED")
    : null;
  // 배지·안내용: ACTIVE 인데 "첫 배포 성공 없음"이 확정된 경우만 "준비 중"으로 표시(로딩 중엔 덮지 않음).
  const firstDeployPending = app?.status === "ACTIVE" && everDeployed === false;
  // 액션·"열기"용: 첫 배포 성공이 확정되기 전(로딩 포함)엔 안전하게 비활성/미노출.
  const firstDeployConfirmed = app?.status === "ACTIVE" && everDeployed === true;

  const userInitial = sessionInitial(session);

  return (
    <div className="wrap">
      <TopBar userInitial={userInitial} onLogout={logout} />
      <BackLink label="내 앱으로" onClick={() => nav("/")} />

      {loading && <Skeleton height={90} count={3} />}
      {error && <ErrorNotice error={error} />}

      {app && (
        <>
          <div className="page-head">
            <div>
              <h2>
                {app.name}
                <AppStatusBadge
                  status={app.status}
                  runtimeState={app.runtimeState}
                  pendingFirstDeploy={firstDeployPending}
                />
              </h2>
              <div className="row mt3" style={{ gap: 8 }}>
                <span className="mono muted">{app.subdomain}.{appsDomainLabel()}</span>
                {/* "열기"는 첫 배포가 성공한 뒤에만 — 아직 뜬 앱이 없으면 열어도 실패한다. */}
                {firstDeployConfirmed && (
                  <a
                    className="topbar-link"
                    href={`https://${app.subdomain}.${appsDomainLabel()}`}
                    target="_blank"
                    rel="noreferrer"
                    title="새 탭에서 앱 열기"
                  >
                    <span className="row" style={{ gap: 5 }}>
                      <ExternalLink size={14} className="icon" />
                      열기
                    </span>
                  </a>
                )}
              </div>
            </div>
            <AppActions app={app} firstDeployPending={!firstDeployConfirmed && app.status === "ACTIVE"} onChanged={reload} />
          </div>

          {app.status === "FAILED" && app.failureReason ? (
            <FailureNotice reason={app.failureReason} />
          ) : (
            app.status !== "ACTIVE" &&
            statusHint(app.status) && <InfoNotice>{statusHint(app.status)}</InfoNotice>
          )}
          {firstDeployPending && <InfoNotice>{FIRST_DEPLOY_PENDING_HINT}</InfoNotice>}
          {app.status === "ACTIVE" && app.runtimeState === "WAKING" && (
            <InfoNotice>
              앱을 깨우는 중이에요. 잠시만 기다려주세요 (보통 30초~1분). 준비되면 자동으로 열려요.
            </InfoNotice>
          )}

          <div className="tabs" role="tablist">
            {TAB_ORDER.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                className={`tab ${tab === t ? "active" : ""}`}
                onClick={() => setTab(t)}
              >
                <span className="row" style={{ gap: 6 }}>
                  {TAB_META[t].icon}
                  {TAB_META[t].label}
                </span>
              </button>
            ))}
          </div>

          {tab === "overview" && <OverviewTab app={app} firstDeployPending={firstDeployPending} />}
          {tab === "deployments" && <DeploymentsTab appId={appId} />}
          {tab === "monitoring" && <MonitoringTab app={app} />}
          {tab === "settings" && (
            <SettingsTab
              app={app}
              onSaved={() => {
                // 저장 후 앱 상태 + 배포 목록을 다시 불러온다(시크릿 변경 재배포 시 배지/이력 갱신).
                reload();
                reloadDeployments();
              }}
              onOpenDeployments={() => setTab("deployments")}
            />
          )}
        </>
      )}
    </div>
  );
}

// ── 실패 사유 안내 (status=FAILED + failureReason) ──
// 배포 이력에 잡히기 전 단계(자리 배정/빌드 환경 구성/첫 배포) 실패도 여기서 원인을 본다.
// 실패한 앱은 되살릴 수 없으므로(상태 기계상 FAILED→DELETING만) 삭제 후 다시 만들도록 안내한다.
function FailureNotice({ reason }: { reason: string }): JSX.Element {
  return (
    <div className="notice error" role="alert">
      <AlertTriangle size={18} className="icon" />
      <div>
        <div>{reason}</div>
        <div className="muted mt3" style={{ fontSize: 13 }}>
          이 앱은 되살릴 수 없어요. 위 '삭제' 버튼으로 정리한 뒤 다시 만들어주세요.
        </div>
      </div>
    </div>
  );
}

// ── 상단 액션 (지금 배포 / 재시작 / 삭제) ──
// "지금 배포"와 "재시작"은 전혀 다른 동작이라 각각 독립 mutation 으로 다룬다:
//  - 지금 배포: 최신 코드로 다시 빌드해서 배포(몇 분). deploy(appId).
//  - 재시작:    지금 버전 그대로 앱만 다시 켜기(약 1분). restartApp(appId).
// 한쪽이 진행 중이어도 다른 쪽 버튼을 잘못 눌러 엉뚱한 동작이 돌지 않도록 각자 disabled/로딩을 가진다.
function AppActions({
  app,
  firstDeployPending,
  onChanged,
}: {
  app: App;
  // status=ACTIVE 이지만 첫 배포 성공이 아직 확정되지 않음(로딩 포함). true 면 "지금 배포/재시작" 비활성.
  firstDeployPending: boolean;
  onChanged: () => void;
}): JSX.Element {
  const nav = useNavigate();
  const deployMut = useMutation<void, Deployment>((a) => a.deploy(app.appId));
  const restartMut = useMutation<void, RestartResult>((a) => a.restartApp(app.appId));
  const deleteMut = useMutation<void, unknown>((a) => a.deleteApp(app.appId));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteText, setDeleteText] = useState("");
  // 재시작 접수 성공 시 서버가 준 안내(note)를 그대로 보여준다.
  const [restartNote, setRestartNote] = useState<string | null>(null);

  // ACTIVE 가 아니거나(만드는 중/실패/삭제 중) 첫 배포가 아직 끝나지 않았으면 배포/재시작 불가.
  const busy = app.status !== "ACTIVE" || firstDeployPending;
  // 두 액션 중 하나라도 진행 중이면 서로 간섭하지 않도록 버튼 전체를 비활성.
  const actionBusy = deployMut.loading || restartMut.loading;
  // 첫 배포 미완료로 막혔을 때만 툴팁 사유를 바꿔 준다.
  const deployTitle = firstDeployPending && app.status === "ACTIVE"
    ? FIRST_DEPLOY_ACTION_DISABLED_HINT
    : "최신 코드로 다시 빌드해서 배포해요 (몇 분 걸려요)";
  const restartTitle = firstDeployPending && app.status === "ACTIVE"
    ? FIRST_DEPLOY_ACTION_DISABLED_HINT
    : "지금 버전 그대로 앱만 다시 켜요 (약 1분)";

  // 배포/재시작 접수 실패는 조용히 삼키지 않고 사용자에게 원인을 보여준다(방침 ② — 에러 노출).
  const runDeploy = async (): Promise<void> => {
    try {
      await deployMut.run();
    } catch {
      /* deployMut.error 로 표시 */
    }
    onChanged();
  };

  // 재시작: 성공하면 note 를 알림으로 보여주고 최신 상태를 다시 불러온다.
  const runRestart = async (): Promise<void> => {
    setRestartNote(null);
    try {
      const res = await restartMut.run();
      setRestartNote(res.note);
    } catch {
      /* restartMut.error 로 표시 */
    }
    onChanged();
  };

  return (
    <div className="stack" style={{ alignItems: "flex-end" }}>
      <div className="row">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy || actionBusy}
          onClick={runDeploy}
          title={deployTitle}
        >
          <Rocket size={15} className="icon" />
          {deployMut.loading ? "배포 접수 중…" : "지금 배포"}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy || actionBusy}
          onClick={runRestart}
          title={restartTitle}
        >
          <RefreshCw size={15} className="icon" />
          {restartMut.loading ? "재시작 중…" : "재시작"}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={app.status === "CREATING" || app.status === "DELETING"}
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 size={15} className="icon" />
          삭제
        </button>
      </div>
      {deployMut.error && <ErrorNotice error={deployMut.error} />}
      {restartMut.error && <ErrorNotice error={restartMut.error} />}
      {restartNote && !restartMut.error && <InfoNotice>{restartNote}</InfoNotice>}

      {confirmDelete && (
        <Modal title="앱을 삭제할까요?" onClose={() => setConfirmDelete(false)}>
          <p>
            이 작업은 되돌릴 수 없어요. 앱과 배포 기록이 모두 사라져요. 확인을 위해 앱 이름{" "}
            <b>{app.name}</b>을(를) 입력해주세요.
          </p>
          <input
            className="input"
            value={deleteText}
            onChange={(e) => setDeleteText(e.target.value)}
            placeholder={app.name}
            aria-label="삭제 확인 이름"
          />
          {deleteMut.error && (
            <div className="mt3">
              <ErrorNotice error={deleteMut.error} />
            </div>
          )}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>
              취소
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={deleteText !== app.name || deleteMut.loading}
              onClick={async () => {
                try {
                  await deleteMut.run();
                  setConfirmDelete(false);
                  nav("/");
                } catch {
                  /* 에러 표시 */
                }
              }}
            >
              {deleteMut.loading ? "삭제 접수 중…" : "삭제할게요"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── 개요 — 상태·접속·앱 정보 요약 ──
// firstDeployPending: 상단과 동일한 "첫 배포 미완료" 판정. 상태 pill 과 접속 주소 링크를 상단과 일치시킨다.
function OverviewTab({ app, firstDeployPending }: { app: App; firstDeployPending: boolean }): JSX.Element {
  const url = `https://${app.subdomain}.${appsDomainLabel()}`;
  // 첫 배포가 끝나 실제 앱이 뜬 경우에만 접속 주소를 링크로(그 전엔 열어도 실패).
  const linkable = app.status === "ACTIVE" && !firstDeployPending;
  return (
    <div className="panel">
      <h4>앱 정보</h4>
      <div className="kv">
        <span className="k">상태</span>
        <span className="v">
          <AppStatusBadge
            status={app.status}
            runtimeState={app.runtimeState}
            variant="pill"
            pendingFirstDeploy={firstDeployPending}
          />
        </span>
      </div>
      <div className="kv">
        <span className="k">접속 주소</span>
        <span className="v">
          {linkable ? (
            <a href={url} target="_blank" rel="noreferrer" className="row" style={{ gap: 5, justifyContent: "flex-end" }}>
              <span className="mono" style={{ fontWeight: 500 }}>{app.subdomain}.{appsDomainLabel()}</span>
              <ExternalLink size={14} className="icon" />
            </a>
          ) : (
            <span className="mono" style={{ fontWeight: 500 }}>{app.subdomain}.{appsDomainLabel()}</span>
          )}
        </span>
      </div>
      <div className="kv">
        <span className="k">저장소</span>
        <span className="v mono">{app.repoUrl}</span>
      </div>
      <div className="kv">
        <span className="k">브랜치</span>
        <span className="v mono">{app.branch}</span>
      </div>
      <div className="kv">
        <span className="k">크기</span>
        <span className="v">{presetSizeLabel(app.presetId)}</span>
      </div>
      <div className="kv">
        <span className="k">공개 범위</span>
        <span className="v">{SCHEME_LABEL[app.scheme]}</span>
      </div>
      <div className="kv">
        <span className="k">가동 방식</span>
        <span className="v">{SLEEP_MODE_LABEL[app.sleepMode]}</span>
      </div>
      {app.cognitoProtect && (
        <div className="kv">
          <span className="k">로그인 보호</span>
          <span className="v">로그인한 사람만 접속</span>
        </div>
      )}
      <div className="kv">
        <span className="k">자동 배포</span>
        <span className="v">{app.autoDeployEnabled ? "켜짐 (코드 올리면 자동 배포)" : "꺼짐"}</span>
      </div>
      <div className="kv">
        <span className="k">만든 날</span>
        <span className="v">{relTime(app.createdAt)}</span>
      </div>
    </div>
  );
}

// 프리셋 id → 사용자 크기 라벨(작게/보통/크게). id 접두 규칙에 의존하지 않고 알 수 없으면 그대로 노출 안 함.
function presetSizeLabel(presetId: string): string {
  if (presetId.includes("small")) return "작게";
  if (presetId.includes("medium")) return "보통";
  if (presetId.includes("large")) return "크게";
  return "관리자 지정 크기";
}

// ── 배포 이력 — 성공/실패 모든 배포 + 실행 로그 접이식 ──
function DeploymentsTab({ appId }: { appId: string }): JSX.Element {
  const nav = useNavigate();
  const { data: deps, loading } = useQuery<Deployment[]>(
    (a) => a.listDeployments(appId),
    [appId],
  );

  return (
    <>
      <div className="panel">
        <h4>
          <History size={16} className="icon" />
          배포 이력
        </h4>
        <p className="muted" style={{ marginTop: -4, marginBottom: 12, fontSize: 13 }}>
          성공한 배포와 실패한 배포를 모두 최신순으로 보여줘요. 항목을 누르면 진행 단계와 로그를 볼 수 있어요.
        </p>
        {loading && <Skeleton height={40} count={3} />}
        {!loading && (!deps || deps.length === 0) && (
          <p className="muted">아직 배포 기록이 없어요. '지금 배포'로 첫 배포를 시작할 수 있어요.</p>
        )}
        {deps?.map((d) => (
          <button
            key={d.deploymentId}
            type="button"
            className="deploy-row"
            style={{ width: "100%", background: "transparent", border: 0, textAlign: "left" }}
            onClick={() => nav(`/apps/${appId}/deployments/${encodeURIComponent(d.deploymentId)}`)}
          >
            <DeployBadge status={d.status} />
            <div>
              <div className="msg">{d.commitMessage ?? "배포"}</div>
              <div className="sha">
                {DEPLOY_TRIGGER_LABEL[d.trigger]}
                {d.commitSha ? ` · ${d.commitSha}` : ""}
              </div>
            </div>
            <span className="when">{relTime(d.createdAt)}</span>
            <ChevronRight size={16} className="icon" style={{ opacity: 0.5 }} />
          </button>
        ))}
      </div>

      {/* 컨테이너 실시간 로그(디버깅 맥락) — 배포 이력 탭 하단에 접이식으로 유지 */}
      <RuntimeLogsSection appId={appId} />
    </>
  );
}


function DeployBadge({ status }: { status: Deployment["status"] }): JSX.Element {
  if (status === "SUCCEEDED") return <Badge tone="running" label="완료" variant="pill" />;
  if (status === "FAILED") return <Badge tone="fail" label="실패" variant="pill" />;
  return <Badge tone="waking" label={DEPLOY_STATUS_LABEL[status]} variant="pill" />;
}

// ── 실행 로그 접이식 섹션 (기존 로그 탭 내용 — 디버깅 맥락으로 이동) ──
function RuntimeLogsSection({ appId }: { appId: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="panel">
      <button
        type="button"
        className="collapse-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown size={16} className="icon" /> : <ChevronRight size={16} className="icon" />}
        <ScrollText size={16} className="icon" />
        실행 로그 보기
        <span className="muted" style={{ fontWeight: 400, fontSize: 13, marginLeft: 6 }}>
          앱이 실행되며 남기는 기록이에요. 문제 원인을 찾을 때 확인하세요.
        </span>
      </button>
      {open && (
        <div style={{ marginTop: 12 }}>
          <RuntimeLogViewer appId={appId} />
        </div>
      )}
    </div>
  );
}

// 로그 뷰어 (자동 새로고침) — getLogs 재사용. 열렸을 때만 폴링한다.
function RuntimeLogViewer({ appId }: { appId: string }): JSX.Element {
  const api = useApi();
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [auto, setAuto] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stop = false;
    const load = async (): Promise<void> => {
      try {
        const res = await api.getLogs(appId, { limit: 100 });
        if (!stop) setEvents(res.events);
      } catch {
        /* 로그 실패는 조용히 — 상단 앱 상태가 이미 안내 */
      } finally {
        if (!stop) setLoading(false);
      }
    };
    void load();
    const timer = auto ? window.setInterval(load, 5000) : undefined;
    return () => {
      stop = true;
      if (timer) window.clearInterval(timer);
    };
  }, [api, appId, auto]);

  useEffect(() => {
    if (auto && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [events, auto]);

  return (
    <>
      <div className="row" style={{ justifyContent: "flex-end", marginBottom: 10 }}>
        <label className="row" style={{ gap: 8, fontSize: 13 }}>
          <Toggle on={auto} onChange={setAuto} label="자동 새로고침" />
          자동 새로고침 (5초)
        </label>
      </div>
      {loading ? (
        <Skeleton height={200} />
      ) : events.length === 0 ? (
        <p className="muted">표시할 로그가 아직 없어요.</p>
      ) : (
        <div className="log-viewer" ref={boxRef} role="log" aria-live="polite">
          {events.map((e, i) => (
            <div key={i} className="log-line">
              <span className="ts">{new Date(e.timestamp).toLocaleTimeString("ko-KR")}</span>
              {e.message}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ── 모니터링 — 접속량 / CPU 사용률 / 메모리 사용률 시계열 차트 ──
function MonitoringTab({ app }: { app: App }): JSX.Element {
  const [range, setRange] = useState<MetricRange>("1h");
  const { data, loading, error } = useQuery<AppMetrics>(
    (a) => a.getMetrics(app.appId, range),
    [app.appId, range],
  );

  const empty =
    !!data &&
    data.series.requests.length === 0 &&
    data.series.cpu.length === 0 &&
    data.series.memory.length === 0;

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
        <h4 style={{ margin: 0 }}>
          <BarChart3 size={16} className="icon" />
          모니터링
        </h4>
        <div className="segmented" role="group" aria-label="조회 기간">
          {METRIC_RANGE_ORDER.map((r) => (
            <button
              key={r}
              type="button"
              className={`seg ${range === r ? "on" : ""}`}
              aria-pressed={range === r}
              onClick={() => setRange(r)}
            >
              {METRIC_RANGE_LABEL[r]}
            </button>
          ))}
        </div>
      </div>

      {loading && <Skeleton height={120} count={3} />}
      {error && <ErrorNotice error={error} />}

      {data && empty && (
        <div className="notice info" role="status">
          <Info size={18} className="icon" />
          <div>
            잠자는 중이거나 아직 데이터가 없어요. 앱을 사용하면 접속량과 사용률이 여기에 나타나요.
          </div>
        </div>
      )}

      {data && !empty && (
        <div className="metric-grid">
          <MetricCard
            title="접속량"
            unit="요청 수"
            icon={<Activity size={16} className="icon" />}
            points={data.series.requests}
            formatValue={(v) => `${v.toLocaleString("ko-KR")}회`}
          />
          <MetricCard
            title="CPU 사용률"
            unit="%"
            icon={<Cpu size={16} className="icon" />}
            points={data.series.cpu}
            max={100}
            formatValue={(v) => `${v}%`}
          />
          <MetricCard
            title="메모리 사용률"
            unit="%"
            icon={<MemoryStick size={16} className="icon" />}
            points={data.series.memory}
            max={100}
            formatValue={(v) => `${v}%`}
          />
        </div>
      )}
    </div>
  );
}

function MetricCard({
  title,
  unit,
  icon,
  points,
  max,
  formatValue,
}: {
  title: string;
  unit: string;
  icon: JSX.Element;
  points: MetricPoint[];
  max?: number;
  formatValue: (v: number) => string;
}): JSX.Element {
  const latest = points.length ? points[points.length - 1]!.v : 0;
  const peak = points.length ? Math.max(...points.map((p) => p.v)) : 0;
  return (
    <div className="metric-card">
      <div className="metric-head">
        <span className="metric-title">
          {icon}
          {title}
        </span>
        <span className="metric-latest">{formatValue(latest)}</span>
      </div>
      <Sparkline points={points} {...(max !== undefined ? { max } : {})} formatValue={formatValue} ariaLabel={title} />
      <div className="metric-foot muted">
        <span>단위: {unit}</span>
        <span>최고 {formatValue(peak)}</span>
      </div>
    </div>
  );
}

// ── 설정 탭 (환경변수·비밀값·가동 방식·자동배포 저장) ──
function SettingsTab({
  app,
  onSaved,
  onOpenDeployments,
}: {
  app: App;
  onSaved: () => void;
  onOpenDeployments: () => void;
}): JSX.Element {
  const [autoDeploy, setAutoDeploy] = useState(app.autoDeployEnabled);
  const [sleepMode, setSleepMode] = useState<SleepMode>(app.sleepMode);
  // 기존 시간표가 있으면 그대로, 없으면 기본(평일 09:00–19:00)으로 편집 시작.
  const [schedule, setSchedule] = useState<Schedule>(app.schedule ?? DEFAULT_SCHEDULE);
  const [protect, setProtect] = useState(app.cognitoProtect);
  // D16: 사내 전용 설치(private)에서는 로그인 보호를 켤 수 없다. 이미 켜져 있던 앱은 끄는 것만 허용.
  const protectUnavailable = frontendMode() === "private" && !app.cognitoProtect;
  const [envRows, setEnvRows] = useState(
    Object.entries(app.envVars).map(([key, value]) => ({ key, value })),
  );
  // ④ 비밀값 관리 — 값은 응답에 없으므로(secretKeys 는 KEY 목록뿐) 아래 규칙으로 편집한다:
  //  - secretState[key] = { removed, newValue } — removed=삭제 표시, newValue!==null 이면 새 값으로 교체.
  //  - newSecrets = 새로 추가하는 비밀값 rows.
  const existingSecretKeys = app.secretKeys;
  const [secretState, setSecretState] = useState<Record<string, { removed: boolean; newValue: string | null }>>({});
  const [newSecrets, setNewSecrets] = useState<{ key: string; value: string }[]>([]);
  const saveMut = useMutation<PatchAppRequest, PatchAppResponse>((a, body) => a.patchApp(app.appId, body));
  // 서버가 로그인 보호를 거부하면(400 COGNITO_PROTECT_UNAVAILABLE) 토글 바로 아래에 서버 message 를 보여준다.
  const protectError = saveMut.error?.code === "COGNITO_PROTECT_UNAVAILABLE" ? saveMut.error : null;
  // D8: 비밀값 변경 저장 = 즉시 재배포. 저장 전 확인 모달 + 저장 후 재배포 결과 안내.
  const [confirmRedeploy, setConfirmRedeploy] = useState(false);
  const [redeploy, setRedeploy] = useState<RedeployResult | null>(null);

  const secretsBody = useMemo(() => {
    const secrets: Record<string, string> = {};
    const secretsRemove: string[] = [];
    // 기존 키: 삭제 표시 → remove, 새 값 입력 → 교체.
    for (const key of existingSecretKeys) {
      const st = secretState[key];
      if (st?.removed) secretsRemove.push(key);
      else if (st && st.newValue !== null) secrets[key] = st.newValue;
    }
    // 새 비밀값: key/value 모두 채운 것만.
    for (const r of newSecrets) if (r.key && r.value) secrets[r.key] = r.value;
    return { secrets, secretsRemove };
  }, [existingSecretKeys, secretState, newSecrets]);

  const secretsChanged =
    Object.keys(secretsBody.secrets).length > 0 || secretsBody.secretsRemove.length > 0;

  const dirty = useMemo(() => {
    const envChanged =
      JSON.stringify(Object.fromEntries(envRows.filter((r) => r.key).map((r) => [r.key, r.value]))) !==
      JSON.stringify(app.envVars);
    const scheduleChanged =
      sleepMode === "schedule" && JSON.stringify(schedule) !== JSON.stringify(app.schedule);
    return (
      autoDeploy !== app.autoDeployEnabled ||
      sleepMode !== app.sleepMode ||
      protect !== app.cognitoProtect ||
      scheduleChanged ||
      envChanged ||
      secretsChanged
    );
  }, [autoDeploy, sleepMode, schedule, protect, envRows, secretsChanged, app]);

  // "시간표대로"인데 시간표가 유효하지 않으면 저장 불가(요일 1개↑, 시각 형식).
  const scheduleBlocked = sleepMode === "schedule" && !isScheduleValid(schedule);

  // 저장 버튼: 비밀값 변경이 있으면 먼저 확인(취소 시 요청을 보내지 않는다). 없으면 바로 저장.
  function requestSave(): void {
    if (secretsChanged) setConfirmRedeploy(true);
    else void save();
  }

  async function save(): Promise<void> {
    setConfirmRedeploy(false);
    setRedeploy(null);
    const envVars: Record<string, string> = {};
    for (const r of envRows) if (r.key) envVars[r.key] = r.value;
    await saveMut
      .run({
        autoDeployEnabled: autoDeploy,
        sleepMode,
        cognitoProtect: protect,
        envVars,
        // 계약: sleepMode="schedule"이면 schedule 필수. 그 외 모드에서는 보내지 않는다.
        ...(sleepMode === "schedule" ? { schedule } : {}),
        // ④ 비밀값: 신규/교체는 secrets, 삭제는 secretsRemove. 비어 있으면 키 자체를 보내지 않는다.
        ...(Object.keys(secretsBody.secrets).length > 0 ? { secrets: secretsBody.secrets } : {}),
        ...(secretsBody.secretsRemove.length > 0 ? { secretsRemove: secretsBody.secretsRemove } : {}),
      })
      .then((res) => {
        // 저장 성공 후 로컬 비밀값 편집 상태 초기화(응답 App 의 secretKeys 로 다시 그려진다).
        setRedeploy(res.redeploy ?? null);
        setSecretState({});
        setNewSecrets([]);
        onSaved();
      })
      .catch(() => undefined);
  }

  const setKeyState = (key: string, p: Partial<{ removed: boolean; newValue: string | null }>): void =>
    setSecretState((s) => ({ ...s, [key]: { removed: s[key]?.removed ?? false, newValue: s[key]?.newValue ?? null, ...p } }));

  return (
    <>
      <div className="panel">
        <h4>가동 방식</h4>
        <div className="stack">
          {(["on-demand", "always-on", "schedule"] as SleepMode[]).map((m) => (
            <button
              key={m}
              type="button"
              className={`choice ${sleepMode === m ? "sel" : ""}`}
              onClick={() => setSleepMode(m)}
            >
              <div className="t">{SLEEP_MODE_LABEL[m]}</div>
              <div className="d">{SLEEP_MODE_DESC[m]}</div>
            </button>
          ))}
        </div>
        {sleepMode === "schedule" && <ScheduleEditor value={schedule} onChange={setSchedule} />}
      </div>

      <div className="panel">
        <h4>배포·접근</h4>
        <div className="switch-row">
          <div className="txt">
            <div className="t">자동 배포</div>
            <div className="d">코드를 push 하면 자동으로 다시 배포해요.</div>
          </div>
          <Toggle on={autoDeploy} onChange={setAutoDeploy} label="자동 배포" />
        </div>
        <div className="switch-row">
          <div className="txt">
            <div className="t">로그인 보호</div>
            <div className="d">{PROTECT_DESC_TEXT}</div>
            <div className="d">{PROTECT_DETAIL_TEXT}</div>
            {protectUnavailable && (
              <div className="d" id="protect-unavailable">
                {PROTECT_UNAVAILABLE_TEXT}
              </div>
            )}
          </div>
          <Toggle
            on={protect}
            onChange={setProtect}
            label="로그인 보호"
            disabled={protectUnavailable}
            describedBy={protectUnavailable ? "protect-unavailable" : undefined}
          />
        </div>
        {protectError && (
          <div className="mt3">
            <ErrorNotice error={protectError} />
          </div>
        )}
      </div>

      <div className="panel">
        <h4>설정값 (환경변수)</h4>
        <p className="muted" style={{ marginTop: -4, marginBottom: 12, fontSize: 13 }}>
          바꾼 설정값은 <b>다음 배포부터</b> 앱에 적용돼요. 바로 적용하려면 저장한 뒤 위의 '지금 배포'를 눌러주세요.
        </p>
        <div className="stack">
          {envRows.map((r, i) => (
            <div key={i} className="row kv-row">
              <input
                className="input kv-key"
                aria-label="설정 이름"
                placeholder="이름 (예: API_KEY)"
                value={r.key}
                onChange={(e) =>
                  setEnvRows((rows) => rows.map((x, idx) => (idx === i ? { ...x, key: e.target.value } : x)))
                }
              />
              <input
                className="input kv-value"
                aria-label="설정 값"
                placeholder="값"
                value={r.value}
                onChange={(e) =>
                  setEnvRows((rows) => rows.map((x, idx) => (idx === i ? { ...x, value: e.target.value } : x)))
                }
              />
              <button
                type="button"
                className="row-act"
                aria-label="삭제"
                onClick={() => setEnvRows((rows) => rows.filter((_, idx) => idx !== i))}
              >
                <Trash2 size={16} className="icon" />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="btn btn-ghost mt3"
          onClick={() => setEnvRows((rows) => [...rows, { key: "", value: "" }])}
        >
          설정값 추가
        </button>
      </div>

      <SecretsPanel
        existingSecretKeys={existingSecretKeys}
        secretState={secretState}
        setKeyState={setKeyState}
        newSecrets={newSecrets}
        setNewSecrets={setNewSecrets}
      />

      {saveMut.error && !protectError && <ErrorNotice error={saveMut.error} />}
      {redeploy && !saveMut.error && (
        <RedeployNotice result={redeploy} onOpenDeployments={onOpenDeployments} />
      )}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!dirty || scheduleBlocked || saveMut.loading}
          onClick={requestSave}
        >
          <Play size={15} className="icon" />
          {saveMut.loading ? "저장 중…" : "변경 사항 저장"}
        </button>
      </div>

      {confirmRedeploy && (
        <Modal title="앱을 다시 배포할까요?" onClose={() => setConfirmRedeploy(false)}>
          <p>
            비밀 값을 바꾸면 앱이 <b>다시 배포돼요.</b> 몇 분 동안 앱이 재시작될 수 있어요. 계속할까요?
          </p>
          <SecretChangeSummary
            changed={Object.keys(secretsBody.secrets)}
            removed={secretsBody.secretsRemove}
          />
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmRedeploy(false)}>
              취소
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void save()}>
              <Rocket size={15} className="icon" />
              다시 배포하고 저장
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

// 확인 모달 안의 변경 요약 — 어떤 비밀값이 바뀌는지 이름만 보여준다(값은 노출하지 않음).
function SecretChangeSummary({ changed, removed }: { changed: string[]; removed: string[] }): JSX.Element {
  return (
    <ul className="muted" aria-label="바뀌는 비밀 설정값" style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 13 }}>
      {changed.map((k) => (
        <li key={`c-${k}`}>
          <span className="mono">{k}</span> — 새 값으로 저장
        </li>
      ))}
      {removed.map((k) => (
        <li key={`r-${k}`}>
          <span className="mono">{k}</span> — 삭제
        </li>
      ))}
    </ul>
  );
}

// 저장 후 재배포 결과 안내(D8). 서버 note 가 있으면 그대로 우선 표시, 없으면 기본 문구.
//  - PENDING: 다시 배포 시작(성공 톤) → 배포 이력에서 진행 확인.
//  - SKIPPED/NOT_DEPLOYED: 아직 첫 배포 전 → 첫 배포 때 적용(안내 톤).
//  - SKIPPED/IMAGE_NOT_FOUND·START_FAILED: 저장은 됐지만 재배포 못 함 → '지금 배포' 유도(경고 톤).
function RedeployNotice({
  result,
  onOpenDeployments,
}: {
  result: RedeployResult;
  onOpenDeployments: () => void;
}): JSX.Element {
  if (result.status === "PENDING") {
    return (
      <div className="notice success" role="status">
        <CheckCircle2 size={18} className="icon" />
        <div>
          <div>{result.note || REDEPLOY_PENDING_MESSAGE}</div>
          <button type="button" className="btn btn-ghost mt3" onClick={onOpenDeployments}>
            <History size={15} className="icon" />
            배포 이력에서 진행 상황 보기
          </button>
        </div>
      </div>
    );
  }
  const message = result.note || REDEPLOY_SKIPPED_MESSAGE[result.reason];
  if (result.reason === "NOT_DEPLOYED") {
    return (
      <div className="notice info" role="status">
        <Info size={18} className="icon" />
        <div>{message}</div>
      </div>
    );
  }
  return (
    <div className="notice warn" role="status">
      <AlertTriangle size={18} className="icon" />
      <div>{message}</div>
    </div>
  );
}

// ── 비밀값(시크릿) 관리 패널 ──
// 값은 응답으로 내려오지 않으므로(secretKeys 는 KEY 목록뿐) 키만 표시하고, 값은 "다시 볼 수 없어요"로 안내한다.
// 기존 키: 새 값 입력 시 교체, 삭제 버튼으로 제거 표시. 새 비밀값: 이름+값 입력해 추가.
function SecretsPanel({
  existingSecretKeys,
  secretState,
  setKeyState,
  newSecrets,
  setNewSecrets,
}: {
  existingSecretKeys: string[];
  secretState: Record<string, { removed: boolean; newValue: string | null }>;
  setKeyState: (key: string, p: Partial<{ removed: boolean; newValue: string | null }>) => void;
  newSecrets: { key: string; value: string }[];
  setNewSecrets: Dispatch<SetStateAction<{ key: string; value: string }[]>>;
}): JSX.Element {
  return (
    <div className="panel">
      <h4>
        <KeyRound size={16} className="icon" />
        비밀 설정값
      </h4>
      <p className="muted" style={{ marginTop: -4, marginBottom: 12, fontSize: 13 }}>
        비밀번호·API 키처럼 민감한 값이에요. 안전하게 따로 보관되며, <b>한 번 저장하면 값은 다시 볼 수 없어요.</b>{" "}
        바꾸려면 새 값을 입력하세요. 비밀 설정값을 추가·변경·삭제하면 저장할 때 앱이 <b>바로 다시 배포돼요.</b>
      </p>

      {existingSecretKeys.length === 0 && newSecrets.length === 0 && (
        <p className="muted">아직 저장된 비밀 설정값이 없어요.</p>
      )}

      <div className="stack">
        {existingSecretKeys.map((key) => {
          const st = secretState[key];
          const removed = st?.removed ?? false;
          const replacing = !removed && st?.newValue !== null && st?.newValue !== undefined;
          return (
            <div key={key} className="row kv-row" style={{ alignItems: "center", opacity: removed ? 0.5 : 1 }}>
              <input
                className="input mono"
                aria-label="비밀값 이름"
                value={key}
                readOnly
                style={{ flex: "0 0 220px", maxWidth: 220, fontWeight: 600 }}
              />
              <input
                className="input kv-value"
                type="password"
                aria-label={`${key} 새 값`}
                placeholder={removed ? "삭제될 값이에요" : "값 유지 (바꾸려면 새 값 입력)"}
                value={replacing ? (st?.newValue ?? "") : ""}
                disabled={removed}
                onChange={(e) => setKeyState(key, { newValue: e.target.value })}
              />
              {removed ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setKeyState(key, { removed: false, newValue: null })}
                >
                  삭제 취소
                </button>
              ) : (
                <button
                  type="button"
                  className="row-act"
                  aria-label={`${key} 삭제`}
                  onClick={() => setKeyState(key, { removed: true, newValue: null })}
                >
                  <Trash2 size={16} className="icon" />
                </button>
              )}
            </div>
          );
        })}

        {newSecrets.map((r, i) => (
          <div key={`new-${i}`} className="row kv-row" style={{ alignItems: "center" }}>
            <input
              className="input kv-key"
              aria-label="새 비밀값 이름"
              placeholder="이름 (예: DB_PASSWORD)"
              value={r.key}
              onChange={(e) =>
                setNewSecrets((rows) => rows.map((x, idx) => (idx === i ? { ...x, key: e.target.value } : x)))
              }
            />
            <input
              className="input kv-value"
              type="password"
              aria-label="새 비밀값 값"
              placeholder="값"
              value={r.value}
              onChange={(e) =>
                setNewSecrets((rows) => rows.map((x, idx) => (idx === i ? { ...x, value: e.target.value } : x)))
              }
            />
            <button
              type="button"
              className="row-act"
              aria-label="삭제"
              onClick={() => setNewSecrets((rows) => rows.filter((_, idx) => idx !== i))}
            >
              <Trash2 size={16} className="icon" />
            </button>
          </div>
        ))}
      </div>

      <button
        type="button"
        className="btn btn-ghost mt3"
        onClick={() => setNewSecrets((rows) => [...rows, { key: "", value: "" }])}
      >
        <KeyRound size={15} className="icon" />
        비밀 설정값 추가
      </button>
    </div>
  );
}
