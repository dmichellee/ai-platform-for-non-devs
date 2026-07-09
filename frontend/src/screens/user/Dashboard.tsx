/**
 * 내 앱 대시보드 — 앱 카드(이름·상태 배지·접속 URL·최근 배포·크기) + 새 앱 만들기.
 * AWS 용어 노출 금지. 접속 URL은 {subdomain}.apps.{도메인} 이지만 도메인은 config에서 유추 불가 →
 * subdomain만 강조 표기하고 상세에서 전체 URL(config 주입 시)을 보여준다.
 */
import { BarChart3, Bot, Hand, Plus, Sparkles } from "lucide-react";
import { AppStatusBadge } from "../../components/StatusBadge.js";
import { EmptyState, Skeleton, TopBar, relTime } from "../../components/common.js";
import { ErrorNotice } from "../../components/common.js";
import { useQuery } from "../../lib/ApiProvider.js";
import { useNavigate } from "../../lib/router.js";
import { useAuth } from "../../auth/AuthContext.js";
import { sessionDisplayName, sessionInitial } from "../../auth/tokens.js";
import type { App } from "../../lib/types.js";
import { PROVIDER_LABEL } from "../../lib/labels.js";

const PRESET_NAME: Record<string, string> = {
  "preset-small": "작게",
  "preset-medium": "보통",
  "preset-large": "크게",
};

function iconFor(app: App): { node: JSX.Element; cls: string } {
  if (app.permissionTemplateId === "perm-ai")
    return { node: <Bot size={22} className="icon" />, cls: "a" };
  if (app.subdomain.includes("board") || app.subdomain.includes("dash"))
    return { node: <BarChart3 size={22} className="icon" />, cls: "b" };
  return { node: <Sparkles size={22} className="icon" />, cls: "c" };
}

export function Dashboard(): JSX.Element {
  const nav = useNavigate();
  const { session, logout } = useAuth();
  const { data: apps, loading, error, reload } = useQuery<App[]>((api) => api.listApps(), []);

  const userInitial = sessionInitial(session);
  const displayName = sessionDisplayName(session);

  return (
    <div className="wrap">
      <TopBar
        userInitial={userInitial}
        appCount={apps?.length}
        quota={5}
        onLogout={logout}
      />

      <div className="greeting">
        <h3>
          안녕하세요, {displayName ?? ""}님
          <Hand size={20} className="icon" />
        </h3>
        <p>앱을 만들고 배포하고, 상태를 한눈에 확인하세요.</p>
      </div>

      {error && (
        <>
          <ErrorNotice error={error} />
          <button type="button" className="btn btn-ghost" onClick={reload}>
            다시 시도
          </button>
        </>
      )}

      {loading && (
        <div className="card-grid">
          <Skeleton height={210} />
          <Skeleton height={210} />
          <Skeleton height={210} />
        </div>
      )}

      {!loading && !error && apps && apps.length === 0 && (
        <EmptyState
          icon={<Plus size={26} className="icon" />}
          title="아직 만든 앱이 없어요"
          desc="코드 저장소를 연결하고 첫 앱을 만들어보세요."
          action={
            <button type="button" className="btn btn-primary" onClick={() => nav("/apps/new")}>
              <Plus size={16} className="icon" />첫 앱 만들기
            </button>
          }
        />
      )}

      {!loading && !error && apps && apps.length > 0 && (
        <div className="card-grid">
          {apps.map((app) => {
            const ic = iconFor(app);
            return (
              <button
                key={app.appId}
                type="button"
                className="app-card"
                onClick={() => nav(`/apps/${app.appId}`)}
              >
                <div className="top">
                  <div className={`app-icon ${ic.cls}`}>{ic.node}</div>
                  <AppStatusBadge status={app.status} runtimeState={app.runtimeState} />
                </div>
                <h4>{app.name}</h4>
                <div className="url">{app.subdomain}.apps</div>
                <div className="meta">
                  <span>
                    최근 변경 <b>{relTime(app.updatedAt)}</b>
                  </span>
                  <span>
                    크기 <b>{PRESET_NAME[app.presetId] ?? "보통"}</b>
                  </span>
                  <span>
                    <b>{PROVIDER_LABEL[app.provider]}</b>
                  </span>
                </div>
              </button>
            );
          })}

          <button type="button" className="app-card new-card" onClick={() => nav("/apps/new")}>
            <div>
              <div className="plus">
                <Plus size={22} className="icon" />
              </div>
              <div style={{ fontWeight: 600, fontSize: 15 }}>새 앱 만들기</div>
              <div style={{ fontSize: 13, marginTop: 2 }}>코드 저장소를 연결하세요</div>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}
