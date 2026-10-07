/**
 * 관리자 삭제 확인 모달 — 프리셋·권한 템플릿 공용.
 * 확인 후 삭제를 호출하고, 성공하면 onDeleted(목록 갱신 + 닫기).
 * 실패(예: 409 IN_USE — 사용 중인 앱 있음)하면 서버 message 를 모달 안에 보여주고 목록은 건드리지 않는다.
 */
import { Trash2 } from "lucide-react";
import { ErrorNotice, Modal } from "../../components/common.js";
import { useMutation } from "../../lib/ApiProvider.js";
import type { ApiClient } from "../../lib/api.js";

export function ConfirmDeleteModal({
  title,
  targetName,
  onConfirm,
  onClose,
  onDeleted,
}: {
  title: string;
  targetName: string;
  onConfirm: (api: ApiClient) => Promise<void>;
  onClose: () => void;
  onDeleted: () => void;
}): JSX.Element {
  const delMut = useMutation<void, void>((api) => onConfirm(api));
  const { error, loading: busy } = delMut;

  async function confirm(): Promise<void> {
    try {
      await delMut.run();
      onDeleted();
    } catch {
      /* 에러는 모달 안에 표시 — 목록은 그대로 둔다 */
    }
  }

  return (
    <Modal title={title} onClose={onClose} sharp>
      <p>
        <b>{targetName}</b>을(를) 삭제합니다. 이 작업은 되돌릴 수 없어요. 사용 중인 앱이 있으면 삭제되지 않아요.
      </p>
      {error && (
        <div className="mt3">
          <ErrorNotice error={error} />
        </div>
      )}
      <div className="modal-actions">
        <button type="button" className="btn-admin" onClick={onClose}>
          취소
        </button>
        <button type="button" className="btn-admin danger" disabled={busy} onClick={() => void confirm()}>
          <Trash2 size={14} className="icon" />
          {busy ? "삭제 중…" : "삭제"}
        </button>
      </div>
    </Modal>
  );
}
