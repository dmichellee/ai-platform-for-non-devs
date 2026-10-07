/**
 * 관리자 컴퓨팅 프리셋 CRUD — 이름, cpu/memory(Fargate 유효 조합), min/max, 스케일 기준.
 * GET/POST/PUT/DELETE /admin/presets (계약).
 */
import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { ErrorNotice, Modal, SaveBanner, Skeleton, useSaveFeedback } from "../../components/common.js";
import { useMutation, useQuery } from "../../lib/ApiProvider.js";
import { ConfirmDeleteModal } from "./ConfirmDeleteModal.js";
import type { ComputePreset } from "../../lib/types.js";

// Fargate 유효 조합(대표) — cpu(vCPU 단위 1024=1vCPU) → 허용 memory(MiB)
const FARGATE_COMBOS: { cpu: number; label: string; mems: number[] }[] = [
  { cpu: 256, label: "0.25 vCPU", mems: [512, 1024, 2048] },
  { cpu: 512, label: "0.5 vCPU", mems: [1024, 2048, 3072, 4096] },
  { cpu: 1024, label: "1 vCPU", mems: [2048, 3072, 4096, 5120, 6144, 7168, 8192] },
  { cpu: 2048, label: "2 vCPU", mems: [4096, 6144, 8192, 12288, 16384] },
  { cpu: 4096, label: "4 vCPU", mems: [8192, 16384, 24576, 30720] },
];

const EMPTY: ComputePreset = {
  presetId: "",
  displayName: "",
  cpu: 512,
  memory: 1024,
  minCount: 1,
  maxCount: 2,
  scaleMetric: "cpu",
  scaleThreshold: 70,
};

export function AdminPresets(): JSX.Element {
  const { data, loading, error, reload } = useQuery<ComputePreset[]>((a) => a.adminListPresets(), []);
  const [editing, setEditing] = useState<ComputePreset | null>(null);
  const saved = useSaveFeedback();
  const [deleting, setDeleting] = useState<ComputePreset | null>(null);

  if (error) return <ErrorNotice error={error} />;
  if (loading) return <Skeleton height={44} count={3} />;

  return (
    <>
      <div className="admin-toolbar">
        <div className="spacer" style={{ flex: 1 }} />
        <SaveBanner visible={saved.visible} />
        <button type="button" className="btn-admin primary" onClick={() => setEditing({ ...EMPTY })}>
          <Plus size={14} className="icon" />
          프리셋 추가
        </button>
      </div>
      <table>
        <thead>
          <tr>
            <th>표시명</th>
            <th>CPU</th>
            <th>메모리</th>
            <th>min/max</th>
            <th>스케일 기준</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.map((p) => (
            <tr key={p.presetId}>
              <td style={{ fontWeight: 600 }}>{p.displayName}</td>
              <td className="mono">{p.cpu}</td>
              <td className="mono">{p.memory} MiB</td>
              <td className="mono">
                {p.minCount} / {p.maxCount}
              </td>
              <td>
                {p.scaleMetric === "cpu" ? "CPU" : "요청 수"} {p.scaleThreshold}
                {p.scaleMetric === "cpu" ? "%" : ""}
              </td>
              <td>
                <div className="row">
                  <button type="button" className="row-act" aria-label="수정" onClick={() => setEditing(p)}>
                    <Pencil size={15} className="icon" />
                  </button>
                  <button
                    type="button"
                    className="row-act"
                    aria-label="삭제"
                    onClick={() => setDeleting(p)}
                  >
                    <Trash2 size={15} className="icon" />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {deleting && (
        <ConfirmDeleteModal
          title="프리셋을 삭제할까요?"
          targetName={deleting.displayName}
          onConfirm={(a) => a.adminDeletePreset(deleting.presetId)}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            reload();
          }}
        />
      )}

      {editing && (
        <PresetModal
          preset={editing}
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

function PresetModal({
  preset,
  onClose,
  onSaved,
}: {
  preset: ComputePreset;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [f, setF] = useState<ComputePreset>(preset);
  const isNew = !preset.presetId;
  const combo = FARGATE_COMBOS.find((c) => c.cpu === f.cpu) ?? FARGATE_COMBOS[0]!;
  const createMut = useMutation<Partial<ComputePreset>, ComputePreset>((a, b) => a.adminCreatePreset(b));
  const updateMut = useMutation<{ id: string; b: Partial<ComputePreset> }, ComputePreset>((a, args) =>
    a.adminUpdatePreset(args.id, args.b),
  );
  const err = createMut.error ?? updateMut.error;

  async function save(): Promise<void> {
    // 이슈 2: presetId 는 항상 body 에서 제거한다.
    //  - 신규(create): 계약상 키가 있으면 빈/공백은 400. 키 자체를 생략하면 서버가 자동 발급.
    //  - 수정(update): 경로의 presetId 가 정본이라 body 의 presetId 는 서버가 무시 → 보낼 필요 없음.
    const { presetId: _omit, ...body } = f;
    void _omit;
    try {
      if (isNew) await createMut.run(body);
      else await updateMut.run({ id: f.presetId, b: body });
      onSaved();
    } catch {
      /* 에러 표시 */
    }
  }

  return (
    <Modal title={isNew ? "프리셋 추가" : "프리셋 수정"} onClose={onClose} sharp>
      <div className="field">
        <label htmlFor="p-name">표시명 (사용자에게 보임)</label>
        <input
          id="p-name"
          className="input"
          placeholder="예: 보통"
          value={f.displayName}
          onChange={(e) => setF({ ...f, displayName: e.target.value })}
        />
      </div>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="p-cpu">CPU (Fargate 유효 조합)</label>
          <select
            id="p-cpu"
            className="select"
            value={f.cpu}
            onChange={(e) => {
              const cpu = Number(e.target.value);
              const c = FARGATE_COMBOS.find((x) => x.cpu === cpu)!;
              setF({ ...f, cpu, memory: c.mems.includes(f.memory) ? f.memory : c.mems[0]! });
            }}
          >
            {FARGATE_COMBOS.map((c) => (
              <option key={c.cpu} value={c.cpu}>
                {c.label} ({c.cpu})
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="p-mem">메모리 (MiB)</label>
          <select id="p-mem" className="select" value={f.memory} onChange={(e) => setF({ ...f, memory: Number(e.target.value) })}>
            {combo.mems.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="p-min">최소 대수</label>
          <input id="p-min" className="input" type="number" min={0} value={f.minCount} onChange={(e) => setF({ ...f, minCount: Number(e.target.value) })} />
        </div>
        <div className="field">
          <label htmlFor="p-max">최대 대수</label>
          <input id="p-max" className="input" type="number" min={1} value={f.maxCount} onChange={(e) => setF({ ...f, maxCount: Number(e.target.value) })} />
        </div>
      </div>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="p-metric">스케일 기준</label>
          <select id="p-metric" className="select" value={f.scaleMetric} onChange={(e) => setF({ ...f, scaleMetric: e.target.value as ComputePreset["scaleMetric"] })}>
            <option value="cpu">CPU 사용률</option>
            <option value="requests">요청 수</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="p-thr">임계값</label>
          <input id="p-thr" className="input" type="number" value={f.scaleThreshold} onChange={(e) => setF({ ...f, scaleThreshold: Number(e.target.value) })} />
        </div>
      </div>
      {err && <ErrorNotice error={err} />}
      <div className="modal-actions">
        <button type="button" className="btn-admin" onClick={onClose}>
          취소
        </button>
        <button
          type="button"
          className="btn-admin primary"
          disabled={!f.displayName.trim() || createMut.loading || updateMut.loading}
          onClick={save}
        >
          저장
        </button>
      </div>
    </Modal>
  );
}
