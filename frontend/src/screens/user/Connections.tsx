/**
 * 레포 연결 관리 — 연결 목록·추가.
 * AWS 저장소(codecommit)는 즉시 사용 가능하며, 카드 안에서 내가 만든 저장소 목록을 펼쳐 보고
 * 새로 만들거나 삭제할 수 있다(코드가 사라지는 파괴적 작업이라 이름 입력 확인).
 * GitHub/GitLab은 아직 웹에서 승인할 수 없어 PENDING 상태로 "준비 중"임을 정직하게 안내한다
 * (카드는 그대로 두어 향후 웹 승인이 같은 자리에 들어감). 레포 관리는 codecommit 전용.
 * 용어 사전: CodeConnections/OAuth 같은 내부 용어, "AWS 콘솔/GitHub 화면에서 승인" 같은
 * 틀린·기술적 안내는 노출하지 않는다.
 */
import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FolderGit2,
  Github,
  Gitlab,
  Loader2,
  Plug,
  Plus,
  Server,
  Trash2,
} from "lucide-react";
import { Badge } from "../../components/StatusBadge.js";
import {
  EmptyState,
  ErrorNotice,
  InfoNotice,
  Modal,
  Skeleton,
  TopBar,
  relTime,
} from "../../components/common.js";
import { NewRepoModal } from "../../components/RepoManager.js";
import { useMutation, useQuery } from "../../lib/ApiProvider.js";
import { useAuth } from "../../auth/AuthContext.js";
import { sessionInitial } from "../../auth/tokens.js";
import type { CodeCommitRepo, Provider, RepoConnection } from "../../lib/types.js";
import {
  CONNECTION_LABEL,
  CONNECTION_TONE,
  PROVIDER_LABEL,
} from "../../lib/labels.js";

function providerIcon(p: Provider): JSX.Element {
  if (p === "github") return <Github size={18} className="icon" />;
  if (p === "gitlab") return <Gitlab size={18} className="icon" />;
  return <Server size={18} className="icon" />;
}

export function Connections(): JSX.Element {
  const { session, logout } = useAuth();
  const { data: conns, loading, error, reload } = useQuery<RepoConnection[]>(
    (a) => a.listConnections(),
    [],
  );
  const [showAdd, setShowAdd] = useState(false);
  const [pendingResult, setPendingResult] = useState<RepoConnection | null>(null);

  const userInitial = sessionInitial(session);

  return (
    <div className="wrap">
      <TopBar userInitial={userInitial} onLogout={logout} />

      <div className="page-head">
        <div>
          <h2>
            <Plug size={20} className="icon" style={{ color: "var(--primary)" }} />
            저장소 연결
          </h2>
          <div className="desc">앱을 만들 때 사용할 코드 저장소를 미리 연결해두세요.</div>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setShowAdd(true)}>
          <Plus size={16} className="icon" />
          연결 추가
        </button>
      </div>

      {error && <ErrorNotice error={error} />}
      {loading && <Skeleton height={70} count={2} />}

      {!loading && !error && conns && conns.length === 0 && (
        <EmptyState
          icon={<Plug size={26} className="icon" />}
          title="연결된 저장소가 없어요"
          desc="GitHub, GitLab, 또는 AWS 저장소(CodeCommit)를 연결할 수 있어요."
          action={
            <button type="button" className="btn btn-primary" onClick={() => setShowAdd(true)}>
              <Plus size={16} className="icon" />첫 연결 추가
            </button>
          }
        />
      )}

      {conns?.map((c) => (
        <div key={c.connId} className="panel">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div className="row">
              <span className="app-icon b" style={{ width: 40, height: 40 }}>
                {providerIcon(c.provider)}
              </span>
              <div>
                <div style={{ fontWeight: 700 }}>{c.displayName}</div>
                <div className="muted" style={{ fontSize: 13 }}>
                  {PROVIDER_LABEL[c.provider]} · {relTime(c.createdAt)}
                </div>
              </div>
            </div>
            <div className="row">
              <Badge tone={CONNECTION_TONE[c.status]} label={CONNECTION_LABEL[c.status]} />
              <DeleteConnBtn connId={c.connId} onDone={reload} />
            </div>
          </div>

          {/* AWS 저장소(codecommit)이면서 사용 가능할 때만 내 저장소 목록·관리를 카드 안에 노출.
              github/gitlab 은 레포 관리 대상이 아니다(기존 그대로). */}
          {c.provider === "codecommit" && c.status === "AVAILABLE" && (
            <RepoSection connId={c.connId} />
          )}

          {c.status === "PENDING" && (
            <div className="mt3">
              <InfoNotice>
                {PROVIDER_LABEL[c.provider]} 연결 방식은 아직 준비 중이에요. 지금은 관리자를 통해 연결을 완료해야
                사용할 수 있어요. 곧 이 화면에서 바로 연결을 마칠 수 있도록 준비하고 있어요.
                <br />
                바로 앱을 만들고 싶다면 <b>AWS 저장소(CodeCommit)</b>를 사용하시길 권장해요.
              </InfoNotice>
            </div>
          )}
        </div>
      ))}

      {showAdd && (
        <AddConnectionModal
          onClose={() => setShowAdd(false)}
          onCreated={(conn) => {
            setShowAdd(false);
            reload();
            if (conn.needsAuthorization) setPendingResult(conn);
          }}
        />
      )}

      {pendingResult && (
        <Modal title="연결을 만들었어요" onClose={() => setPendingResult(null)}>
          <p>
            <b>{pendingResult.displayName}</b> 연결이 만들어졌어요. 다만{" "}
            {PROVIDER_LABEL[pendingResult.provider]} 연결 방식은 아직 준비 중이라, 지금은 관리자를 통해 연결을
            완료해야 이 저장소로 앱을 만들 수 있어요. 곧 이 화면에서 바로 마칠 수 있도록 준비하고 있어요.
          </p>
          <p style={{ marginTop: 10 }}>
            바로 시작하고 싶다면 <b>AWS 저장소(CodeCommit)</b> 연결을 추가해보세요. 만들면 바로 사용할 수 있어요.
          </p>
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={() => setPendingResult(null)}>
              알겠어요
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── AWS 저장소(CodeCommit) 연결 카드 안: 내 저장소 목록 토글 + 만들기/삭제 ──
// 접힘/펼침으로 카드 밀도를 낮춘다. 펼쳐야 목록을 불러온다(펼치기 전엔 조회하지 않음).
function RepoSection({ connId }: { connId: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  // 펼치기 전엔 목록을 불러오지 않는다(접힌 카드마다 조회 방지). open 이 되면 그때 조회.
  const repos = useQuery<CodeCommitRepo[]>(
    (a) => (open ? a.listRepos(connId) : Promise.resolve([])),
    [connId, open],
  );

  const items = repos.data ?? [];
  // 아직 안 펼쳤으면 개수 미상 → "내 저장소" 만. 펼친 뒤(로딩 끝)엔 개수 표기.
  const countLabel = open && !repos.loading ? `내 저장소 ${items.length}개` : "내 저장소";

  return (
    <div className="repo-section">
      <button
        type="button"
        className="repo-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <ChevronDown size={16} className="icon" />
        ) : (
          <ChevronRight size={16} className="icon" />
        )}
        <FolderGit2 size={15} className="icon" />
        <span>{countLabel}</span>
      </button>

      {open && (
        <div className="repo-body">
          {repos.loading ? (
            <div className="hint row" style={{ gap: 6 }}>
              <Loader2 size={14} className="icon spin" />
              저장소 목록을 불러오는 중…
            </div>
          ) : repos.error ? (
            <ErrorNotice error={repos.error} />
          ) : (
            <>
              {items.length === 0 ? (
                <p className="muted" style={{ margin: "4px 0 10px" }}>
                  아직 만든 저장소가 없어요. '새 저장소 만들기'로 시작해보세요.
                </p>
              ) : (
                <div className="repo-list">
                  {items.map((r) => (
                    <RepoRow
                      key={r.repoName}
                      connId={connId}
                      repo={r}
                      onDeleted={() => repos.reload()}
                    />
                  ))}
                </div>
              )}
              <button
                type="button"
                className="btn btn-ghost mt3"
                onClick={() => setCreating(true)}
              >
                <Plus size={16} className="icon" />새 저장소 만들기
              </button>
            </>
          )}
        </div>
      )}

      {creating && (
        <NewRepoModal
          connId={connId}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            repos.reload();
          }}
          intro="AWS 저장소(CodeCommit)에 새 코드 저장소를 만들어요. 만든 뒤 앱을 만들 때 이 저장소를 고를 수 있어요."
          confirmLabel="만들기"
        />
      )}
    </div>
  );
}

// ── 저장소 한 줄 (이름 + 삭제) ──
function RepoRow({
  connId,
  repo,
  onDeleted,
}: {
  connId: string;
  repo: CodeCommitRepo;
  onDeleted: () => void;
}): JSX.Element {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="repo-item">
      <FolderGit2 size={15} className="icon muted" />
      <span className="repo-name mono">{repo.repoName}</span>
      <button
        type="button"
        className="row-act"
        aria-label={`${repo.repoName} 저장소 삭제`}
        onClick={() => setConfirm(true)}
      >
        <Trash2 size={16} className="icon" />
      </button>
      {confirm && (
        <DeleteRepoModal
          connId={connId}
          repo={repo}
          onClose={() => setConfirm(false)}
          onDeleted={() => {
            setConfirm(false);
            onDeleted();
          }}
        />
      )}
    </div>
  );
}

// ── 저장소 삭제 확인 모달 (파괴적) ──
// 코드가 사라지는 되돌릴 수 없는 작업이므로, 저장소 이름을 정확히 입력해야만 삭제 버튼이 활성화된다
// (앱 삭제 확인과 동일 패턴). 사용 중인 앱이 있으면 서버가 409 REPO_IN_USE → 모달 안에서 안내.
function DeleteRepoModal({
  connId,
  repo,
  onClose,
  onDeleted,
}: {
  connId: string;
  repo: CodeCommitRepo;
  onClose: () => void;
  onDeleted: () => void;
}): JSX.Element {
  const del = useMutation<void, void>((a) => a.deleteRepo(connId, repo.repoName));
  const [confirmText, setConfirmText] = useState("");
  return (
    <Modal title="저장소를 삭제할까요?" onClose={onClose}>
      <p>
        저장소를 삭제하면 안의 코드가 모두 사라지고 되돌릴 수 없어요. 확인을 위해 저장소 이름{" "}
        <b className="mono">{repo.repoName}</b>을(를) 입력해주세요.
      </p>
      <input
        className="input"
        value={confirmText}
        onChange={(e) => setConfirmText(e.target.value)}
        placeholder={repo.repoName}
        aria-label="삭제 확인 저장소 이름"
        autoFocus
      />
      {del.error && (
        <div className="mt3">
          <ErrorNotice error={del.error} />
        </div>
      )}
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          취소
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={confirmText !== repo.repoName || del.loading}
          onClick={async () => {
            try {
              await del.run();
              onDeleted();
            } catch {
              /* 에러(REPO_IN_USE 등)는 del.error 로 모달 안에서 표시 */
            }
          }}
        >
          {del.loading ? "삭제 중…" : "삭제할게요"}
        </button>
      </div>
    </Modal>
  );
}

function DeleteConnBtn({ connId, onDone }: { connId: string; onDone: () => void }): JSX.Element {
  const del = useMutation<void, void>((a) => a.deleteConnection(connId));
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <button type="button" className="row-act" aria-label="연결 삭제" onClick={() => setConfirm(true)}>
        <Trash2 size={16} className="icon" />
      </button>
      {confirm && (
        <Modal title="연결을 삭제할까요?" onClose={() => setConfirm(false)}>
          <p>이 저장소 연결을 삭제하면, 이 연결로 만든 앱의 자동 배포가 멈출 수 있어요.</p>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setConfirm(false)}>
              취소
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={del.loading}
              onClick={async () => {
                await del.run().catch(() => undefined);
                setConfirm(false);
                onDone();
              }}
            >
              삭제
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function AddConnectionModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (conn: RepoConnection) => void;
}): JSX.Element {
  // 기본 선택은 AWS 저장소(CodeCommit) — 바로 사용 가능하므로 비개발자에게 권장.
  const [provider, setProvider] = useState<Provider>("codecommit");
  const [name, setName] = useState("");
  const create = useMutation<{ provider: Provider; name: string }, RepoConnection>((a, args) =>
    a.createConnection(args.provider, args.name),
  );

  return (
    <Modal title="저장소 연결 추가" onClose={onClose}>
      <div className="field">
        <label>저장소 종류</label>
        <div className="choice-row" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
          {(["codecommit", "github", "gitlab"] as Provider[]).map((p) => (
            <button
              key={p}
              type="button"
              className={`choice ${provider === p ? "sel" : ""}`}
              onClick={() => setProvider(p)}
              style={{ padding: 12 }}
            >
              <div className="ico">{providerIcon(p)}</div>
              <div className="t" style={{ fontSize: 13 }}>
                {PROVIDER_LABEL[p]}
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label htmlFor="conn-name">연결 이름</label>
        <input
          id="conn-name"
          className="input"
          placeholder="예: 회사 GitHub"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="hint">
          {provider === "codecommit"
            ? "AWS 저장소(CodeCommit)는 바로 사용할 수 있어요."
            : "이 연결 방식은 아직 준비 중이에요. 지금 만들면 관리자를 통해 연결을 완료해야 사용할 수 있어요. 바로 시작하려면 AWS 저장소(CodeCommit)를 권장해요."}
        </div>
      </div>
      {create.error && <ErrorNotice error={create.error} />}
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          취소
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!name.trim() || create.loading}
          onClick={async () => {
            try {
              const conn = await create.run({ provider, name: name.trim() });
              onCreated(conn);
            } catch {
              /* 에러 표시 */
            }
          }}
        >
          {create.loading ? "만드는 중…" : "연결 만들기"}
        </button>
      </div>
    </Modal>
  );
}
