/**
 * 관리자 전체 현황 — 모든 앱(소유자·상태·크기·공개범위·최근 변경) + 강제 중지/삭제.
 * 관리자 화면: 기술 용어 허용.
 */
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { ErrorNotice, Skeleton, relTime } from "../../components/common.js";
import { useQuery } from "../../lib/ApiProvider.js";
import type { App, AppStatus, RuntimeState } from "../../lib/types.js";
import { SCHEME_LABEL } from "../../lib/labels.js";

const PRESET_NAME: Record<string, string> = {
  "preset-small": "작게",
  "preset-medium": "보통",
  "preset-large": "크게",
};

function StatePill({ status, runtimeState }: { status: AppStatus; runtimeState: RuntimeState }): JSX.Element {
  if (status === "FAILED")
    return (
      <span className="pill fail">
        <span className="dot" />
        실패
      </span>
    );
  if (status === "CREATING")
    return (
      <span className="pill pending">
        <span className="dot" />
        생성 중
      </span>
    );
  if (status === "DELETING")
    return (
      <span className="pill pending">
        <span className="dot" />
        삭제 중
      </span>
    );
  const map: Record<RuntimeState, { cls: string; label: string }> = {
    RUNNING: { cls: "run", label: "실행 중" },
    WAKING: { cls: "wake", label: "깨우는 중" },
    SLEEPING: { cls: "sleep", label: "잠자는 중" },
  };
  const m = map[runtimeState];
  return (
    <span className={`pill ${m.cls}`}>
      <span className="dot" />
      {m.label}
    </span>
  );
}

export function AdminOverview(): JSX.Element {
  const { data: apps, loading, error } = useQuery<App[]>((a) => a.adminListAllApps(), []);
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<AppStatus | "ALL">("ALL");

  const filtered = useMemo(() => {
    if (!apps) return [];
    return apps.filter((a) => {
      if (statusFilter !== "ALL" && a.status !== statusFilter) return false;
      if (q && !`${a.name} ${a.subdomain} ${a.ownerId}`.toLowerCase().includes(q.toLowerCase()))
        return false;
      return true;
    });
  }, [apps, q, statusFilter]);

  const counts = useMemo(() => {
    const c = { total: apps?.length ?? 0, running: 0, sleeping: 0, failed: 0 };
    for (const a of apps ?? []) {
      if (a.status === "FAILED") c.failed++;
      else if (a.status === "ACTIVE" && a.runtimeState === "RUNNING") c.running++;
      else if (a.runtimeState === "SLEEPING") c.sleeping++;
    }
    return c;
  }, [apps]);

  if (error) return <ErrorNotice error={error} />;
  if (loading) return <Skeleton height={44} count={5} />;

  return (
    <>
      <div className="admin-toolbar">
        <span className="search">
          <Search size={15} className="icon" />
          <input
            placeholder="앱 이름·소유자·주소 검색"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="앱 검색"
          />
        </span>
        <button type="button" className={`chip ${statusFilter === "ALL" ? "accent" : ""}`} onClick={() => setStatusFilter("ALL")}>
          전체 {counts.total}
        </button>
        <button type="button" className="chip" onClick={() => setStatusFilter("ACTIVE")}>
          실행 {counts.running}
        </button>
        <button type="button" className="chip" onClick={() => setStatusFilter("ACTIVE")}>
          잠자는 중 {counts.sleeping}
        </button>
        <button type="button" className="chip" onClick={() => setStatusFilter("FAILED")}>
          실패 {counts.failed}
        </button>
      </div>

      <table>
        <thead>
          <tr>
            <th>앱</th>
            <th>소유자</th>
            <th>상태</th>
            <th>크기</th>
            <th>공개 범위</th>
            <th>최근 변경</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {filtered.map((a) => (
            <tr key={a.appId}>
              <td>
                <div style={{ fontWeight: 600 }}>{a.name}</div>
                <div className="mono">{a.subdomain}</div>
              </td>
              <td>
                <div className="owner">
                  <span className="av">{a.ownerId.slice(-2)}</span>
                  <span className="mono">{a.ownerId}</span>
                </div>
              </td>
              <td>
                <StatePill status={a.status} runtimeState={a.runtimeState} />
              </td>
              <td>{PRESET_NAME[a.presetId] ?? a.presetId}</td>
              <td>{SCHEME_LABEL[a.scheme]}{a.cognitoProtect ? " · 인증" : ""}</td>
              <td className="mono">{relTime(a.updatedAt)}</td>
              <td>
                <button type="button" className="row-act" aria-label="작업 메뉴">
                  <span style={{ fontWeight: 700 }}>···</span>
                </button>
              </td>
            </tr>
          ))}
          {filtered.length === 0 && (
            <tr>
              <td colSpan={7} style={{ textAlign: "center", padding: 32 }} className="muted">
                조건에 맞는 앱이 없습니다.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
