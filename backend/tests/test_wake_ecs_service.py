"""ECS desiredCount 멱등 조정 테스트 (DESIGN 3.5 — 드리프트 방지, UpdateService 로만 조정)."""

from __future__ import annotations

from app.wake.ecs_service import app_service_name, ensure_running, ensure_stopped

STAGE = "test"
APP_ID = "svcabcd1"
NAME = f"apphub-{STAGE}-app-{APP_ID}"


def _svc(desired: int, status: str = "ACTIVE") -> dict:
    return {"serviceName": NAME, "status": status, "desiredCount": desired}


def test_ensure_running_scales_up_when_below_min(ddb_table, p2_clients) -> None:
    p2_clients["ecs"].set_response("describe_services", {"services": [_svc(0)]})
    res = ensure_running(STAGE, APP_ID, 1)
    assert res["changed"] is True
    assert res["previous"] == 0
    call = p2_clients["ecs"].calls_for("update_service")[0]
    assert call["cluster"] == NAME
    assert call["service"] == NAME
    assert call["desiredCount"] == 1


def test_ensure_running_idempotent_when_already_at_min(ddb_table, p2_clients) -> None:
    p2_clients["ecs"].set_response("describe_services", {"services": [_svc(2)]})
    res = ensure_running(STAGE, APP_ID, 1)
    assert res["changed"] is False
    assert p2_clients["ecs"].calls_for("update_service") == []


def test_ensure_running_service_not_found(ddb_table, p2_clients) -> None:
    p2_clients["ecs"].set_response("describe_services", {"services": []})
    res = ensure_running(STAGE, APP_ID, 1)
    assert res["serviceNotFound"] is True
    assert p2_clients["ecs"].calls_for("update_service") == []


def test_ensure_running_ignores_inactive_service(ddb_table, p2_clients) -> None:
    p2_clients["ecs"].set_response(
        "describe_services", {"services": [_svc(3, status="INACTIVE")]}
    )
    res = ensure_running(STAGE, APP_ID, 1)
    assert res["serviceNotFound"] is True


def test_ensure_stopped_scales_to_zero(ddb_table, p2_clients) -> None:
    p2_clients["ecs"].set_response("describe_services", {"services": [_svc(2)]})
    res = ensure_stopped(STAGE, APP_ID)
    assert res["changed"] is True
    call = p2_clients["ecs"].calls_for("update_service")[0]
    assert call["desiredCount"] == 0


def test_ensure_stopped_idempotent_when_already_zero(ddb_table, p2_clients) -> None:
    p2_clients["ecs"].set_response("describe_services", {"services": [_svc(0)]})
    res = ensure_stopped(STAGE, APP_ID)
    assert res["changed"] is False
    assert p2_clients["ecs"].calls_for("update_service") == []


def test_app_service_name() -> None:
    assert app_service_name("dev", "abc12345") == "apphub-dev-app-abc12345"
