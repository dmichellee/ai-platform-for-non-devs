"""QA W-3 — ACTIVE/RUNNING 후 15분 유예(DESIGN 3.5 "유휴 15분").

유휴 알람은 CREATING 중 ALARM 에 고착되므로 ACTIVE 직후 스윕·알람 경로가 앱을 바로 재우면 안 된다.
기준 시각 = runtimeStateUpdatedAt(없으면 updatedAt). force·schedule_stop 은 유예 무시.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from app.data.apps import get_app, set_runtime_state, transition_status
from app.integrations import clients as integ_clients
from app.wake import sleep

from .conftest import StubClient, seed_app

STAGE = "test"
ACTIVE_AT = datetime(2026, 10, 8, 1, 58, 3, tzinfo=UTC)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _alarm(app_id: str) -> str:
    return f"apphub-{STAGE}-app-{app_id}-idle"


@pytest.fixture
def frozen(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("STAGE", STAGE)

    def _set(dt: datetime) -> None:
        monkeypatch.setattr(sleep, "_now", lambda: dt)

    return _set


@pytest.fixture
def stub_effects(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """판정 이후 AWS 부수효과 대체 — ensure_stopped 호출 여부로 '재웠는가'를 본다."""
    stopped: list[str] = []

    def _stop(_st: str, app_id: str) -> dict[str, Any]:
        stopped.append(app_id)
        return {"changed": True}

    monkeypatch.setattr(sleep, "ensure_stopped", _stop)
    monkeypatch.setattr(sleep, "find_app_target_group_arn", lambda *_a: None)
    monkeypatch.setattr(sleep, "app_alb_routing", lambda *_a: {})
    monkeypatch.setattr(sleep, "network_param", lambda *_a: "apps.example.com")
    return stopped


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


def _seed_running(table, app_id: str, **overrides: Any) -> None:
    fields: dict[str, Any] = {
        "sleepMode": "on-demand",
        "runtimeState": "RUNNING",
        "runtimeStateUpdatedAt": _iso(ACTIVE_AT),
        "updatedAt": _iso(ACTIVE_AT),
    }
    fields.update(overrides)
    seed_app(table, app_id, "u", status="ACTIVE", **fields)


# ── 판정 함수 ────────────────────────────────────────────────────────────────


def test_in_grace_boundaries() -> None:
    app = {"runtimeState": "RUNNING", "runtimeStateUpdatedAt": _iso(ACTIVE_AT)}
    assert sleep.in_grace_after_active(app, ACTIVE_AT + timedelta(minutes=5)) is True
    assert sleep.in_grace_after_active(app, ACTIVE_AT + timedelta(minutes=14, seconds=59)) is True
    assert sleep.in_grace_after_active(app, ACTIVE_AT + timedelta(minutes=15)) is False
    assert sleep.in_grace_after_active(app, ACTIVE_AT + timedelta(minutes=16)) is False


def test_in_grace_fallback_and_unreadable() -> None:
    now = ACTIVE_AT + timedelta(minutes=5)
    # runtimeStateUpdatedAt 없음 → updatedAt 폴백.
    assert sleep.in_grace_after_active(
        {"runtimeState": "RUNNING", "updatedAt": _iso(ACTIVE_AT)}, now
    )
    old = _iso(ACTIVE_AT - timedelta(hours=1))
    assert not sleep.in_grace_after_active({"runtimeState": "RUNNING", "updatedAt": old}, now)
    # 기준 시각을 읽을 수 없으면 유예 없음(기존 동작).
    assert not sleep.in_grace_after_active({"runtimeState": "RUNNING"}, now)
    assert not sleep.in_grace_after_active({"runtimeState": "RUNNING", "updatedAt": "garbage"}, now)
    # SLEEPING 앱은 유예 없음(재수면 멱등 보정).
    assert not sleep.in_grace_after_active(
        {"runtimeState": "SLEEPING", "runtimeStateUpdatedAt": _iso(ACTIVE_AT)}, now
    )


# ── sleep_app / idle-alarm 경로 ──────────────────────────────────────────────


def test_idle_alarm_5min_after_active_skips(ddb_table, frozen, stub_effects) -> None:
    _seed_running(ddb_table, "grc00001")
    frozen(ACTIVE_AT + timedelta(minutes=5))
    res = sleep.handle({"detail": {"alarmName": _alarm("grc00001")}})
    assert res["reason"] == "grace-after-active"
    assert stub_effects == []
    assert get_app("grc00001")["runtimeState"] == "RUNNING"


def test_idle_alarm_16min_after_active_sleeps(ddb_table, frozen, stub_effects) -> None:
    _seed_running(ddb_table, "grc00002")
    frozen(ACTIVE_AT + timedelta(minutes=16))
    res = sleep.handle({"detail": {"alarmName": _alarm("grc00002")}})
    assert "reason" not in res
    assert stub_effects == ["grc00002"]
    assert get_app("grc00002")["runtimeState"] == "SLEEPING"


def test_legacy_app_without_field_falls_back_to_updated_at(ddb_table, frozen, stub_effects) -> None:
    # 필드 도입 전 앱: runtimeStateUpdatedAt 부재(seed_app 기본엔 없음) → updatedAt 기준.
    seed_app(ddb_table, "grcleg01", "u", status="ACTIVE", updatedAt=_iso(ACTIVE_AT))
    seed_app(ddb_table, "grcleg02", "u", status="ACTIVE", updatedAt=_iso(ACTIVE_AT))
    frozen(ACTIVE_AT + timedelta(minutes=5))
    assert sleep.sleep_app("grcleg01")["reason"] == "grace-after-active"
    frozen(ACTIVE_AT + timedelta(minutes=16))
    assert "reason" not in sleep.sleep_app("grcleg02")
    assert stub_effects == ["grcleg02"]


def test_force_and_schedule_stop_ignore_grace(ddb_table, frozen, stub_effects) -> None:
    _seed_running(ddb_table, "grcfor01")
    _seed_running(ddb_table, "grcstp01")
    frozen(ACTIVE_AT + timedelta(minutes=1))
    assert "reason" not in sleep.sleep_app("grcfor01", force=True)
    # 스케줄 종료 시각 StopSchedule 직접 호출({"appId"}) = schedule_stop.
    assert "reason" not in sleep.handle({"appId": "grcstp01"})
    assert stub_effects == ["grcfor01", "grcstp01"]


# ── sweep ────────────────────────────────────────────────────────────────────


def test_sweep_excludes_apps_in_grace(ddb_table, frozen, stub_effects) -> None:
    _seed_running(ddb_table, "grcnew01")  # ACTIVE 5분 전
    _seed_running(
        ddb_table, "grcold01", runtimeStateUpdatedAt=_iso(ACTIVE_AT - timedelta(minutes=11))
    )
    cw = _Cw({_alarm("grcnew01"): "ALARM", _alarm("grcold01"): "ALARM"})
    integ_clients.set_client("cloudwatch", cw)

    frozen(ACTIVE_AT + timedelta(minutes=5))  # grcold01 은 16분 경과
    res = sleep.handle({"sweep": True})
    assert res["checked"] == 1 and res["slept"] == ["grcold01"]
    assert set(cw.calls_for("describe_alarms")[0]["AlarmNames"]) == {_alarm("grcold01")}
    assert stub_effects == ["grcold01"]

    # 유예가 끝나면 다음 스윕에서 재운다.
    frozen(ACTIVE_AT + timedelta(minutes=16))
    res = sleep.handle({"sweep": True})
    assert res["slept"] == ["grcnew01"]


# ── 기준 시각 기록(data/apps) ─────────────────────────────────────────────────


def test_runtime_state_and_active_transition_record_timestamp(ddb_table) -> None:
    seed_app(ddb_table, "grcrec01", "u", status="CREATING", runtimeState="SLEEPING")
    assert "runtimeStateUpdatedAt" not in get_app("grcrec01")
    transition_status("grcrec01", "ACTIVE", ["CREATING"])
    first = get_app("grcrec01")["runtimeStateUpdatedAt"]
    assert sleep._parse_iso(first) is not None
    set_runtime_state("grcrec01", "RUNNING")
    app = get_app("grcrec01")
    assert app["runtimeStateUpdatedAt"] >= first
    assert app["runtimeStateUpdatedAt"] == app["updatedAt"]
    # 다른 전이(→DELETING)는 기준 시각을 건드리지 않는다.
    before = app["runtimeStateUpdatedAt"]
    transition_status("grcrec01", "DELETING", ["ACTIVE"])
    assert get_app("grcrec01")["runtimeStateUpdatedAt"] == before
