/**
 * 가동 시간표 입력 (sleepMode="schedule") — 마법사 6단계와 앱 상세 설정 탭에서 공용.
 * 계약 shape: schedule { startTime:"HH:MM", stopTime:"HH:MM", days:number[], timezone:string }.
 *
 * days 인덱스 규약(백엔드 validate.py `_parse_schedule` 와 정합):
 *   - 허용 범위 0~6 (0 <= d <= 6).
 *   - 0=일요일 … 6=토요일 (JS Date.getDay() 규약). 목 픽스처의 평일 표기 [1,2,3,4,5] 와 일치.
 * timezone 은 "Asia/Seoul" 고정(선택 UI 없음, 고정 표시). AWS 용어 노출 없음.
 */
import type { Schedule } from "../lib/types.js";

export const DEFAULT_TIMEZONE = "Asia/Seoul";

// 0=일 … 6=토. days 에 담기는 숫자가 곧 이 인덱스다(백엔드 규약과 동일).
const DAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

// 마법사·설정 탭 진입 시 기본값: 평일(월~금) 09:00–19:00.
export const DEFAULT_SCHEDULE: Schedule = {
  startTime: "09:00",
  stopTime: "19:00",
  days: [1, 2, 3, 4, 5],
  timezone: DEFAULT_TIMEZONE,
};

export function ScheduleEditor({
  value,
  onChange,
}: {
  value: Schedule;
  onChange: (next: Schedule) => void;
}): JSX.Element {
  const toggleDay = (day: number): void => {
    const has = value.days.includes(day);
    const days = has ? value.days.filter((d) => d !== day) : [...value.days, day].sort((a, b) => a - b);
    onChange({ ...value, days });
  };

  return (
    <div className="schedule-box">
      <div className="grid-2">
        <div className="field">
          <label htmlFor="sch-start">켜지는 시각</label>
          <input
            id="sch-start"
            className="input"
            type="time"
            value={value.startTime}
            onChange={(e) => onChange({ ...value, startTime: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="sch-stop">꺼지는 시각</label>
          <input
            id="sch-stop"
            className="input"
            type="time"
            value={value.stopTime}
            onChange={(e) => onChange({ ...value, stopTime: e.target.value })}
          />
        </div>
      </div>

      <div className="field">
        <label>가동하는 요일</label>
        <div className="day-chips" role="group" aria-label="가동 요일 선택">
          {DAY_LABELS.map((label, day) => {
            const on = value.days.includes(day);
            return (
              <button
                key={day}
                type="button"
                className={`day-chip ${on ? "on" : ""}`}
                aria-pressed={on}
                aria-label={`${label}요일`}
                onClick={() => toggleDay(day)}
              >
                {label}
              </button>
            );
          })}
        </div>
        {value.days.length === 0 && (
          <div className="hint" role="alert" style={{ color: "var(--error)" }}>
            가동할 요일을 하나 이상 골라주세요.
          </div>
        )}
      </div>

      <div className="hint">시간대는 한국 시간(Asia/Seoul) 기준이에요.</div>
    </div>
  );
}

/** schedule 값이 백엔드 검증을 통과할 형태인지(요일 1개 이상, 시각 형식) 프론트에서 사전 확인. */
export function isScheduleValid(s: Schedule | undefined): s is Schedule {
  if (!s) return false;
  const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
  return (
    timeRe.test(s.startTime) &&
    timeRe.test(s.stopTime) &&
    Array.isArray(s.days) &&
    s.days.length > 0 &&
    s.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
  );
}
