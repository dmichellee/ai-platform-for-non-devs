/**
 * 레포 연결 관리 — 연결 목록·추가. GitHub/GitLab은 외부 승인(PENDING) 흐름 안내,
 * AWS 저장소(codecommit)는 즉시 사용 가능.
 * 용어 사전: CodeConnections/OAuth 같은 내부 용어는 노출하지 않는다.
 */
import { useState } from "react";
import { Github, Gitlab, Plug, Plus, Server, Trash2 } from "lucide-react";
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
import { useMutation, useQuery } from "../../lib/ApiProvider.js";
import { useAuth } from "../../auth/AuthContext.js";
import { sessionInitial } from "../../auth/tokens.js";
import type { Provider, RepoConnection } from "../../lib/types.js";
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
          {c.status === "PENDING" && (
            <div className="mt3">
              <InfoNotice>
                이 연결은 아직 <b>승인 대기 중</b>이에요. {PROVIDER_LABEL[c.provider]} 화면에서 접근을 승인해야
                사용할 수 있어요. 승인을 마친 뒤 이 페이지를 새로고침하면 '사용 가능'으로 바뀝니다.
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
        <Modal title="승인이 필요해요" onClose={() => setPendingResult(null)}>
          <p>
            <b>{pendingResult.displayName}</b> 연결이 만들어졌어요. 이제{" "}
            {PROVIDER_LABEL[pendingResult.provider]} 화면에서 AppHub의 접근을 승인해주세요. 승인을 마치면 이 저장소로
            앱을 만들 수 있어요.
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
  const [provider, setProvider] = useState<Provider>("github");
  const [name, setName] = useState("");
  const create = useMutation<{ provider: Provider; name: string }, RepoConnection>((a, args) =>
    a.createConnection(args.provider, args.name),
  );

  return (
    <Modal title="저장소 연결 추가" onClose={onClose}>
      <div className="field">
        <label>저장소 종류</label>
        <div className="choice-row" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
          {(["github", "gitlab", "codecommit"] as Provider[]).map((p) => (
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
            : "연결을 만든 뒤 외부 화면에서 접근을 승인해야 사용할 수 있어요."}
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
