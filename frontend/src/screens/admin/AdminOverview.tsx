/**
 * 관리자 전체 현황 — 모든 앱(소유자·상태·크기·공개범위·최근 변경) + 강제 중지/삭제.
 * 관리자 화면: 기술 용어 허용.
 * 강제 중지: POST /admin/apps/{id}/stop (재우기). 삭제: DELETE /admin/apps/{id}.
 */
import { useMemo, useState } from "react";
import { MoonStar, Search, Trash2 } from "lucide-react";
import { ErrorNotice, Modal, Skeleton, relTime } from "../../components/common.js";
import { useMutation, useQuery } from "../../lib/ApiProvider.js";
import type { AdminStopResult, App, AppStatus, RuntimeState } from "../../lib/types.js";
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
  const { data: apps, loading, error, reload } = useQuery<App[]>((a) => a.adminListAllApps(), []);
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<AppStatus | "ALL">("ALL");
  // 강제 중지·삭제 대상 앱(모달 열림 상태). 둘 중 하나만 동시에 열린다.
  const [stopTarget, setStopTarget] = useState<App | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<App | null>(null);

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

  // 강제 중지는 실행 중(ACTIVE·RUNNING/WAKING)인 앱에만 의미가 있다.
  const canStop = (a: App): boolean => a.status === "ACTIVE" && a.runtimeState !== "SLEEPING";
  // 삭제는 생성 중/삭제 중이 아닐 때만.
  const canDelete = (a: App): boolean => a.status !== "CREATING" && a.status !== "DELETING";

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

      {/* 좁은 화면: 표는 이 상자 안에서만 가로 스크롤(화면 전체를 밀지 않음) */}
      <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>앱</th>
            <th>소유자</th>
            <th>상태</th>
            <th>크기</th>
            <th>공개 범위</th>
            <th>최근 변경</th>
            <th>작업</th>
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
                <div className="row" style={{ gap: 6 }}>
                  <button
                    type="button"
                    className="btn-admin"
                    disabled={!canStop(a)}
                    title={canStop(a) ? "이 앱을 강제로 재웁니다" : "재울 수 있는 상태가 아니에요"}
                    onClick={() => setStopTarget(a)}
                  >
                    <MoonStar size={14} className="icon" />
                    재우기
                  </button>
                  <button
                    type="button"
                    className="btn-admin danger"
                    disabled={!canDelete(a)}
                    aria-label={`${a.name} 삭제`}
                    title={canDelete(a) ? "이 앱을 삭제합니다" : "삭제할 수 있는 상태가 아니에요"}
                    onClick={() => setDeleteTarget(a)}
                  >
                    <Trash2 size={14} className="icon" />
                    삭제
                  </button>
                </div>
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
      </div>

      {stopTarget && (
        <AdminStopModal app={stopTarget} onClose={() => setStopTarget(null)} onDone={reload} />
      )}
      {deleteTarget && (
        <AdminDeleteModal app={deleteTarget} onClose={() => setDeleteTarget(null)} onDone={reload} />
      )}
    </>
  );
}

// ── 강제 중지(재우기) 확인 모달 ──
// 소유자 동의 없이 관리자가 즉시 잠재우는 작업이라 확인을 받는다.
function AdminStopModal({ app, onClose, onDone }: { app: App; onClose: () => void; onDone: () => void }): JSX.Element {
  const stopMut = useMutation<void, AdminStopResult>((a) => a.adminStopApp(app.appId));
  return (
    <Modal title="이 앱을 강제로 재울까요?" onClose={onClose}>
      <p>
        <b>{app.name}</b>(<span className="mono">{app.subdomain}</span>) 앱을 즉시 잠재웁니다. 사용 중인 접속은 끊길 수
        있고, 다시 접속하면 깨어납니다.
      </p>
      {stopMut.error && (
        <div className="mt3">
          <ErrorNotice error={stopMut.error} />
        </div>
      )}
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          취소
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={stopMut.loading}
          onClick={async () => {
            try {
              await stopMut.run();
              onDone();
              onClose();
            } catch {
              /* 에러 표시 */
            }
          }}
        >
          <MoonStar size={15} className="icon" />
          {stopMut.loading ? "재우는 중…" : "재우기"}
        </button>
      </div>
    </Modal>
  );
}

// ── 타인 앱 삭제 확인 모달 ──
// 관리자에 의한 삭제는 되돌릴 수 없으므로 앱 이름 입력 일치를 요구한다.
function AdminDeleteModal({ app, onClose, onDone }: { app: App; onClose: () => void; onDone: () => void }): JSX.Element {
  const deleteMut = useMutation<void, unknown>((a) => a.adminDeleteApp(app.appId));
  const [text, setText] = useState("");
  return (
    <Modal title="이 앱을 삭제할까요?" onClose={onClose}>
      <p>
        이 작업은 되돌릴 수 없어요. <b>{app.name}</b> 앱과 배포 기록이 모두 사라져요. 소유자는{" "}
        <span className="mono">{app.ownerId}</span>입니다. 확인을 위해 앱 이름 <b>{app.name}</b>을(를) 입력해주세요.
      </p>
      <input
        className="input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={app.name}
        aria-label="삭제 확인 이름"
      />
      {deleteMut.error && (
        <div className="mt3">
          <ErrorNotice error={deleteMut.error} />
        </div>
      )}
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          취소
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={text !== app.name || deleteMut.loading}
          onClick={async () => {
            try {
              await deleteMut.run();
              onDone();
              onClose();
            } catch {
              /* 에러 표시 */
            }
          }}
        >
          {deleteMut.loading ? "삭제 접수 중…" : "삭제할게요"}
        </button>
      </div>
    </Modal>
  );
}
