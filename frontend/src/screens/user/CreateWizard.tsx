/**
 * 앱 생성 마법사 (7단계) — DESIGN 6장:
 *  1 저장소 연결 → 2 이름·공개 범위 → 3 크기 → 4 앱 유형 → 5 환경변수/시크릿
 *  → 6 가동 방식 → 7 Kiro 설정 안내.
 * AWS 용어 노출 금지. 마지막 단계 "만들기"에서만 POST /apps 호출(계약).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
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
import { BackLink, ErrorNotice, InfoNotice, Skeleton, Toggle, TopBar } from "../../components/common.js";
import {
  DEFAULT_SCHEDULE,
  ScheduleEditor,
  isScheduleValid,
} from "../../components/ScheduleEditor.js";
import { NewRepoModal } from "../../components/RepoManager.js";
import { useApi, useMutation, useQuery, type QueryResult } from "../../lib/ApiProvider.js";
import { useNavigate } from "../../lib/router.js";
import { useAuth } from "../../auth/AuthContext.js";
import { appsDomainLabel } from "../../lib/config.js";
import { sessionInitial } from "../../auth/tokens.js";
import type {
  App,
  CodeCommitRepo,
  ComputePreset,
  CreateAppRequest,
  Provider,
  RepoConnection,
  Schedule,
  Scheme,
  SleepMode,
  SubdomainCheck,
  UserPermissionTemplate,
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
  schedule: Schedule;
  autoDeployEnabled: boolean;
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
  // 기본 시간표(평일 09:00–19:00)를 미리 담아둔다 — "시간표대로" 선택 시 즉시 편집 가능.
  schedule: DEFAULT_SCHEDULE,
  // 대부분 사용자는 자동 배포를 원함 — 기본 켜짐(계약 기본값과 일치).
  autoDeployEnabled: true,
};

// 저장소 종류 표시 우선순위 — AWS 저장소(CodeCommit)를 항상 먼저. 나머지는 기존 순서 유지.
const PROVIDER_RANK: Record<Provider, number> = { codecommit: 0, github: 1, gitlab: 2 };
function providerRank(p: Provider): number {
  return PROVIDER_RANK[p];
}

// 이름 → 자동 서브도메인 생성: 완전 정리(앞뒤 하이픈 트림 포함). 이름은 임의 문자라 공백을 하이픈으로.
function toSubdomain(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// 접속 주소 직접 입력 중(onChange): 소문자화 + 허용문자(a-z0-9-)만 + 40자 제한.
// 앞 하이픈만 즉시 차단(시작 문자 규칙). 끝 하이픈·연속 하이픈은 남겨두어 "my-app" 타이핑을 방해하지 않는다.
// 앞/뒤 트림은 blur·제출 직전에만(sanitizeSubdomain).
function subdomainTyping(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/^-+/, "")
    .slice(0, 40);
}

// blur·제출 직전 최종 정리: 앞뒤 하이픈 제거 + 연속 하이픈을 하나로.
function sanitizeSubdomain(value: string): string {
  return value
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// ── 버그 2: 서브도메인 실시간 중복/형식 확인 (디바운스 500ms) ──
// state: idle(3자 미만·미입력) | checking(확인 중) | available(사용 가능)
//        | taken(이미 사용 중) | invalid(형식/예약어) | error(확인 실패)
type SubCheckState = "idle" | "checking" | "available" | "taken" | "invalid" | "error";
interface SubCheckResult {
  state: SubCheckState;
  /** blur 시 트림된 최종값으로 디바운스 없이 즉시 재확인한다. */
  check: (value: string) => void;
}
const SUBDOMAIN_DEBOUNCE_MS = 500;

function useSubdomainCheck(value: string): { state: SubCheckState } & SubCheckResult {
  const api = useApi();
  const [state, setState] = useState<SubCheckState>("idle");
  // 마지막으로 요청한 값을 추적해 응답 경합(stale response)을 무시한다.
  const latestRef = useRef<string>("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = (raw: string): void => {
    const v = raw.trim();
    latestRef.current = v;
    if (v.length < 3) {
      setState("idle");
      return;
    }
    setState("checking");
    api
      .checkSubdomain(v)
      .then((res: SubdomainCheck) => {
        if (latestRef.current !== v) return; // 더 최신 입력이 있으면 버린다
        if (res.available) setState("available");
        else setState(res.reason === "TAKEN" ? "taken" : "invalid");
      })
      .catch(() => {
        if (latestRef.current !== v) return;
        setState("error");
      });
  };
  const runRef = useRef(run);
  runRef.current = run;

  // 입력값 변화 → 디바운스 후 확인. 3자 미만이면 즉시 idle.
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const v = value.trim();
    if (v.length < 3) {
      latestRef.current = v;
      setState("idle");
      return;
    }
    setState("checking");
    timerRef.current = setTimeout(() => runRef.current(value), SUBDOMAIN_DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [value]);

  // blur 시 트림된 최종값으로 즉시(디바운스 없이) 재확인하기 위한 진입점.
  const check = (v: string): void => {
    if (timerRef.current) clearTimeout(timerRef.current);
    runRef.current(v);
  };

  return { state, check };
}

export function CreateWizard(): JSX.Element {
  const nav = useNavigate();
  const { session, logout } = useAuth();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [created, setCreated] = useState<App | null>(null);

  const conns = useQuery<RepoConnection[]>((a) => a.listConnections(), []);
  // 버그 3: 관리자 엔드포인트(403) 대신 user용 /presets, /permission-templates 사용.
  // 오류를 catch로 삼키지 않고 그대로 노출한다(원인 파악 가능).
  const presets = useQuery<ComputePreset[]>((a) => a.listPresets(), []);
  const perms = useQuery<UserPermissionTemplate[]>((a) => a.listPermTemplates(), []);
  const createMut = useMutation<CreateAppRequest, App>((a, body) => a.createApp(body));

  // 버그 2: 서브도메인 실시간 중복/형식 확인 (디바운스 500ms).
  const subCheck = useSubdomainCheck(draft.subdomain);

  const patch = (p: Partial<Draft>): void => setDraft((d) => ({ ...d, ...p }));

  const canNext = useMemo<boolean>(() => {
    switch (step) {
      case 0:
        return !!draft.provider && !!draft.repoUrl;
      case 1:
        // 이름 + 3자 이상 + 중복확인이 "사용 가능"이어야 다음.
        // TAKEN/INVALID/확인 중이면 막는다. (네트워크는 플랫폼 자동 배치라 선택 단계 없음.)
        return (
          draft.name.trim().length > 0 &&
          draft.subdomain.length >= 3 &&
          subCheck.state === "available"
        );
      case 2:
        return !!draft.presetId;
      case 3:
        return !!draft.permissionTemplateId;
      case 4:
        return true; // 환경변수는 선택
      case 5:
        // "시간표대로"면 시간표가 유효해야(요일 1개↑, 시각 형식) 앱을 만들 수 있다.
        if (draft.sleepMode === "schedule") return isScheduleValid(draft.schedule);
        return !!draft.sleepMode;
      default:
        return true;
    }
  }, [step, draft, subCheck.state]);

  async function submit(): Promise<void> {
    // ④ 시크릿 분리: '비밀로 보관'(secret=true) 항목은 secrets 로, 나머지는 envVars(평문)로 나눠 보낸다.
    const envVars: Record<string, string> = {};
    const secrets: Record<string, string> = {};
    for (const e of draft.envVars) {
      if (!e.key) continue;
      if (e.secret) secrets[e.key] = e.value;
      else envVars[e.key] = e.value;
    }
    const body: CreateAppRequest = {
      name: draft.name.trim(),
      subdomain: sanitizeSubdomain(draft.subdomain), // 제출 직전 앞뒤/연속 하이픈 최종 정리
      provider: draft.provider!,
      repoUrl: draft.repoUrl,
      branch: draft.branch || "main",
      ...(draft.connection ? { connectionId: draft.connection.connId } : {}),
      presetId: draft.presetId,
      permissionTemplateId: draft.permissionTemplateId,
      scheme: draft.scheme,
      // 네트워크(VPC)는 플랫폼이 자동 배치 — vpcId 를 보내지 않는다(계약: optional).
      autoDeployEnabled: draft.autoDeployEnabled,
      sleepMode: draft.sleepMode,
      // "시간표대로"일 때만 schedule 을 포함(계약: sleepMode="schedule"이면 필수).
      ...(draft.sleepMode === "schedule" ? { schedule: draft.schedule } : {}),
      envVars,
      // 비밀값이 하나라도 있으면 secrets 로 함께 전송.
      ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
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
                {/* 좁은 화면에서는 현재 단계 이름만 보이고 나머지는 번호만(CSS) */}
                <span className="step-label">{label}</span>
              </span>
              {i < STEP_LABELS.length - 1 && <span className="line" />}
            </span>
          ))}
        </div>

        {createMut.error && <ErrorNotice error={createMut.error} />}

        {step === 0 && (
          <StepRepo draft={draft} patch={patch} conns={conns.data ?? []} />
        )}
        {step === 1 && (
          <StepNameScheme draft={draft} patch={patch} subCheck={subCheck} />
        )}
        {step === 2 && <StepSize draft={draft} patch={patch} presets={presets} />}
        {step === 3 && <StepType draft={draft} patch={patch} perms={perms} />}
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
  // AWS 저장소(CodeCommit)를 먼저 보여준다 — 바로 사용 가능하므로 비개발자에게 권장.
  // 그 외에는 기존 순서 유지(안정 정렬).
  const available = conns
    .filter((c) => c.status === "AVAILABLE")
    .sort((a, b) => providerRank(a.provider) - providerRank(b.provider));
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
        <NewRepoModal
          connId={connId}
          onClose={() => setCreating(false)}
          onCreated={onRepoCreated}
          intro="AWS 저장소(CodeCommit)에 새 코드 저장소를 만들어요. 만든 뒤 바로 이 앱에 연결됩니다."
          confirmLabel="만들고 선택하기"
        />
      )}
    </div>
  );
}

// 접속 주소 확인 상태 표시 — 확인 중 스피너, 사용 가능(초록 Check), 중복/형식(빨강), 확인 실패.
// 이모지 금지: 체크 표시는 Lucide Check.
function SubdomainStatus({ state }: { state: SubCheckState }): JSX.Element | null {
  if (state === "idle") return null;
  if (state === "checking") {
    return (
      <div className="hint row" role="status" style={{ gap: 6, marginTop: 4 }}>
        <Loader2 size={14} className="icon spin" />
        주소를 확인하고 있어요…
      </div>
    );
  }
  if (state === "available") {
    return (
      <div
        className="hint row"
        role="status"
        style={{ gap: 6, marginTop: 4, color: "var(--success, #1f9d55)" }}
      >
        <Check size={14} className="icon" />
        사용할 수 있는 주소예요
      </div>
    );
  }
  const msg =
    state === "taken"
      ? "이미 사용 중인 주소예요"
      : state === "invalid"
        ? "이 주소는 쓸 수 없어요. 소문자·숫자·하이픈으로 3~40자, 하이픈으로 시작·끝나지 않게 정해주세요."
        : "주소를 확인하지 못했어요. 잠시 후 다시 시도해주세요.";
  return (
    <div
      className="hint row"
      role="alert"
      style={{ gap: 6, marginTop: 4, color: "var(--error)" }}
    >
      <AlertTriangle size={14} className="icon" />
      {msg}
    </div>
  );
}

// ── 단계 2: 이름·공개 범위 ──
// 네트워크(VPC)는 플랫폼이 자동 배치하므로 이 단계에서 별도 선택 UI가 없다(비개발자 UX — 기술 옵션 최소화).
function StepNameScheme({
  draft,
  patch,
  subCheck,
}: {
  draft: Draft;
  patch: (p: Partial<Draft>) => void;
  subCheck: { state: SubCheckState; check: (v: string) => void };
}): JSX.Element {
  // 사용자가 접속 주소를 직접 손댔는지 추적 — 손대기 전까지만 이름에서 자동 생성한다.
  const [subTouched, setSubTouched] = useState(draft.subdomain.length > 0);

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
            // 사용자가 접속 주소를 직접 만지기 전에는 이름에서 자동 생성(완전 정리 유지).
            patch(subTouched ? { name } : { name, subdomain: toSubdomain(name) });
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
            onChange={(e) => {
              setSubTouched(true);
              // 입력 중에는 소문자·허용문자·40자 제한만(끝/연속 하이픈 보존).
              patch({ subdomain: subdomainTyping(e.target.value) });
            }}
            onBlur={() => {
              // 포커스 아웃 시에만 앞뒤/연속 하이픈 최종 정리 후 그 값으로 재확인.
              const finalValue = sanitizeSubdomain(draft.subdomain);
              if (finalValue !== draft.subdomain) patch({ subdomain: finalValue });
              subCheck.check(finalValue);
            }}
          />
          <span className="mono muted">.{appsDomainLabel()}</span>
        </div>
        <SubdomainStatus state={subCheck.state} />
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
// 버그 3: user용 /presets 사용. 로딩·에러를 삼키지 않고 표시하고, 목록이 비면
// "관리자가 아직 크기를 준비하지 않았어요" 안내(다음 비활성 사유가 보이게).
function StepSize({
  draft,
  patch,
  presets,
}: {
  draft: Draft;
  patch: (p: Partial<Draft>) => void;
  presets: QueryResult<ComputePreset[]>;
}): JSX.Element {
  const items = presets.data ?? [];
  return (
    <>
      <h3>앱을 얼마나 크게 돌릴까요?</h3>
      <div className="sub">사용량에 맞춰 관리자가 준비한 크기 중에서 고르세요. 나중에 관리자에게 변경을 요청할 수 있어요.</div>
      {presets.error ? (
        <ErrorNotice error={presets.error} />
      ) : presets.loading ? (
        <Skeleton height={90} count={3} />
      ) : items.length === 0 ? (
        <InfoNotice>
          관리자가 아직 크기를 준비하지 않았어요. 관리자에게 문의해주세요.
        </InfoNotice>
      ) : (
        <div className="choice-row" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>
          {items.map((p) => (
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
      )}
    </>
  );
}

// ── 단계 4: 앱 유형(권한 템플릿) ──
// 버그 3: user용 /permission-templates 사용(policyDocument 없음). 로딩·에러·빈목록 처리.
function StepType({
  draft,
  patch,
  perms,
}: {
  draft: Draft;
  patch: (p: Partial<Draft>) => void;
  perms: QueryResult<UserPermissionTemplate[]>;
}): JSX.Element {
  const items = perms.data ?? [];
  return (
    <>
      <h3>어떤 기능을 사용하는 앱인가요?</h3>
      <div className="sub">앱이 사용할 수 있는 기능 범위를 정해요. 잘 모르겠다면 '기본'을 고르세요.</div>
      {perms.error ? (
        <ErrorNotice error={perms.error} />
      ) : perms.loading ? (
        <Skeleton height={70} count={2} />
      ) : items.length === 0 ? (
        <InfoNotice>
          관리자가 아직 앱 유형을 준비하지 않았어요. 관리자에게 문의해주세요.
        </InfoNotice>
      ) : (
        <div className="choice-row">
          {items.map((p) => (
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
      )}
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
          <div key={i} className="row kv-row" style={{ alignItems: "flex-start" }}>
            <input
              className="input kv-key"
              placeholder="이름 (예: API_KEY)"
              aria-label="설정 이름"
              value={r.key}
              onChange={(e) => update(i, { key: e.target.value })}
            />
            <input
              className="input kv-value"
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
      {/* "시간표대로" 선택 시 시간표 입력 영역을 바로 아래에 노출. */}
      {draft.sleepMode === "schedule" && (
        <ScheduleEditor value={draft.schedule} onChange={(schedule) => patch({ schedule })} />
      )}

      {/* 자동 배포 — 잠자기 방식과 다른 결정이라 여백으로 구분해 아래에 둔다.
          상단 구분선 + 소제목으로 별도 설정 그룹임을 알린다.
          문구/컴포넌트는 앱 상세 '배포·접근' 설정과 동일하게 맞춘다. */}
      <div className="mt4" style={{ borderTop: "1px solid var(--border)", paddingTop: 16 }}>
        <div className="switch-row">
          <div className="txt">
            <div className="t">자동 배포</div>
            <div className="d">
              켜면 코드를 올릴(push) 때마다 자동으로 다시 배포돼요. 끄면 원할 때 앱 상세에서 직접
              배포해요.
            </div>
          </div>
          <Toggle
            on={draft.autoDeployEnabled}
            onChange={(v) => patch({ autoDeployEnabled: v })}
            label="자동 배포"
          />
        </div>
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
  const nav = useNavigate();
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
        <button type="button" className="btn btn-ghost" onClick={() => nav("/kiro-setup")}>
          <Download size={16} className="icon" />
          Kiro 설정 안내 보기
        </button>
        <button type="button" className="btn btn-primary" onClick={onDone}>
          앱 상세로 이동
          <ArrowRight size={16} className="icon" />
        </button>
      </div>
    </>
  );
}
