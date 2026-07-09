/**
 * 앱 생성 마법사 (7단계) — DESIGN 6장:
 *  1 저장소 연결 → 2 이름·공개 범위 → 3 크기 → 4 앱 유형 → 5 환경변수/시크릿
 *  → 6 가동 방식 → 7 Kiro 설정 안내.
 * AWS 용어 노출 금지. 마지막 단계 "만들기"에서만 POST /apps 호출(계약).
 */
import { useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Cpu,
  Download,
  FolderGit2,
  Github,
  Gitlab,
  Globe,
  KeyRound,
  Building2,
  Loader2,
  Plus,
  Rocket,
  Server,
  Trash2,
} from "lucide-react";
import { BackLink, ErrorNotice, InfoNotice, Modal, TopBar } from "../../components/common.js";
import { useApi, useMutation, useQuery } from "../../lib/ApiProvider.js";
import { useNavigate } from "../../lib/router.js";
import { useAuth } from "../../auth/AuthContext.js";
import { sessionInitial } from "../../auth/tokens.js";
import type {
  App,
  CodeCommitRepo,
  ComputePreset,
  CreateAppRequest,
  PermissionTemplate,
  Provider,
  RepoConnection,
  Scheme,
  SleepMode,
} from "../../lib/types.js";
import {
  PROVIDER_LABEL,
  SCHEME_DESC,
  SCHEME_LABEL,
  SLEEP_MODE_DESC,
  SLEEP_MODE_LABEL,
} from "../../lib/labels.js";

const STEP_LABELS = [
  "저장소",
  "이름·공개 범위",
  "크기",
  "앱 유형",
  "환경변수",
  "가동 방식",
  "설정 안내",
];

interface Draft {
  connection: RepoConnection | null;
  provider: Provider | null;
  repoUrl: string;
  branch: string;
  name: string;
  subdomain: string;
  scheme: Scheme;
  presetId: string;
  permissionTemplateId: string;
  envVars: { key: string; value: string; secret: boolean }[];
  sleepMode: SleepMode;
}

const EMPTY: Draft = {
  connection: null,
  provider: null,
  repoUrl: "",
  branch: "main",
  name: "",
  subdomain: "",
  scheme: "internal",
  presetId: "",
  permissionTemplateId: "",
  envVars: [],
  sleepMode: "on-demand",
};

function toSubdomain(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function CreateWizard(): JSX.Element {
  const nav = useNavigate();
  const { session, logout } = useAuth();
  const api = useApi();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [created, setCreated] = useState<App | null>(null);

  const conns = useQuery<RepoConnection[]>((a) => a.listConnections(), []);
  const presets = useQuery<ComputePreset[]>((a) => a.adminListPresets().catch(() => []), []);
  const perms = useQuery<PermissionTemplate[]>((a) => a.adminListPermTemplates().catch(() => []), []);
  const createMut = useMutation<CreateAppRequest, App>((a, body) => a.createApp(body));

  const patch = (p: Partial<Draft>): void => setDraft((d) => ({ ...d, ...p }));

  const canNext = useMemo<boolean>(() => {
    switch (step) {
      case 0:
        return !!draft.provider && !!draft.repoUrl;
      case 1:
        return draft.name.trim().length > 0 && draft.subdomain.length >= 3;
      case 2:
        return !!draft.presetId;
      case 3:
        return !!draft.permissionTemplateId;
      case 4:
        return true; // 환경변수는 선택
      case 5:
        return !!draft.sleepMode;
      default:
        return true;
    }
  }, [step, draft]);

  async function submit(): Promise<void> {
    const envVars: Record<string, string> = {};
    for (const e of draft.envVars) if (e.key) envVars[e.key] = e.value;
    const body: CreateAppRequest = {
      name: draft.name.trim(),
      subdomain: draft.subdomain,
      provider: draft.provider!,
      repoUrl: draft.repoUrl,
      branch: draft.branch || "main",
      ...(draft.connection ? { connectionId: draft.connection.connId } : {}),
      presetId: draft.presetId,
      permissionTemplateId: draft.permissionTemplateId,
      scheme: draft.scheme,
      vpcId: "vpc-01", // 목/데모 기본. 실서비스는 관리자 등록 VPC 중 자동 선택(단일이면 그것).
      sleepMode: draft.sleepMode,
      envVars,
    };
    try {
      const app = await createMut.run(body);
      setCreated(app);
      setStep(6);
    } catch {
      /* 에러는 createMut.error 로 표시 */
    }
  }

  const userInitial = sessionInitial(session);

  return (
    <div className="wrap">
      <TopBar userInitial={userInitial} onLogout={logout} />
      <BackLink label="내 앱으로" onClick={() => nav("/")} />

      <div className="wizard">
        <div className="steps" aria-label="단계 진행">
          {STEP_LABELS.map((label, i) => (
            <span key={label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className={`step ${i === step ? "active" : i < step ? "done" : ""}`}>
                <span className="num">
                  {i < step ? <Check size={13} className="icon" /> : i + 1}
                </span>
                {label}
              </span>
              {i < STEP_LABELS.length - 1 && <span className="line" />}
            </span>
          ))}
        </div>

        {createMut.error && <ErrorNotice error={createMut.error} />}

        {step === 0 && (
          <StepRepo draft={draft} patch={patch} conns={conns.data ?? []} />
        )}
        {step === 1 && <StepNameScheme draft={draft} patch={patch} />}
        {step === 2 && <StepSize draft={draft} patch={patch} presets={presets.data ?? []} />}
        {step === 3 && <StepType draft={draft} patch={patch} perms={perms.data ?? []} />}
        {step === 4 && <StepEnv draft={draft} patch={patch} />}
        {step === 5 && <StepSleep draft={draft} patch={patch} />}
        {step === 6 && <StepKiro created={created} onDone={() => nav(created ? `/apps/${created.appId}` : "/")} />}

        {step < 6 && (
          <div className="wizard-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => (step === 0 ? nav("/") : setStep((s) => s - 1))}
            >
              <ArrowLeft size={16} className="icon" />
              이전
            </button>
            {step < 5 ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canNext}
                onClick={() => setStep((s) => s + 1)}
              >
                다음 단계
                <ArrowRight size={16} className="icon" />
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canNext || createMut.loading}
                onClick={submit}
              >
                <Rocket size={16} className="icon" />
                {createMut.loading ? "만드는 중…" : "앱 만들기"}
              </button>
            )}
          </div>
        )}
      </div>

      {/* API가 목이 아닐 때 vpc 자동선택 설명은 생략 — 데모에서는 불필요 */}
      {void api}
    </div>
  );
}

// github/gitlab 저장소 주소 안내 (provider별).
const REPO_URL_PLACEHOLDER: Record<"github" | "gitlab", string> = {
  github: "https://github.com/계정/저장소",
  gitlab: "https://gitlab.com/계정/저장소",
};

// ── 단계 1: 저장소 연결 (하이브리드) ──
// codecommit(AWS 저장소): 본인 레포 드롭다운 + 새로 만들기 → cloneUrlHttp를 repoUrl로.
// github/gitlab: 저장소 주소 자유 입력(provider별 placeholder·안내).
function StepRepo({
  draft,
  patch,
  conns,
}: {
  draft: Draft;
  patch: (p: Partial<Draft>) => void;
  conns: RepoConnection[];
}): JSX.Element {
  const nav = useNavigate();
  const available = conns.filter((c) => c.status === "AVAILABLE");
  const isCodeCommit = draft.provider === "codecommit";

  // 연결이 바뀌면 이전에 고른 저장소 주소는 초기화(연결마다 저장소가 다름).
  function selectConnection(c: RepoConnection): void {
    if (draft.connection?.connId === c.connId) return;
    patch({ connection: c, provider: c.provider, repoUrl: "" });
  }

  return (
    <>
      <h3>어떤 코드 저장소를 배포할까요?</h3>
      <div className="sub">연결된 저장소에서 코드를 가져와 앱으로 만듭니다.</div>
      {available.length === 0 ? (
        <InfoNotice>
          아직 사용할 수 있는 저장소 연결이 없어요. 먼저{" "}
          <button
            type="button"
            className="topbar-link"
            style={{ padding: 0, textDecoration: "underline" }}
            onClick={() => nav("/connections")}
          >
            저장소 연결
          </button>{" "}
          메뉴에서 연결을 추가해주세요.
        </InfoNotice>
      ) : (
        <div className="stack">
          {available.map((c) => {
            const sel = draft.connection?.connId === c.connId;
            return (
              <button
                key={c.connId}
                type="button"
                className={`choice ${sel ? "sel" : ""}`}
                onClick={() => selectConnection(c)}
              >
                <div className="ico">
                  {c.provider === "github" ? (
                    <Github size={20} className="icon" />
                  ) : c.provider === "gitlab" ? (
                    <Gitlab size={20} className="icon" />
                  ) : (
                    <Server size={20} className="icon" />
                  )}
                </div>
                <div className="t">{c.displayName}</div>
                <div className="d">{PROVIDER_LABEL[c.provider]}</div>
              </button>
            );
          })}
        </div>
      )}

      {draft.connection && (
        <div className="grid-2 mt4">
          {isCodeCommit ? (
            <CodeCommitRepoPicker
              connId={draft.connection.connId}
              value={draft.repoUrl}
              onSelect={(repo) => patch({ repoUrl: repo.cloneUrlHttp })}
            />
          ) : (
            <div className="field">
              <label htmlFor="repoUrl">저장소 주소</label>
              <input
                id="repoUrl"
                className="input"
                placeholder={REPO_URL_PLACEHOLDER[draft.provider as "github" | "gitlab"]}
                value={draft.repoUrl}
                onChange={(e) => patch({ repoUrl: e.target.value })}
              />
              <div className="hint">연결한 계정의 저장소 주소를 붙여넣으세요.</div>
            </div>
          )}
          <div className="field">
            <label htmlFor="branch">배포할 브랜치</label>
            <input
              id="branch"
              className="input"
              placeholder="main"
              value={draft.branch}
              onChange={(e) => patch({ branch: e.target.value })}
            />
            <div className="hint">보통 main 이에요. 다른 브랜치를 쓰면 이름을 적어주세요.</div>
          </div>
        </div>
      )}
    </>
  );
}

// ── CodeCommit(AWS 저장소) 레포 드롭다운 + 새로 만들기 ──
// 본인이 AppHub로 만든 레포만 목록에 온다(계약). 선택 시 cloneUrlHttp를 위로 올린다.
function CodeCommitRepoPicker({
  connId,
  value,
  onSelect,
}: {
  connId: string;
  value: string;
  onSelect: (repo: CodeCommitRepo) => void;
}): JSX.Element {
  const repos = useQuery<CodeCommitRepo[]>((a) => a.listRepos(connId), [connId]);
  const [creating, setCreating] = useState(false);

  const items = repos.data ?? [];
  // 현재 repoUrl(cloneUrlHttp)에 해당하는 레포 이름을 select value로.
  const selectedName = items.find((r) => r.cloneUrlHttp === value)?.repoName ?? "";

  function onRepoCreated(repo: CodeCommitRepo): void {
    setCreating(false);
    repos.reload(); // 목록 갱신
    onSelect(repo); // 자동 선택
  }

  return (
    <div className="field">
      <label htmlFor="repo-select">배포할 저장소</label>
      {repos.loading ? (
        <div className="hint row" style={{ gap: 6 }}>
          <Loader2 size={14} className="icon spin" />
          저장소 목록을 불러오는 중…
        </div>
      ) : repos.error ? (
        <ErrorNotice error={repos.error} />
      ) : (
        <>
          <div className="row" style={{ gap: 8 }}>
            <div className="select-wrap" style={{ flex: 1 }}>
              <FolderGit2 size={15} className="icon select-ico" />
              <select
                id="repo-select"
                className="input select"
                value={selectedName}
                onChange={(e) => {
                  const repo = items.find((r) => r.repoName === e.target.value);
                  if (repo) onSelect(repo);
                }}
              >
                <option value="" disabled>
                  {items.length === 0 ? "아직 만든 저장소가 없어요" : "저장소를 골라주세요"}
                </option>
                {items.map((r) => (
                  <option key={r.repoName} value={r.repoName}>
                    {r.repoName}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ whiteSpace: "nowrap" }}
              onClick={() => setCreating(true)}
            >
              <Plus size={16} className="icon" />새 저장소 만들기
            </button>
          </div>
          <div className="hint">
            {items.length === 0
              ? "AppHub로 만든 저장소가 여기 나와요. '새 저장소 만들기'로 시작해보세요."
              : "원하는 저장소가 없다면 '새 저장소 만들기'로 추가할 수 있어요."}
          </div>
        </>
      )}

      {creating && (
        <NewRepoModal connId={connId} onClose={() => setCreating(false)} onCreated={onRepoCreated} />
      )}
    </div>
  );
}

// ── 새 CodeCommit 레포 만들기 모달 ──
function NewRepoModal({
  connId,
  onClose,
  onCreated,
}: {
  connId: string;
  onClose: () => void;
  onCreated: (repo: CodeCommitRepo) => void;
}): JSX.Element {
  const [name, setName] = useState("");
  const createMut = useMutation<string, CodeCommitRepo>((a, repoName) => a.createRepo(connId, repoName));

  // 계약 이름 규칙에 맞는지 즉시 힌트 (소문자·숫자로 시작·끝, 가운데 -/_/. 허용).
  const trimmed = name.trim();
  const looksValid =
    trimmed.length > 0 && /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(trimmed) && !trimmed.endsWith(".git");

  async function submit(): Promise<void> {
    try {
      const repo = await createMut.run(trimmed);
      onCreated(repo);
    } catch {
      /* 에러는 createMut.error 로 표시 (REPO_NAME_TAKEN 등) */
    }
  }

  return (
    <Modal title="새 저장소 만들기" onClose={onClose}>
      <p style={{ marginBottom: 12 }}>
        AWS 저장소(CodeCommit)에 새 코드 저장소를 만들어요. 만든 뒤 바로 이 앱에 연결됩니다.
      </p>
      <div className="field">
        <label htmlFor="new-repo-name">저장소 이름</label>
        <input
          id="new-repo-name"
          className="input"
          placeholder="예: customer-chatbot"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && looksValid && !createMut.loading) void submit();
          }}
        />
        <div className="hint">소문자·숫자로 시작하고 끝나요. 가운데에는 -, _, . 를 쓸 수 있어요. (예: sales-board)</div>
      </div>
      {createMut.error && <ErrorNotice error={createMut.error} />}
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          취소
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!looksValid || createMut.loading}
          onClick={submit}
        >
          {createMut.loading ? "만드는 중…" : "만들고 선택하기"}
        </button>
      </div>
    </Modal>
  );
}

// ── 단계 2: 이름·공개 범위 ──
function StepNameScheme({
  draft,
  patch,
}: {
  draft: Draft;
  patch: (p: Partial<Draft>) => void;
}): JSX.Element {
  return (
    <>
      <h3>앱 이름과 접속 범위를 정해주세요</h3>
      <div className="sub">나중에 언제든 이름은 그대로, 주소는 자동으로 만들어져요.</div>
      <div className="field">
        <label htmlFor="name">앱 이름</label>
        <input
          id="name"
          className="input"
          placeholder="예: 고객문의 챗봇"
          value={draft.name}
          onChange={(e) => {
            const name = e.target.value;
            patch({
              name,
              subdomain: draft.subdomain || toSubdomain(name) ? toSubdomain(name) : "",
            });
          }}
        />
      </div>
      <div className="field">
        <label htmlFor="subdomain">접속 주소</label>
        <div className="row" style={{ gap: 4 }}>
          <input
            id="subdomain"
            className="input"
            style={{ maxWidth: 260 }}
            value={draft.subdomain}
            onChange={(e) => patch({ subdomain: toSubdomain(e.target.value) })}
          />
          <span className="mono muted">.apps.회사도메인</span>
        </div>
        <div className="hint">소문자·숫자·하이픈, 3~40자. 회사 안에서 유일한 주소여야 해요.</div>
      </div>

      <div className="field">
        <label>이 앱은 어디에서 접속할 수 있나요?</label>
        <div className="choice-row">
          {(["internal", "internet-facing"] as Scheme[]).map((s) => (
            <button
              key={s}
              type="button"
              className={`choice ${draft.scheme === s ? "sel" : ""}`}
              onClick={() => patch({ scheme: s })}
            >
              <div className="ico">
                {s === "internal" ? (
                  <Building2 size={22} className="icon" />
                ) : (
                  <Globe size={22} className="icon" />
                )}
              </div>
              <div className="t">
                {SCHEME_LABEL[s]}
                {s === "internal" ? " (권장)" : ""}
              </div>
              <div className="d">{SCHEME_DESC[s]}</div>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

// ── 단계 3: 크기 ──
function StepSize({
  draft,
  patch,
  presets,
}: {
  draft: Draft;
  patch: (p: Partial<Draft>) => void;
  presets: ComputePreset[];
}): JSX.Element {
  return (
    <>
      <h3>앱을 얼마나 크게 돌릴까요?</h3>
      <div className="sub">사용량에 맞춰 관리자가 준비한 크기 중에서 고르세요. 나중에 관리자에게 변경을 요청할 수 있어요.</div>
      <div className="choice-row" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>
        {presets.map((p) => (
          <button
            key={p.presetId}
            type="button"
            className={`choice ${draft.presetId === p.presetId ? "sel" : ""}`}
            onClick={() => patch({ presetId: p.presetId })}
          >
            <div className="ico">
              <Cpu size={22} className="icon" />
            </div>
            <div className="t">{p.displayName}</div>
            <div className="d">최소 {p.minCount}대 · 최대 {p.maxCount}대까지 자동 확장</div>
          </button>
        ))}
      </div>
    </>
  );
}

// ── 단계 4: 앱 유형(권한 템플릿) ──
function StepType({
  draft,
  patch,
  perms,
}: {
  draft: Draft;
  patch: (p: Partial<Draft>) => void;
  perms: PermissionTemplate[];
}): JSX.Element {
  return (
    <>
      <h3>어떤 기능을 사용하는 앱인가요?</h3>
      <div className="sub">앱이 사용할 수 있는 기능 범위를 정해요. 잘 모르겠다면 '기본'을 고르세요.</div>
      <div className="choice-row">
        {perms.map((p) => (
          <button
            key={p.permId}
            type="button"
            className={`choice ${draft.permissionTemplateId === p.permId ? "sel" : ""}`}
            onClick={() => patch({ permissionTemplateId: p.permId })}
          >
            <div className="ico">
              <Rocket size={22} className="icon" />
            </div>
            <div className="t">{p.displayName}</div>
          </button>
        ))}
      </div>
    </>
  );
}

// ── 단계 5: 환경변수/시크릿 ──
function StepEnv({
  draft,
  patch,
}: {
  draft: Draft;
  patch: (p: Partial<Draft>) => void;
}): JSX.Element {
  const rows = draft.envVars;
  const update = (i: number, p: Partial<{ key: string; value: string; secret: boolean }>): void => {
    const next = rows.map((r, idx) => (idx === i ? { ...r, ...p } : r));
    patch({ envVars: next });
  };
  return (
    <>
      <h3>앱에 전달할 설정값이 있나요?</h3>
      <div className="sub">
        앱이 동작할 때 필요한 값이에요. 비밀번호·API 키 같은 민감한 값은 '비밀로 보관'을 켜면 안전하게 저장돼요. (선택)
      </div>
      <div className="stack">
        {rows.map((r, i) => (
          <div key={i} className="row" style={{ alignItems: "flex-start" }}>
            <input
              className="input"
              placeholder="이름 (예: API_KEY)"
              aria-label="설정 이름"
              value={r.key}
              onChange={(e) => update(i, { key: e.target.value })}
            />
            <input
              className="input"
              placeholder="값"
              aria-label="설정 값"
              type={r.secret ? "password" : "text"}
              value={r.value}
              onChange={(e) => update(i, { value: e.target.value })}
            />
            <button
              type="button"
              className={`btn-admin ${r.secret ? "primary" : ""}`}
              style={{ borderRadius: 12 }}
              onClick={() => update(i, { secret: !r.secret })}
              aria-pressed={r.secret}
            >
              <KeyRound size={14} className="icon" />
              {r.secret ? "비밀로 보관 중" : "비밀로 보관"}
            </button>
            <button
              type="button"
              className="row-act"
              aria-label="삭제"
              onClick={() => patch({ envVars: rows.filter((_, idx) => idx !== i) })}
            >
              <Trash2 size={16} className="icon" />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="btn btn-ghost mt3"
        onClick={() => patch({ envVars: [...rows, { key: "", value: "", secret: false }] })}
      >
        <Plus size={16} className="icon" />
        설정값 추가
      </button>
    </>
  );
}

// ── 단계 6: 가동 방식 ──
function StepSleep({
  draft,
  patch,
}: {
  draft: Draft;
  patch: (p: Partial<Draft>) => void;
}): JSX.Element {
  return (
    <>
      <h3>앱을 언제 켜둘까요?</h3>
      <div className="sub">쓰지 않을 때 잠재우면 비용을 아낄 수 있어요. 나중에 바꿀 수 있어요.</div>
      <div className="stack">
        {(["on-demand", "always-on", "schedule"] as SleepMode[]).map((m) => (
          <button
            key={m}
            type="button"
            className={`choice ${draft.sleepMode === m ? "sel" : ""}`}
            onClick={() => patch({ sleepMode: m })}
          >
            <div className="t">{SLEEP_MODE_LABEL[m]}</div>
            <div className="d">{SLEEP_MODE_DESC[m]}</div>
          </button>
        ))}
      </div>
    </>
  );
}

// ── 단계 7: Kiro 설정 안내 ──
function StepKiro({
  created,
  onDone,
}: {
  created: App | null;
  onDone: () => void;
}): JSX.Element {
  const [showGuide, setShowGuide] = useState(false);
  return (
    <>
      <h3>
        앱을 만들고 있어요
        <span style={{ marginLeft: 8 }}>
          <Rocket size={20} className="icon" style={{ color: "var(--primary)" }} />
        </span>
      </h3>
      <div className="sub">
        {created ? `'${created.name}' 앱을 준비하고 있어요.` : "앱을 준비하고 있어요."} 준비되면 대시보드에서
        '준비됨'으로 바뀌어요.
      </div>

      <InfoNotice>
        배포가 성공하려면 코드 저장소에 <b>배포 표준(Dockerfile · 8080 포트 · /health 응답)</b>이 갖춰져 있어야 해요.
        아직이라면 Kiro에게 <b>'이 앱을 배포 표준에 맞게 준비해줘'</b>라고 요청한 뒤 코드를 push 하세요.
      </InfoNotice>

      <div className="row mt4">
        <button type="button" className="btn btn-ghost" onClick={() => setShowGuide(true)}>
          <Download size={16} className="icon" />
          Kiro 설정 안내 보기
        </button>
        <button type="button" className="btn btn-primary" onClick={onDone}>
          앱 상세로 이동
          <ArrowRight size={16} className="icon" />
        </button>
      </div>

      {showGuide && (
        <Modal title="Kiro 설정 안내" onClose={() => setShowGuide(false)}>
          <p>
            아래 내용을 Kiro에게 요청하면 배포 표준에 맞는 설정 파일을 자동으로 만들어줘요. 이미 갖춰져 있다면 그대로 push
            하면 됩니다.
          </p>
          <div className="log-viewer" style={{ maxHeight: 200 }}>
            <div className="log-line">
              이 앱을 AppHub 배포 표준에 맞게 준비해줘:{"\n"}
              - Dockerfile 추가 (8080 포트 EXPOSE){"\n"}
              - /health 경로에 200 응답 추가{"\n"}
              - non-root 사용자로 실행
            </div>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={() => setShowGuide(false)}>
              확인
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
