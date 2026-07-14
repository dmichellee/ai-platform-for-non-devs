/**
 * 관리자 권한 템플릿 CRUD — 이름 + IAM 정책 문서(JSON).
 * GET/POST/PUT/DELETE /admin/permission-templates (계약).
 */
import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { ErrorNotice, Modal, SaveBanner, Skeleton, useSaveFeedback } from "../../components/common.js";
import { useMutation, useQuery } from "../../lib/ApiProvider.js";
import type { PermissionTemplate } from "../../lib/types.js";

export function AdminPermTemplates(): JSX.Element {
  const { data, loading, error, reload } = useQuery<PermissionTemplate[]>(
    (a) => a.adminListPermTemplates(),
    [],
  );
  const [editing, setEditing] = useState<PermissionTemplate | null>(null);
  const saved = useSaveFeedback();
  const delMut = useMutation<string, void>((a, id) => a.adminDeletePermTemplate(id));

  if (error) return <ErrorNotice error={error} />;
  if (loading) return <Skeleton height={44} count={3} />;

  return (
    <>
      <div className="admin-toolbar">
        <div className="spacer" style={{ flex: 1 }} />
        <SaveBanner visible={saved.visible} />
        <button
          type="button"
          className="btn-admin primary"
          onClick={() => setEditing({ permId: "", displayName: "", policyDocument: { Version: "2012-10-17", Statement: [] } })}
        >
          <Plus size={14} className="icon" />
          템플릿 추가
        </button>
      </div>
      <table>
        <thead>
          <tr>
            <th>표시명</th>
            <th>ID</th>
            <th>정책 요약</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.map((t) => {
            const stmts = (t.policyDocument as { Statement?: unknown[] }).Statement ?? [];
            return (
              <tr key={t.permId}>
                <td style={{ fontWeight: 600 }}>{t.displayName}</td>
                <td className="mono">{t.permId}</td>
                <td className="muted">{stmts.length}개 statement</td>
                <td>
                  <div className="row">
                    <button type="button" className="row-act" aria-label="수정" onClick={() => setEditing(t)}>
                      <Pencil size={15} className="icon" />
                    </button>
                    <button
                      type="button"
                      className="row-act"
                      aria-label="삭제"
                      onClick={async () => {
                        await delMut.run(t.permId).catch(() => undefined);
                        reload();
                      }}
                    >
                      <Trash2 size={15} className="icon" />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {editing && (
        <PermModal
          template={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            saved.show();
            reload();
          }}
        />
      )}
    </>
  );
}

function PermModal({
  template,
  onClose,
  onSaved,
}: {
  template: PermissionTemplate;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const isNew = !template.permId;
  const [name, setName] = useState(template.displayName);
  const [policyText, setPolicyText] = useState(JSON.stringify(template.policyDocument, null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const createMut = useMutation<{ displayName: string; policyDocument: object }, PermissionTemplate>(
    (a, b) => a.adminCreatePermTemplate(b),
  );
  const updateMut = useMutation<{ id: string; b: { displayName?: string; policyDocument?: object } }, PermissionTemplate>(
    (a, args) => a.adminUpdatePermTemplate(args.id, args.b),
  );
  const err = createMut.error ?? updateMut.error;

  async function save(): Promise<void> {
    let doc: object;
    try {
      doc = JSON.parse(policyText) as object;
      setJsonError(null);
    } catch {
      setJsonError("정책 JSON 형식이 올바르지 않습니다.");
      return;
    }
    try {
      if (isNew) await createMut.run({ displayName: name, policyDocument: doc });
      else await updateMut.run({ id: template.permId, b: { displayName: name, policyDocument: doc } });
      onSaved();
    } catch {
      /* 에러 표시 */
    }
  }

  return (
    <Modal title={isNew ? "권한 템플릿 추가" : "권한 템플릿 수정"} onClose={onClose} sharp>
      <div className="field">
        <label htmlFor="perm-name">표시명 (사용자에게는 '앱 유형'으로 보임)</label>
        <input
          id="perm-name"
          className="input"
          placeholder="예: AI 기능 사용"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="perm-policy">IAM 정책 문서 (JSON)</label>
        <textarea
          id="perm-policy"
          className="textarea"
          value={policyText}
          onChange={(e) => setPolicyText(e.target.value)}
        />
        {jsonError && <div className="hint" style={{ color: "var(--error)" }}>{jsonError}</div>}
      </div>
      {err && <ErrorNotice error={err} />}
      <div className="modal-actions">
        <button type="button" className="btn-admin" onClick={onClose}>
          취소
        </button>
        <button
          type="button"
          className="btn-admin primary"
          disabled={!name.trim() || createMut.loading || updateMut.loading}
          onClick={save}
        >
          저장
        </button>
      </div>
    </Modal>
  );
}
