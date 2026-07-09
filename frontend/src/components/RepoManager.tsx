/**
 * AWS 저장소(CodeCommit) 레포 공통 소품 — 앱 생성 마법사와 저장소 연결 관리에서 함께 쓴다.
 *  - NewRepoModal: 새 레포 만들기(접두어 칩 미리보기 + base 이름 규칙 검증). 서버가 접두어를 붙인다.
 * 계약: body.repoName 은 base(사용자 입력). 최종 이름 = {ownerPrefix}-{base} (≤ 100자).
 * 접두어는 로그인 사용자로부터 프론트가 서버와 동일 규칙으로 미리 계산해 보여준다(입력 불가).
 */
import { useMemo, useState } from "react";
import { ErrorNotice, Modal } from "./common.js";
import { useMutation } from "../lib/ApiProvider.js";
import { useAuth } from "../auth/AuthContext.js";
import { computeOwnerPrefix } from "../auth/tokens.js";
import type { CodeCommitRepo } from "../lib/types.js";

// 저장소 최종 이름(접두어 포함) 최대 길이 — 계약: {ownerPrefix}-{base} ≤ 100자.
export const REPO_NAME_MAX = 100;

/**
 * 새 CodeCommit 레포 만들기 모달.
 * @param connId  대상 codecommit 연결.
 * @param intro   상황에 맞는 도입 문구(마법사: "이 앱에 연결" / 연결 관리: "여기에 추가").
 * @param confirmLabel  주 버튼 라벨(마법사: "만들고 선택하기" / 연결 관리: "만들기").
 * @param onCreated  성공 시 최종명 포함 CodeCommitRepo 를 넘겨준다.
 */
export function NewRepoModal({
  connId,
  onClose,
  onCreated,
  intro,
  confirmLabel = "만들기",
}: {
  connId: string;
  onClose: () => void;
  onCreated: (repo: CodeCommitRepo) => void;
  intro?: string;
  confirmLabel?: string;
}): JSX.Element {
  const { session } = useAuth();
  const [base, setBase] = useState("");
  // 서버와 동일 규칙으로 접두어를 미리 계산(미리보기·검증용). 실제 부착은 서버가 한다.
  const ownerPrefix = useMemo(() => computeOwnerPrefix(session), [session]);
  // base 는 사용자가 입력하는 뒷부분. createRepo 에는 이 base 를 그대로 넘긴다(계약).
  const createMut = useMutation<string, CodeCommitRepo>((a, repoName) => a.createRepo(connId, repoName));

  const trimmed = base.trim();
  // 최종 이름 미리보기 — 접두어가 있으면 `{prefix}-{base}`, 없으면 base 그대로.
  const finalName = ownerPrefix ? `${ownerPrefix}-${trimmed}` : trimmed;

  // base 이름 규칙: 소문자·숫자로 시작·끝, 가운데 -/_/. 허용, .git 금지 (계약).
  const baseValid =
    trimmed.length > 0 && /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(trimmed) && !trimmed.endsWith(".git");
  // 전체(접두어 포함) 길이 ≤ 100자.
  const tooLong = finalName.length > REPO_NAME_MAX;
  const canSubmit = baseValid && !tooLong;

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    try {
      // 서버가 접두어를 붙이므로 base 만 전송. 응답 repoName 은 접두어 포함 최종 이름.
      const repo = await createMut.run(trimmed);
      onCreated(repo);
    } catch {
      /* 에러는 createMut.error 로 표시 (REPO_NAME_TAKEN 등) */
    }
  }

  return (
    <Modal title="새 저장소 만들기" onClose={onClose}>
      <p style={{ marginBottom: 12 }}>
        {intro ?? "AWS 저장소(CodeCommit)에 새 코드 저장소를 만들어요. 만든 뒤 바로 사용할 수 있어요."}
      </p>
      <div className="field">
        <label htmlFor="new-repo-name">저장소 이름</label>
        <div className={`input-prefixed ${tooLong ? "invalid" : ""}`}>
          {ownerPrefix && (
            <span className="input-prefix mono" aria-hidden="true">
              {ownerPrefix}-
            </span>
          )}
          <input
            id="new-repo-name"
            className="input"
            placeholder="예: customer-chatbot"
            value={base}
            autoFocus
            aria-describedby="new-repo-hint new-repo-preview"
            onChange={(e) => setBase(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSubmit && !createMut.loading) void submit();
            }}
          />
        </div>
        <div id="new-repo-hint" className="hint">
          저장소 이름 앞에 내 아이디가 자동으로 붙어요. 소문자·숫자로 시작하고 끝나요. 가운데에는 -, _, . 를 쓸 수 있어요.
        </div>
        {trimmed && (
          <div id="new-repo-preview" className="repo-preview">
            만들어질 이름: <span className="mono">{finalName}</span>
          </div>
        )}
        {tooLong && (
          <div className="hint" style={{ color: "var(--error)" }} role="alert">
            이름이 너무 길어요. 전체 {REPO_NAME_MAX}자 이하가 되도록 뒷부분을 줄여주세요.
          </div>
        )}
      </div>
      {createMut.error && <ErrorNotice error={createMut.error} />}
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          취소
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canSubmit || createMut.loading}
          onClick={submit}
        >
          {createMut.loading ? "만드는 중…" : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
