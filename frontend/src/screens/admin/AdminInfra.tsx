/**
 * 관리자 인프라 현황 — ALB 레지스트리(규칙 사용량). 도메인/인증서 상태는 계약에 조회 API가 없어 표시 생략.
 * GET /admin/alb-registry (계약).
 */
import { AlertTriangle } from "lucide-react";
import { ErrorNotice, Skeleton } from "../../components/common.js";
import { useQuery } from "../../lib/ApiProvider.js";
import type { AlbRegistry } from "../../lib/types.js";

const RULE_LIMIT = 100; // DESIGN 3.4: 리스너 규칙 쿼터 100, 90 임박 시 증설

export function AdminInfra(): JSX.Element {
  const { data, loading, error } = useQuery<AlbRegistry[]>((a) => a.adminAlbRegistry(), []);

  if (error) return <ErrorNotice error={error} />;
  if (loading) return <Skeleton height={44} count={2} />;

  return (
    <>
      <h4 style={{ marginBottom: 12 }}>로드밸런서 규칙 사용량</h4>
      <p className="muted" style={{ fontSize: 13, marginBottom: 16 }}>
        규칙 수가 {RULE_LIMIT - 10}개를 넘으면 새 로드밸런서가 자동 증설됩니다. 기존 앱은 이동하지 않습니다.
      </p>
      <table>
        <thead>
          <tr>
            <th>ALB</th>
            <th>scheme</th>
            <th>VPC</th>
            <th>규칙 사용량</th>
            <th>상태</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((alb) => {
            const pct = Math.round((alb.ruleCount / RULE_LIMIT) * 100);
            const near = alb.ruleCount >= RULE_LIMIT - 10;
            return (
              <tr key={alb.albArn}>
                <td className="mono">{alb.albArn.split("/").pop() ?? alb.albArn}</td>
                <td>{alb.scheme}</td>
                <td className="mono">{alb.vpcId}</td>
                <td>
                  <div className="row" style={{ gap: 8 }}>
                    <div
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
                      {alb.ruleCount} / {RULE_LIMIT}
                    </span>
                  </div>
                </td>
                <td>
                  {near ? (
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
          })}
          {(!data || data.length === 0) && (
            <tr>
              <td colSpan={5} style={{ textAlign: "center", padding: 32 }} className="muted">
                등록된 로드밸런서가 없습니다.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
