"""QA W-1 — 가동 시간대 안의 schedule 앱은 유휴 경로(알람·스윕)로 재우지 않는다.

schedule 형식: {startTime, stopTime, days(0=일..6=토), timezone}. 창은 [start, stop), stop<=start 면 자정 넘김.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest
from app.domain.schedule import is_within_schedule_window
from app.integrations import clients as integ_clients
from app.wake import sleep

from .conftest import StubClient, seed_app

STAGE = "test"
WEEKDAYS = [1, 2, 3, 4, 5]  # 월~금


def _app(
    start: str, stop: str, days: list[int], tz: str = "Asia/Seoul", mode: str = "schedule"
) -> dict:
    return {
        "sleepMode": mode,
        "schedule": {"startTime": start, "stopTime": stop, "days": days, "timezone": tz},
    }


def _kst(y: int, mo: int, d: int, h: int, mi: int = 0) -> datetime:
    """KST 벽시계 → UTC aware(Lambda 의 now 는 UTC)."""
    from datetime import timedelta

    return datetime(y, mo, d, h, mi, tzinfo=UTC) - timedelta(hours=9)


# 2026-10-05 = 월요일, 2026-10-10 = 토요일, 2026-10-11 = 일요일.


# ── 헬퍼 ─────────────────────────────────────────────────────────────────────


def test_window_inside_and_outside_same_day() -> None:
    app = _app("09:00", "19:00", WEEKDAYS)
    assert is_within_schedule_window(app, _kst(2026, 10, 5, 9, 0)) is True  # 시작 경계 포함
    assert is_within_schedule_window(app, _kst(2026, 10, 5, 13, 30)) is True
    assert is_within_schedule_window(app, _kst(2026, 10, 5, 18, 59)) is True
    assert is_within_schedule_window(app, _kst(2026, 10, 5, 19, 0)) is False  # 종료 경계 제외
    assert is_within_schedule_window(app, _kst(2026, 10, 5, 8, 59)) is False
    assert is_within_schedule_window(app, _kst(2026, 10, 5, 23, 0)) is False


def test_window_excluded_weekday() -> None:
    app = _app("09:00", "19:00", WEEKDAYS)
    assert is_within_schedule_window(app, _kst(2026, 10, 10, 12)) is False  # 토
    assert is_within_schedule_window(app, _kst(2026, 10, 11, 12)) is False  # 일
    sunday_only = _app("09:00", "19:00", [0])
    assert is_within_schedule_window(sunday_only, _kst(2026, 10, 11, 12)) is True  # 0=일요일


def test_window_overnight() -> None:
    app = _app("22:00", "06:00", [1])  # 월 22:00 → 화 06:00
    assert is_within_schedule_window(app, _kst(2026, 10, 5, 23, 0)) is True  # 월 밤
    assert is_within_schedule_window(app, _kst(2026, 10, 6, 5, 59)) is True  # 화 새벽(전날 시작분)
    assert is_within_schedule_window(app, _kst(2026, 10, 6, 6, 0)) is False  # 화 06:00 종료
    assert (
        is_within_schedule_window(app, _kst(2026, 10, 5, 3, 0)) is False
    )  # 월 새벽(일요일 시작 없음)
    assert is_within_schedule_window(app, _kst(2026, 10, 6, 23, 0)) is False  # 화 밤(화 시작 없음)
    # 토 → 일 넘김(요일 6 → 0 랩어라운드).
    sat = _app("20:00", "02:00", [6])
    assert is_within_schedule_window(sat, _kst(2026, 10, 11, 1, 0)) is True


def test_window_timezone() -> None:
    utc_app = _app("09:00", "19:00", WEEKDAYS, tz="UTC")
    # 월 KST 10:00 = 월 UTC 01:00 → UTC 기준 창 밖.
    assert is_within_schedule_window(utc_app, _kst(2026, 10, 5, 10)) is False
    # 월 UTC 12:00 → 안.
    assert is_within_schedule_window(utc_app, datetime(2026, 10, 5, 12, tzinfo=UTC)) is True
    # 뉴욕(EDT, UTC-4): 월 UTC 22:59 = 18:59 창 안, 23:00 = 19:00 종료 경계로 밖.
    ny = _app("09:00", "19:00", WEEKDAYS, tz="America/New_York")
    assert (
        is_within_schedule_window(ny, datetime(2026, 10, 5, 22, 59, tzinfo=UTC)) is True
    )  # 18:59 EDT
    assert is_within_schedule_window(ny, datetime(2026, 10, 5, 23, 0, tzinfo=UTC)) is False


def test_window_non_schedule_or_invalid_is_outside() -> None:
    now = _kst(2026, 10, 5, 12)
    assert (
        is_within_schedule_window(_app("09:00", "19:00", WEEKDAYS, mode="on-demand"), now) is False
    )
    assert is_within_schedule_window({"sleepMode": "schedule"}, now) is False
    assert is_within_schedule_window(_app("9:00", "19:00", WEEKDAYS), now) is False
    assert (
        is_within_schedule_window(_app("09:00", "19:00", WEEKDAYS, tz="Nowhere/City"), now) is False
    )
    # DDB 숫자는 Decimal 로 온다.
    dec = _app("09:00", "19:00", [Decimal(1)])
    assert is_within_schedule_window(dec, now) is True
    # start == stop → 해당 요일 24시간.
    assert is_within_schedule_window(_app("00:00", "00:00", [1]), _kst(2026, 10, 5, 3)) is True


# ── sleep_app / handle ───────────────────────────────────────────────────────


@pytest.fixture
def frozen(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("STAGE", STAGE)

    def _set(dt: datetime) -> None:
        monkeypatch.setattr(sleep, "_now", lambda: dt)

    return _set


@pytest.fixture
def stub_effects(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """창 판정 이후의 AWS 부수효과를 대체 — ensure_stopped 호출 여부로 '재웠는가'를 본다."""
    stopped: list[str] = []

    def _stop(_st: str, app_id: str) -> dict[str, Any]:
        stopped.append(app_id)
        return {"changed": True}

    monkeypatch.setattr(sleep, "ensure_stopped", _stop)
    monkeypatch.setattr(sleep, "find_app_target_group_arn", lambda *_a: None)
    monkeypatch.setattr(sleep, "app_alb_routing", lambda *_a: {})
    monkeypatch.setattr(sleep, "network_param", lambda *_a: "apps.example.com")
    return stopped


def _seed_sched(table, app_id: str) -> None:
    seed_app(
        table,
        app_id,
        "u",
        status="ACTIVE",
        sleepMode="schedule",
        runtimeState="RUNNING",
        schedule={
            "startTime": "09:00",
            "stopTime": "19:00",
            "days": WEEKDAYS,
            "timezone": "Asia/Seoul",
        },
    )


def _alarm_event(app_id: str) -> dict:
    return {"detail": {"alarmName": f"apphub-{STAGE}-app-{app_id}-idle"}}


def test_idle_alarm_inside_window_skips(ddb_table, frozen, stub_effects) -> None:
    _seed_sched(ddb_table, "sch00001")
    frozen(_kst(2026, 10, 5, 10))
    res = sleep.handle(_alarm_event("sch00001"))
    assert res == {"appId": "sch00001", "reason": "in-schedule-window"}
    assert stub_effects == []


def test_idle_alarm_outside_window_sleeps(ddb_table, frozen, stub_effects) -> None:
    _seed_sched(ddb_table, "sch00002")
    frozen(_kst(2026, 10, 5, 21))
    res = sleep.handle(_alarm_event("sch00002"))
    assert "reason" not in res
    assert stub_effects == ["sch00002"]


def test_idle_alarm_weekend_sleeps(ddb_table, frozen, stub_effects) -> None:
    _seed_sched(ddb_table, "sch00003")
    frozen(_kst(2026, 10, 10, 12))  # 토 정오 — 요일 제외
    assert "reason" not in sleep.handle(
        {"alarmData": {"alarmName": f"apphub-{STAGE}-app-sch00003-idle"}}
    )
    assert stub_effects == ["sch00003"]


def test_schedule_stop_invoke_sleeps_even_at_or_before_boundary(
    ddb_table, frozen, stub_effects
) -> None:
    """StopSchedule 은 {"appId"} 로 직접 호출 — 창 판정을 생략해 종료 경계에서도 재운다."""
    _seed_sched(ddb_table, "sch00004")
    # Scheduler 가 18:59:59 에 발화해도(시계 오차) 스킵되지 않아야 한다.
    frozen(_kst(2026, 10, 5, 18, 59))
    res = sleep.handle({"appId": "sch00004"})
    assert "reason" not in res
    assert stub_effects == ["sch00004"]


def test_explicit_schedule_stop_trigger_flag(ddb_table, frozen, stub_effects) -> None:
    _seed_sched(ddb_table, "sch00005")
    frozen(_kst(2026, 10, 5, 12))
    assert "reason" not in sleep.handle({"appId": "sch00005", "trigger": "schedule-stop"})
    assert stub_effects == ["sch00005"]


def test_force_ignores_window(ddb_table, frozen, stub_effects) -> None:
    _seed_sched(ddb_table, "sch00006")
    frozen(_kst(2026, 10, 5, 12))
    assert "reason" not in sleep.sleep_app("sch00006", force=True)
    # 기본(유휴) 호출은 창 안이면 스킵.
    _seed_sched(ddb_table, "sch00007")
    assert sleep.sleep_app("sch00007")["reason"] == "in-schedule-window"
    assert stub_effects == ["sch00006"]


class _Cw(StubClient):
    def __init__(self, states: dict[str, str]) -> None:
        super().__init__()
        self.states = states

    def describe_alarms(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("describe_alarms", kwargs))
        return {
            "MetricAlarms": [
                {"AlarmName": n, "StateValue": self.states[n]}
                for n in kwargs["AlarmNames"]
                if n in self.states
            ]
        }


def test_sweep_excludes_schedule_apps_inside_window(ddb_table, frozen, stub_effects) -> None:
    _seed_sched(ddb_table, "swin0001")
    seed_app(
        ddb_table, "swod0001", "u", status="ACTIVE", sleepMode="on-demand", runtimeState="RUNNING"
    )
    alarm = lambda a: f"apphub-{STAGE}-app-{a}-idle"  # noqa: E731
    cw = _Cw({alarm("swin0001"): "ALARM", alarm("swod0001"): "ALARM"})
    integ_clients.set_client("cloudwatch", cw)

    frozen(_kst(2026, 10, 5, 10))  # 창 안
    res = sleep.handle({"sweep": True})
    assert res["checked"] == 1 and res["slept"] == ["swod0001"]
    assert set(cw.calls_for("describe_alarms")[0]["AlarmNames"]) == {alarm("swod0001")}

    # 창 밖(밤) — schedule 앱도 후보, ALARM 이면 재운다.
    stub_effects.clear()
    seed_app(
        ddb_table, "swod0001", "u", status="ACTIVE", sleepMode="on-demand", runtimeState="SLEEPING"
    )
    frozen(_kst(2026, 10, 5, 22))
    res = sleep.handle({"sweep": True})
    assert res["slept"] == ["swin0001"]
    assert stub_effects == ["swin0001"]
