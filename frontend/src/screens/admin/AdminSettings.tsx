/**
 * 관리자 플랫폼 설정 — provider 활성화, VPC 등록, internet-facing 허용,
 * 베이스 이미지 허용 목록, 사용자당 앱 쿼터, 로그 보존 기간.
 * GET /admin/settings, PUT /admin/settings (계약).
 */
import { useEffect, useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { ErrorNotice, Skeleton, Toggle, relTime } from "../../components/common.js";
import { useMutation, useQuery } from "../../lib/ApiProvider.js";
import type { AdminSettings } from "../../lib/types.js";

const ALL_PROVIDERS = ["codecommit", "github", "gitlab"];

export function AdminSettingsTab(): JSX.Element {
  const { data, loading, error } = useQuery<AdminSettings>((a) => a.adminGetSettings(), []);
  const [form, setForm] = useState<AdminSettings | null>(null);
  const saveMut = useMutation<Omit<AdminSettings, "updatedAt">, AdminSettings>((a, b) =>
    a.adminPutSettings(b),
  );

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  if (error) return <ErrorNotice error={error} />;
  if (loading || !form) return <Skeleton height={60} count={4} />;

  const patch = (p: Partial<AdminSettings>): void => setForm((f) => (f ? { ...f, ...p } : f));

  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <section>
        <h4 style={{ marginBottom: 12 }}>소스 제공자 활성화</h4>
        {ALL_PROVIDERS.map((p) => (
          <div key={p} className="switch-row">
            <div className="txt">
              <div className="t">{p}</div>
            </div>
            <Toggle
              on={form.enabledProviders.includes(p)}
              label={`${p} 활성화`}
              onChange={(on) =>
                patch({
                  enabledProviders: on
                    ? [...form.enabledProviders, p]
                    : form.enabledProviders.filter((x) => x !== p),
                })
              }
            />
          </div>
        ))}
      </section>

      <section style={{ marginTop: 8 }}>
        <div className="switch-row">
          <div className="txt">
            <div className="t">internet-facing 앱 허용</div>
            <div className="d">사용자가 앱을 인터넷에 공개할 수 있도록 허용합니다.</div>
          </div>
          <Toggle
            on={form.allowInternetFacing}
            label="internet-facing 허용"
            onChange={(on) => patch({ allowInternetFacing: on })}
          />
        </div>
      </section>

      <section className="grid-2" style={{ marginTop: 8 }}>
        <div className="field">
          <label htmlFor="quota">사용자당 앱 쿼터</label>
          <input
            id="quota"
            className="input"
            type="number"
            min={1}
            value={form.userAppQuota}
            onChange={(e) => patch({ userAppQuota: Number(e.target.value) })}
          />
        </div>
        <div className="field">
          <label htmlFor="retention">로그 보존 기간 (일)</label>
          <input
            id="retention"
            className="input"
            type="number"
            min={1}
            value={form.logRetentionDays}
            onChange={(e) => patch({ logRetentionDays: Number(e.target.value) })}
          />
        </div>
      </section>

      <section>
        <h4 style={{ marginBottom: 12 }}>등록된 VPC</h4>
        {form.registeredVpcs.map((v, i) => (
          <div key={i} className="row" style={{ marginBottom: 8 }}>
            <input
              className="input"
              placeholder="vpc-xxxx"
              value={v.vpcId}
              onChange={(e) =>
                patch({
                  registeredVpcs: form.registeredVpcs.map((x, idx) =>
                    idx === i ? { ...x, vpcId: e.target.value } : x,
                  ),
                })
              }
            />
            <input
              className="input"
              placeholder="라벨"
              value={v.label}
              onChange={(e) =>
                patch({
                  registeredVpcs: form.registeredVpcs.map((x, idx) =>
                    idx === i ? { ...x, label: e.target.value } : x,
                  ),
                })
              }
            />
            <button
              type="button"
              className="row-act"
              aria-label="VPC 삭제"
              onClick={() =>
                patch({ registeredVpcs: form.registeredVpcs.filter((_, idx) => idx !== i) })
              }
            >
              <Trash2 size={16} className="icon" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn-admin"
          onClick={() => patch({ registeredVpcs: [...form.registeredVpcs, { vpcId: "", label: "" }] })}
        >
          <Plus size={14} className="icon" />
          VPC 추가
        </button>
      </section>

      <section>
        <h4 style={{ marginBottom: 8 }}>허용 베이스 이미지</h4>
        <textarea
          className="textarea"
          style={{ minHeight: 90 }}
          value={form.allowedBaseImages.join("\n")}
          onChange={(e) =>
            patch({ allowedBaseImages: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })
          }
          aria-label="허용 베이스 이미지 (줄바꿈 구분)"
        />
        <div className="hint">줄바꿈으로 구분. Dockerfile FROM 검증에 사용됩니다.</div>
      </section>

      {saveMut.error && <ErrorNotice error={saveMut.error} />}
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="muted" style={{ fontSize: 12 }}>
          {form.updatedAt ? `마지막 저장: ${relTime(form.updatedAt)}` : ""}
        </span>
        <button
          type="button"
          className="btn-admin primary"
          disabled={saveMut.loading}
          onClick={() => {
            const { updatedAt: _drop, ...body } = form;
            void _drop;
            saveMut.run(body).catch(() => undefined);
          }}
        >
          <Save size={14} className="icon" />
          {saveMut.loading ? "저장 중…" : "설정 저장"}
        </button>
      </div>
    </div>
  );
}
