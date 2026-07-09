"""잠자기 Lambda 테스트 (D-M5-03) — desiredCount=0 멱등, 규칙 to=waker, SLEEPING, always-on 스킵."""

from __future__ import annotations

import pytest
from app.data.apps import get_app
from app.data.subdomains import reserve_subdomain
from app.integrations import clients as integ_clients
from app.wake import sleep
from app.wake.sleep import app_id_from_sleep_event

from .conftest import SsmStub, seed_app

STAGE = "test"
APP_TG = "arn:aws:elasticloadbalancing:...:targetgroup/app-tg/1"
WAKER_TG = "arn:aws:elasticloadbalancing:...:targetgroup/waker-tg/2"
LISTENER = "arn:aws:elasticloadbalancing:...:listener/x"


@pytest.fixture
def sleep_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STAGE", STAGE)


def _ssm() -> SsmStub:
    stub = SsmStub(
        {
            f"/apphub/{STAGE}/network/internal-https-listener-arn": LISTENER,
            f"/apphub/{STAGE}/network/waker-tg-arn": WAKER_TG,
            f"/apphub/{STAGE}/network/apps-domain": "apps.example.com",
        }
    )
    integ_clients.set_client("ssm", stub)
    return stub


def _svc(app_id: str, desired: int) -> dict:
    name = f"apphub-{STAGE}-app-{app_id}"
    return {"serviceName": name, "status": "ACTIVE", "desiredCount": desired}


def _forward_rule(target: str, host: str) -> dict:
    return {
        "RuleArn": "arn:...:rule1",
        "Conditions": [{"Field": "host-header", "HostHeaderConfig": {"Values": [host]}}],
        "Actions": [{"Type": "forward", "Order": 1, "TargetGroupArn": target}],
    }


# ── appId 파싱 ───────────────────────────────────────────────────────────────


def test_app_id_from_direct_invoke() -> None:
    assert app_id_from_sleep_event({"appId": "direct12"}, STAGE) == "direct12"


def test_app_id_from_alarm_name() -> None:
    ev = {"detail": {"alarmName": f"apphub-{STAGE}-app-alarm123-idle"}}
    assert app_id_from_sleep_event(ev, STAGE) == "alarm123"


def test_app_id_from_alarm_data() -> None:
    ev = {"alarmData": {"alarmName": f"apphub-{STAGE}-app-adata456-idle"}}
    assert app_id_from_sleep_event(ev, STAGE) == "adata456"


def test_app_id_none_when_missing() -> None:
    assert app_id_from_sleep_event({}, STAGE) is None


# ── 잠자기 흐름 ──────────────────────────────────────────────────────────────


def test_sleep_stops_service_switches_rule_sets_sleeping(ddb_table, p2_clients, sleep_env) -> None:
    _ssm()
    seed_app(
        ddb_table,
        "slp00001",
        "u",
        status="ACTIVE",
        subdomain="slp",
        scheme="internal",
        sleepMode="on-demand",
        runtimeState="RUNNING",
    )
    reserve_subdomain("slp", "slp00001")
    p2_clients["ecs"].set_response("describe_services", {"services": [_svc("slp00001", 1)]})
    p2_clients["elbv2"].set_response(
        "describe_target_groups", {"TargetGroups": [{"TargetGroupArn": APP_TG}]}
    )
    p2_clients["elbv2"].set_response(
        "describe_rules", {"Rules": [_forward_rule(APP_TG, "slp.apps.example.com")]}
    )
    res = sleep.sleep_app("slp00001")
    assert res["stopped"] is True
    assert res["ruleSwitched"] is True
    # desiredCount=0.
    assert p2_clients["ecs"].calls_for("update_service")[0]["desiredCount"] == 0
    # forward → waker TG.
    fwd = next(
        a
        for a in p2_clients["elbv2"].calls_for("modify_rule")[0]["Actions"]
        if a["Type"] == "forward"
    )
    assert fwd["TargetGroupArn"] == WAKER_TG
    # RUNNING → SLEEPING.
    assert get_app("slp00001")["runtimeState"] == "SLEEPING"


def test_sleep_always_on_skips(ddb_table, p2_clients, sleep_env) -> None:
    seed_app(ddb_table, "slp00002", "u", status="ACTIVE", subdomain="slp2", sleepMode="always-on")
    res = sleep.sleep_app("slp00002")
    assert res["reason"] == "always-on"
    assert p2_clients["ecs"].calls_for("update_service") == []


def test_sleep_idempotent_service_already_stopped(ddb_table, p2_clients, sleep_env) -> None:
    _ssm()
    seed_app(
        ddb_table,
        "slp00003",
        "u",
        status="ACTIVE",
        subdomain="slp3",
        scheme="internal",
        sleepMode="on-demand",
        runtimeState="SLEEPING",
    )
    reserve_subdomain("slp3", "slp00003")
    p2_clients["ecs"].set_response("describe_services", {"services": [_svc("slp00003", 0)]})
    p2_clients["elbv2"].set_response(
        "describe_target_groups", {"TargetGroups": [{"TargetGroupArn": APP_TG}]}
    )
    # 이미 waker TG → 규칙 no-op.
    p2_clients["elbv2"].set_response(
        "describe_rules", {"Rules": [_forward_rule(WAKER_TG, "slp3.apps.example.com")]}
    )
    res = sleep.sleep_app("slp00003")
    assert res["stopped"] is False
    assert res["ruleSwitched"] is False
    assert p2_clients["ecs"].calls_for("update_service") == []
    assert p2_clients["elbv2"].calls_for("modify_rule") == []


def test_sleep_inactive_status(ddb_table, p2_clients, sleep_env) -> None:
    seed_app(ddb_table, "slp00004", "u", status="CREATING", subdomain="slp4")
    res = sleep.sleep_app("slp00004")
    assert res["reason"] == "status-CREATING"


def test_handle_no_app_id(ddb_table, p2_clients, sleep_env) -> None:
    res = sleep.handle({})
    assert res == {"reason": "no-appId"}
