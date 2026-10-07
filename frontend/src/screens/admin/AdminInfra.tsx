/**
 * 관리자 인프라 현황 — ALB 레지스트리(D20 ALB 증설). GET /admin/alb-registry (delta §8).
 * 관리자 화면이라 기술 용어(ALB·scheme·VPC) 노출 허용(용어 사전 예외).
 *
 * - ACTIVE ALB: index·규칙 사용량(ruleCount/ruleLimit=90)·VPC.
 * - PROVISIONING: 증설 대기 항목(albArn 없음) — "증설 중" 배지.
 * - scheme별 여유(Σ(limit−ruleCount)) ≤ 10이면 플랫폼이 선제 증설한다(ALB_SCALE_OUT_SPARE).
 * 도메인/인증서 상태는 계약에 조회 API가 없어 표시 생략.
 */
import { AlertTriangle, Loader2 } from "lucide-react";
import { ErrorNotice, Skeleton } from "../../components/common.js";
import { useQuery } from "../../lib/ApiProvider.js";
import type { AlbRegistry, Scheme } from "../../lib/types.js";

/** 계약 기본값(ALB_RULE_LIMIT). 응답 ruleLimit가 있으면 그 값을 쓴다. */
const DEFAULT_RULE_LIMIT = 90;
/** 여유 규칙이 이 값 이하이면 증설(ALB_SCALE_OUT_SPARE). */
const SCALE_OUT_SPARE = 10;

const SCHEME_ORDER: Scheme[] = ["internet-facing", "internal"];

function limitOf(alb: AlbRegistry): number {
  return alb.ruleLimit > 0 ? alb.ruleLimit : DEFAULT_RULE_LIMIT;
}

/** `arn:...:loadbalancer/app/{name}/{id}` → name. 형식이 다르면 마지막 조각. */
export function albNameFromArn(arn: string): string {
  const parts = arn.split("/");
  if (parts.length >= 4 && parts[1] === "app") return parts[2]!;
  return parts.pop() ?? arn;
}

function sortRegistry(items: AlbRegistry[]): AlbRegistry[] {
  return [...items].sort((a, b) => {
    const s = SCHEME_ORDER.indexOf(a.scheme) - SCHEME_ORDER.indexOf(b.scheme);
    return s !== 0 ? s : a.index - b.index;
  });
}

export function AdminInfra(): JSX.Element {
  const { data, loading, error } = useQuery<AlbRegistry[]>((a) => a.adminAlbRegistry(), []);

  if (error) return <ErrorNotice error={error} />;
  if (loading) return <Skeleton height={44} count={2} />;

  const items = sortRegistry(data ?? []);

  return (
    <>
      <h4 style={{ marginBottom: 12 }}>로드밸런서(ALB) 규칙 사용량</h4>
      <p className="muted" style={{ fontSize: 13, marginBottom: 16 }}>
        ALB 1대에 앱 규칙을 최대 {DEFAULT_RULE_LIMIT}개까지 배정합니다. 같은 scheme의 남은 규칙이{" "}
        {SCALE_OUT_SPARE}개 이하가 되면 새 ALB가 자동 증설되고, 새 앱부터 배정됩니다. 기존 앱은 이동하지
        않습니다.
      </p>

      <SchemeSummary items={items} />

      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>scheme</th>
            <th>ALB</th>
            <th>VPC</th>
            <th>규칙 사용량</th>
            <th>상태</th>
          </tr>
        </thead>
        <tbody>
          {items.map((alb) => (
            <AlbRow key={alb.albArn ?? `pending-${alb.schemeSlug}-${alb.index}`} alb={alb} />
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={6} style={{ textAlign: "center", padding: 32 }} className="muted">
                등록된 로드밸런서가 없습니다. 첫 앱을 배포하면 기본 ALB가 등록됩니다.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

/** scheme별 ACTIVE 대수·남은 규칙 합계·증설 진행 여부 요약. */
function SchemeSummary({ items }: { items: AlbRegistry[] }): JSX.Element | null {
  const rows = SCHEME_ORDER.map((scheme) => {
    const of = items.filter((i) => i.scheme === scheme);
    const active = of.filter((i) => i.status === "ACTIVE");
    const spare = active.reduce((sum, a) => sum + Math.max(0, limitOf(a) - a.ruleCount), 0);
    const provisioning = of.some((i) => i.status === "PROVISIONING");
    return { scheme, count: active.length, spare, provisioning, any: of.length > 0 };
  }).filter((r) => r.any);
  if (rows.length === 0) return null;
  return (
    <div className="row" style={{ gap: 16, flexWrap: "wrap", marginBottom: 16 }}>
      {rows.map((r) => (
        <div key={r.scheme} className="muted" style={{ fontSize: 13 }} data-testid={`alb-summary-${r.scheme}`}>
          <b>{r.scheme}</b> · ACTIVE {r.count}대 · 남은 규칙 {r.spare}개
          {r.provisioning && " · 증설 진행 중"}
        </div>
      ))}
    </div>
  );
}

function AlbRow({ alb }: { alb: AlbRegistry }): JSX.Element {
  const limit = limitOf(alb);
  const provisioning = alb.status === "PROVISIONING";
  const pct = Math.round((alb.ruleCount / limit) * 100);
  const full = alb.ruleCount >= limit;
  const near = alb.ruleCount >= limit - SCALE_OUT_SPARE;

  return (
    <tr>
      <td className="mono">{alb.index}</td>
      <td>{alb.scheme}</td>
      <td className="mono" title={alb.albArn}>
        {alb.albArn ? albNameFromArn(alb.albArn) : <span className="muted">(생성 중)</span>}
      </td>
      <td className="mono">{alb.vpcId ?? "—"}</td>
      <td>
        {provisioning ? (
          <span className="muted">—</span>
        ) : (
          <div className="row" style={{ gap: 8 }}>
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={limit}
              aria-valuenow={alb.ruleCount}
              aria-label={`규칙 ${alb.ruleCount} / ${limit}`}
              style={{
                width: 120,
                height: 8,
                borderRadius: 999,
                background: "var(--surface-hover)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${Math.min(pct, 100)}%`,
                  height: "100%",
                  background: near ? "var(--error)" : "var(--primary)",
                }}
              />
            </div>
            <span className="mono">
              {alb.ruleCount} / {limit}
            </span>
          </div>
        )}
      </td>
      <td>
        {provisioning ? (
          <span className="pill wake">
            <Loader2 size={12} className="icon" />
            증설 중 (PROVISIONING)
          </span>
        ) : full ? (
          <span className="pill fail">
            <AlertTriangle size={12} className="icon" />
            가득 참
          </span>
        ) : near ? (
          <span className="pill fail">
            <AlertTriangle size={12} className="icon" />
            증설 임박
          </span>
        ) : (
          <span className="pill run">
            <span className="dot" />
            여유
          </span>
        )}
      </td>
    </tr>
  );
}
