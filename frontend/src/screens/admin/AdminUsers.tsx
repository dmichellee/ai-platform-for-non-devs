/**
 * 관리자 사용자 관리 — 목록, 초대(이메일), 그룹 변경, 활성/비활성.
 * GET/POST/PATCH /admin/users (계약).
 */
import { useState } from "react";
import { Mail, UserPlus } from "lucide-react";
import { ErrorNotice, Modal, Skeleton, Toggle } from "../../components/common.js";
import { useMutation, useQuery } from "../../lib/ApiProvider.js";
import type { PlatformUser } from "../../lib/types.js";

export function AdminUsers(): JSX.Element {
  const { data, loading, error, reload } = useQuery<PlatformUser[]>((a) => a.adminListUsers(), []);
  const [invite, setInvite] = useState(false);
  const patchMut = useMutation<{ username: string; b: { group?: string; enabled?: boolean } }, { username: string }>(
    (a, args) => a.adminPatchUser(args.username, args.b),
  );

  if (error) return <ErrorNotice error={error} />;
  if (loading) return <Skeleton height={44} count={4} />;

  return (
    <>
      <div className="admin-toolbar">
        <div className="spacer" style={{ flex: 1 }} />
        <button type="button" className="btn-admin primary" onClick={() => setInvite(true)}>
          <UserPlus size={14} className="icon" />
          사용자 초대
        </button>
      </div>
      {/* 좁은 화면: 표는 이 상자 안에서만 가로 스크롤(화면 전체를 밀지 않음) */}
      <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>이메일</th>
            <th>사용자명</th>
            <th>그룹</th>
            <th>상태</th>
            <th>활성</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((u) => {
            const isAdmin = u.groups.includes("admin");
            return (
              <tr key={u.username}>
                <td style={{ fontWeight: 600 }}>{u.email}</td>
                <td className="mono">{u.username}</td>
                <td>
                  <select
                    className="select"
                    style={{ width: 120, padding: "5px 8px" }}
                    value={isAdmin ? "admin" : "user"}
                    onChange={async (e) => {
                      await patchMut.run({ username: u.username, b: { group: e.target.value } }).catch(() => undefined);
                      reload();
                    }}
                    aria-label={`${u.email} 그룹`}
                  >
                    <option value="user">user</option>
                    <option value="admin">admin</option>
                  </select>
                </td>
                <td className="mono">{u.status}</td>
                <td>
                  <Toggle
                    on={u.enabled}
                    label={`${u.email} 활성`}
                    onChange={async (on) => {
                      await patchMut.run({ username: u.username, b: { enabled: on } }).catch(() => undefined);
                      reload();
                    }}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>

      {invite && (
        <InviteModal
          onClose={() => setInvite(false)}
          onDone={() => {
            setInvite(false);
            reload();
          }}
        />
      )}
    </>
  );
}

function InviteModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }): JSX.Element {
  const [email, setEmail] = useState("");
  const [group, setGroup] = useState<"user" | "admin">("user");
  const inviteMut = useMutation<{ email: string; group: "user" | "admin" }, unknown>((a, args) =>
    a.adminInviteUser(args.email, args.group),
  );

  return (
    <Modal title="사용자 초대" onClose={onClose} sharp>
      <div className="field">
        <label htmlFor="inv-email">이메일</label>
        <div className="search" style={{ width: "100%" }}>
          <Mail size={15} className="icon" />
          <input
            id="inv-email"
            style={{ width: "100%" }}
            placeholder="name@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="hint">임시 비밀번호가 담긴 초대 메일이 발송됩니다.</div>
      </div>
      <div className="field">
        <label htmlFor="inv-group">그룹</label>
        <select id="inv-group" className="select" value={group} onChange={(e) => setGroup(e.target.value as "user" | "admin")}>
          <option value="user">user</option>
          <option value="admin">admin</option>
        </select>
      </div>
      {inviteMut.error && <ErrorNotice error={inviteMut.error} />}
      <div className="modal-actions">
        <button type="button" className="btn-admin" onClick={onClose}>
          취소
        </button>
        <button
          type="button"
          className="btn-admin primary"
          disabled={!email.includes("@") || inviteMut.loading}
          onClick={async () => {
            await inviteMut.run({ email, group }).catch(() => undefined);
            onDone();
          }}
        >
          {inviteMut.loading ? "초대 중…" : "초대 보내기"}
        </button>
      </div>
    </Modal>
  );
}
