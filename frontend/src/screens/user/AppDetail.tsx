/**
 * 앱 상세 — 상태(runtimeState 포함), 접속 URL, 배포 이력, 실시간 로그 뷰어,
 * 설정 탭(환경변수·가동 방식·자동배포), 수동 배포/재시작/삭제.
 * WAKING 상태면 "깨우는 중" 대기 안내를 상단에 보여준다.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ExternalLink,
  History,
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
import { useApi, useMutation, useQuery } from "../../lib/ApiProvider.js";
import { useNavigate } from "../../lib/router.js";
import { useAuth } from "../../auth/AuthContext.js";
import { sessionInitial } from "../../auth/tokens.js";
import type { App, Deployment, LogEvent, PatchAppRequest, SleepMode } from "../../lib/types.js";
import {
  DEPLOY_STATUS_LABEL,
  SCHEME_LABEL,
  SLEEP_MODE_DESC,
  SLEEP_MODE_LABEL,
  statusHint,
} from "../../lib/labels.js";

type Tab = "overview" | "logs" | "settings";

export function AppDetail({ appId }: { appId: string }): JSX.Element {
  const nav = useNavigate();
  const { session, logout } = useAuth();
  const [tab, setTab] = useState<Tab>("overview");
  const { data: app, loading, error, reload } = useQuery<App>((a) => a.getApp(appId), [appId]);

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
                <AppStatusBadge status={app.status} runtimeState={app.runtimeState} />
              </h2>
              <div className="row mt3" style={{ gap: 8 }}>
                <span className="mono muted">{app.subdomain}.apps.회사도메인</span>
                {app.status === "ACTIVE" && (
                  <a
                    className="topbar-link"
                    href={`https://${app.subdomain}.apps`}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.preventDefault()}
                    title="접속 (배포 후 활성화)"
                  >
                    <span className="row" style={{ gap: 5 }}>
                      <ExternalLink size={14} className="icon" />
                      열기
                    </span>
                  </a>
                )}
              </div>
            </div>
            <AppActions app={app} onChanged={reload} />
          </div>

          {app.status !== "ACTIVE" && statusHint(app.status) && (
            <InfoNotice>{statusHint(app.status)}</InfoNotice>
          )}
          {app.status === "ACTIVE" && app.runtimeState === "WAKING" && (
            <InfoNotice>
              앱을 깨우는 중이에요. 잠시만 기다려주세요 (보통 30초~1분). 준비되면 자동으로 열려요.
            </InfoNotice>
          )}

          <div className="tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "overview"}
              className={`tab ${tab === "overview" ? "active" : ""}`}
              onClick={() => setTab("overview")}
            >
              <span className="row" style={{ gap: 6 }}>
                <History size={15} className="icon" />
                개요·배포 이력
              </span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "logs"}
              className={`tab ${tab === "logs" ? "active" : ""}`}
              onClick={() => setTab("logs")}
            >
              <span className="row" style={{ gap: 6 }}>
                <ScrollText size={15} className="icon" />
                로그
              </span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "settings"}
              className={`tab ${tab === "settings" ? "active" : ""}`}
              onClick={() => setTab("settings")}
            >
              <span className="row" style={{ gap: 6 }}>
                <Settings size={15} className="icon" />
                설정
              </span>
            </button>
          </div>

          {tab === "overview" && <OverviewTab app={app} />}
          {tab === "logs" && <LogsTab appId={appId} />}
          {tab === "settings" && <SettingsTab app={app} onSaved={reload} />}
        </>
      )}
    </div>
  );
}

// ── 상단 액션 (수동 배포 / 재시작 / 삭제) ──
function AppActions({ app, onChanged }: { app: App; onChanged: () => void }): JSX.Element {
  const nav = useNavigate();
  const deployMut = useMutation<void, Deployment>((a) => a.deploy(app.appId));
  const deleteMut = useMutation<void, unknown>((a) => a.deleteApp(app.appId));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteText, setDeleteText] = useState("");

  const busy = app.status !== "ACTIVE";

  return (
    <div className="row">
      <button
        type="button"
        className="btn btn-ghost"
        disabled={busy || deployMut.loading}
        onClick={async () => {
          await deployMut.run().catch(() => undefined);
          onChanged();
        }}
        title="지금 최신 코드로 다시 배포"
      >
        <Rocket size={15} className="icon" />
        {deployMut.loading ? "배포 접수 중…" : "지금 배포"}
      </button>
      <button
        type="button"
        className="btn btn-ghost"
        disabled={busy}
        onClick={async () => {
          await deployMut.run().catch(() => undefined);
          onChanged();
        }}
        title="앱 다시 시작"
      >
        <RefreshCw size={15} className="icon" />
        재시작
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

// ── 개요 + 배포 이력 ──
function OverviewTab({ app }: { app: App }): JSX.Element {
  const nav = useNavigate();
  const { data: deps, loading } = useQuery<Deployment[]>(
    (a) => a.listDeployments(app.appId),
    [app.appId],
  );

  return (
    <div className="detail-grid">
      <div>
        <div className="panel">
          <h4>
            <History size={16} className="icon" />
            배포 이력
          </h4>
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
              onClick={() => nav(`/apps/${app.appId}/deployments/${encodeURIComponent(d.deploymentId)}`)}
            >
              <DeployBadge status={d.status} />
              <div>
                <div className="msg">{d.commitMessage ?? "배포"}</div>
                {d.commitSha && <div className="sha">{d.commitSha}</div>}
              </div>
              <span className="when">{relTime(d.createdAt)}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="panel">
          <h4>앱 정보</h4>
          <div className="kv">
            <span className="k">공개 범위</span>
            <span className="v">{SCHEME_LABEL[app.scheme]}</span>
          </div>
          <div className="kv">
            <span className="k">가동 방식</span>
            <span className="v">{SLEEP_MODE_LABEL[app.sleepMode]}</span>
          </div>
          <div className="kv">
            <span className="k">자동 배포</span>
            <span className="v">{app.autoDeployEnabled ? "켜짐 (코드 push 시 자동)" : "꺼짐"}</span>
          </div>
          <div className="kv">
            <span className="k">브랜치</span>
            <span className="v mono">{app.branch}</span>
          </div>
          {app.cognitoProtect && (
            <div className="kv">
              <span className="k">접근 보호</span>
              <span className="v">로그인한 사람만 접속</span>
            </div>
          )}
          <div className="kv">
            <span className="k">만든 날</span>
            <span className="v">{relTime(app.createdAt)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function DeployBadge({ status }: { status: Deployment["status"] }): JSX.Element {
  if (status === "SUCCEEDED") return <Badge tone="running" label="완료" variant="pill" />;
  if (status === "FAILED") return <Badge tone="fail" label="실패" variant="pill" />;
  return <Badge tone="waking" label={DEPLOY_STATUS_LABEL[status]} variant="pill" />;
}

// ── 로그 뷰어 (자동 새로고침) ──
function LogsTab({ appId }: { appId: string }): JSX.Element {
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
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <h4 style={{ margin: 0 }}>
          <ScrollText size={16} className="icon" />
          실시간 로그
        </h4>
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
    </div>
  );
}

// ── 설정 탭 (환경변수·가동 방식·자동배포 저장) ──
function SettingsTab({ app, onSaved }: { app: App; onSaved: () => void }): JSX.Element {
  const [autoDeploy, setAutoDeploy] = useState(app.autoDeployEnabled);
  const [sleepMode, setSleepMode] = useState<SleepMode>(app.sleepMode);
  const [protect, setProtect] = useState(app.cognitoProtect);
  const [envRows, setEnvRows] = useState(
    Object.entries(app.envVars).map(([key, value]) => ({ key, value })),
  );
  const saveMut = useMutation<PatchAppRequest, App>((a, body) => a.patchApp(app.appId, body));

  const dirty = useMemo(() => {
    const envChanged =
      JSON.stringify(Object.fromEntries(envRows.filter((r) => r.key).map((r) => [r.key, r.value]))) !==
      JSON.stringify(app.envVars);
    return (
      autoDeploy !== app.autoDeployEnabled ||
      sleepMode !== app.sleepMode ||
      protect !== app.cognitoProtect ||
      envChanged
    );
  }, [autoDeploy, sleepMode, protect, envRows, app]);

  async function save(): Promise<void> {
    const envVars: Record<string, string> = {};
    for (const r of envRows) if (r.key) envVars[r.key] = r.value;
    await saveMut
      .run({ autoDeployEnabled: autoDeploy, sleepMode, cognitoProtect: protect, envVars })
      .then(onSaved)
      .catch(() => undefined);
  }

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
            <div className="t">접근 보호</div>
            <div className="d">로그인한 사람만 이 앱에 접속할 수 있게 해요.</div>
          </div>
          <Toggle on={protect} onChange={setProtect} label="접근 보호" />
        </div>
      </div>

      <div className="panel">
        <h4>설정값 (환경변수)</h4>
        <div className="stack">
          {envRows.map((r, i) => (
            <div key={i} className="row">
              <input
                className="input"
                aria-label="설정 이름"
                value={r.key}
                onChange={(e) =>
                  setEnvRows((rows) => rows.map((x, idx) => (idx === i ? { ...x, key: e.target.value } : x)))
                }
              />
              <input
                className="input"
                aria-label="설정 값"
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
        {Object.keys(app.secretArns).length > 0 && (
          <p className="muted mt3">
            비밀로 보관된 값({Object.keys(app.secretArns).join(", ")})은 여기서 보이지 않아요. 안전하게 따로 저장돼 있어요.
          </p>
        )}
      </div>

      {saveMut.error && <ErrorNotice error={saveMut.error} />}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!dirty || saveMut.loading}
          onClick={save}
        >
          <Play size={15} className="icon" />
          {saveMut.loading ? "저장 중…" : "변경 사항 저장"}
        </button>
      </div>
    </>
  );
}
