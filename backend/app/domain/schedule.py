"""가동 스케줄 창 판정 (DESIGN 3.5 — "[재중지] 스케줄 밖 시간대에 한해").

App.schedule 형식(validate._parse_schedule 와 동일, app-runtime.ts Scheduler cron 의 원천):
  {"startTime": "HH:MM", "stopTime": "HH:MM", "days": [0..6], "timezone": "Asia/Seoul"}
  - days: 0=일요일 … 6=토요일 (Scheduler cron 은 d+1 → 1=SUN … 7=SAT)
  - startTime/stopTime: 해당 timezone 의 벽시계 시각

창 정의: days 에 든 요일의 startTime 에 열리고 stopTime 에 닫힌다 — 반열린 구간 [start, stop).
  - stop <= start 인 경우(예: 22:00–06:00)는 자정을 넘겨 **다음 날** stopTime 에 닫힌다.
    시작 요일만 days 에 있으면 된다(월 22:00 시작 → 화 06:00 종료).
  - start == stop 은 해당 요일 24시간 창으로 본다(보수적 — 깨어 있으라는 보장 쪽).
판정 실패(schedule 없음·형식 오류·알 수 없는 timezone)는 False(창 밖) — 기존 동작(유휴 재중지) 유지.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

_DEFAULT_TZ = "Asia/Seoul"
# tzdata 가 없는 런타임 대비 — 기본 timezone 만 고정 오프셋으로 폴백(서울은 DST 없음).
_FIXED_FALLBACK = {"Asia/Seoul": timezone(timedelta(hours=9))}


def _minutes(value: Any) -> int | None:
    if not isinstance(value, str) or len(value) != 5 or value[2] != ":":
        return None
    try:
        hh, mm = int(value[:2]), int(value[3:])
    except ValueError:
        return None
    if not (0 <= hh <= 23 and 0 <= mm <= 59):
        return None
    return hh * 60 + mm


def _tz(name: Any) -> Any:
    tz_name = name if isinstance(name, str) and name else _DEFAULT_TZ
    try:
        return ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError):
        return _FIXED_FALLBACK.get(tz_name)


def is_within_schedule_window(app: dict[str, Any], now: datetime) -> bool:
    """sleepMode=schedule 앱이 `now`(tz-aware) 시점에 가동 시간대 안이면 True. 그 외 모드는 False."""
    if app.get("sleepMode") != "schedule":
        return False
    sched = app.get("schedule")
    if not isinstance(sched, dict):
        return False
    start = _minutes(sched.get("startTime"))
    stop = _minutes(sched.get("stopTime"))
    if start is None or stop is None:
        return False
    try:
        days = {int(d) for d in sched.get("days") or []}  # DDB 는 Decimal 로 돌려준다
    except (TypeError, ValueError):
        return False
    tz = _tz(sched.get("timezone"))
    if tz is None or not days:
        return False

    local = now.astimezone(tz)
    dow = (local.weekday() + 1) % 7  # Python 월=0 → 규약 일=0
    prev_dow = (dow - 1) % 7
    cur = local.hour * 60 + local.minute

    if start == stop:
        return dow in days
    if start < stop:
        return dow in days and start <= cur < stop
    # 자정 넘김: 오늘 start 이후(오늘 시작분) 또는 어제 시작분의 stop 이전.
    return (dow in days and cur >= start) or (prev_dow in days and cur < stop)
