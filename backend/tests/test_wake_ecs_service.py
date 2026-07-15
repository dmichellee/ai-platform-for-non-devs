"""ECS desiredCount 멱등 조정 테스트 (DESIGN 3.5 — 드리프트 방지, UpdateService 로만 조정).

클러스터/서비스 분리(DESIGN.md D18): stage 당 공유 클러스터(`apphub-{stage}-cluster`) 위에
앱 서비스(`apphub-{stage}-app-{appId}`)만 존재. 클러스터명은 CLUSTER_NAME env(network 스택 주입).
"""

from __future__ import annotations

import pytest
from app.wake.ecs_service import app_service_name, ensure_running, ensure_stopped

STAGE = "test"
APP_ID = "svcabcd1"
SERVICE = f"apphub-{STAGE}-app-{APP_ID}"
CLUSTER = f"apphub-{STAGE}-cluster"


@pytest.fixture
def cluster_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """network 스택이 wake Lambda env 에 주입하는 CLUSTER_NAME(공유 클러스터)."""
    monkeypatch.setenv("CLUSTER_NAME", CLUSTER)


def _svc(desired: int, status: str = "ACTIVE") -> dict:
    return {"serviceName": SERVICE, "status": status, "desiredCount": desired}


def test_ensure_running_scales_up_when_below_min(ddb_table, p2_clients, cluster_env) -> None:
    p2_clients["ecs"].set_response("describe_services", {"services": [_svc(0)]})
    res = ensure_running(STAGE, APP_ID, 1)
    assert res["changed"] is True
    assert res["previous"] == 0
    call = p2_clients["ecs"].calls_for("update_service")[0]
    # 공유 클러스터 위의 앱 서비스 — cluster != service.
    assert call["cluster"] == CLUSTER
    assert call["service"] == SERVICE
    assert call["desiredCount"] == 1


def test_describe_uses_shared_cluster_and_app_service(ddb_table, p2_clients, cluster_env) -> None:
    """describe_services 도 cluster=공유 클러스터, services=[앱 서비스] 로 호출한다."""
    p2_clients["ecs"].set_response("describe_services", {"services": [_svc(1)]})
    ensure_running(STAGE, APP_ID, 1)
    call = p2_clients["ecs"].calls_for("describe_services")[0]
    assert call["cluster"] == CLUSTER
    assert call["services"] == [SERVICE]


def test_ensure_running_idempotent_when_already_at_min(ddb_table, p2_clients, cluster_env) -> None:
    p2_clients["ecs"].set_response("describe_services", {"services": [_svc(2)]})
    res = ensure_running(STAGE, APP_ID, 1)
    assert res["changed"] is False
    assert p2_clients["ecs"].calls_for("update_service") == []


def test_ensure_running_service_not_found(ddb_table, p2_clients, cluster_env) -> None:
    p2_clients["ecs"].set_response("describe_services", {"services": []})
    res = ensure_running(STAGE, APP_ID, 1)
    assert res["serviceNotFound"] is True
    assert p2_clients["ecs"].calls_for("update_service") == []


def test_ensure_running_ignores_inactive_service(ddb_table, p2_clients, cluster_env) -> None:
    p2_clients["ecs"].set_response(
        "describe_services", {"services": [_svc(3, status="INACTIVE")]}
    )
    res = ensure_running(STAGE, APP_ID, 1)
    assert res["serviceNotFound"] is True


def test_ensure_stopped_scales_to_zero(ddb_table, p2_clients, cluster_env) -> None:
    p2_clients["ecs"].set_response("describe_services", {"services": [_svc(2)]})
    res = ensure_stopped(STAGE, APP_ID)
    assert res["changed"] is True
    call = p2_clients["ecs"].calls_for("update_service")[0]
    assert call["cluster"] == CLUSTER
    assert call["service"] == SERVICE
    assert call["desiredCount"] == 0


def test_ensure_stopped_idempotent_when_already_zero(ddb_table, p2_clients, cluster_env) -> None:
    p2_clients["ecs"].set_response("describe_services", {"services": [_svc(0)]})
    res = ensure_stopped(STAGE, APP_ID)
    assert res["changed"] is False
    assert p2_clients["ecs"].calls_for("update_service") == []


def test_missing_cluster_env_raises(ddb_table, p2_clients, monkeypatch: pytest.MonkeyPatch) -> None:
    """CLUSTER_NAME 미주입이면 잘못된 클러스터로 UpdateService 하지 않도록 명시적 에러(폴백 금지)."""
    monkeypatch.delenv("CLUSTER_NAME", raising=False)
    with pytest.raises(RuntimeError, match="CLUSTER_NAME"):
        ensure_running(STAGE, APP_ID, 1)


def test_app_service_name() -> None:
    assert app_service_name("dev", "abc12345") == "apphub-dev-app-abc12345"
