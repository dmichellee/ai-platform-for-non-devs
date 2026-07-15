"""Waker Lambda 테스트 (D-M5-03) — Host 식별, 깨우기 멱등, 항상 200 대기 페이지(이모지 없음)."""

from __future__ import annotations

import pytest
from app.data.apps import get_app
from app.data.subdomains import reserve_subdomain
from app.wake import waker
from app.wake.waker import extract_host, subdomain_from_host

from .conftest import seed_app, seed_preset

STAGE = "test"


CLUSTER = f"apphub-{STAGE}-cluster"  # 공유 클러스터(D18) — waker 가 ensure_running 으로 접근.


@pytest.fixture
def wake_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STAGE", STAGE)
    monkeypatch.setenv("APPS_DOMAIN", "apps.example.com")
    monkeypatch.setenv("CLUSTER_NAME", CLUSTER)


def _svc(app_id: str, desired: int) -> dict:
    name = f"apphub-{STAGE}-app-{app_id}"
    return {"serviceName": name, "status": "ACTIVE", "desiredCount": desired}


# ── 순수 파싱 ────────────────────────────────────────────────────────────────


def test_subdomain_from_host_with_apps_domain() -> None:
    assert subdomain_from_host("myapp.apps.example.com", "apps.example.com") == "myapp"


def test_subdomain_from_host_strips_port() -> None:
    assert subdomain_from_host("myapp.apps.example.com:443", "apps.example.com") == "myapp"


def test_subdomain_from_host_falls_back_to_first_label() -> None:
    assert subdomain_from_host("other.example.org", "apps.example.com") == "other"


def test_subdomain_from_host_empty() -> None:
    assert subdomain_from_host(None, "apps.example.com") is None


def test_extract_host_prefers_headers() -> None:
    assert extract_host({"headers": {"host": "h1"}}) == "h1"


def test_extract_host_multivalue_fallback() -> None:
    assert extract_host({"multiValueHeaders": {"Host": ["h2"]}}) == "h2"


# ── 대기 페이지 ──────────────────────────────────────────────────────────────


def test_waiting_page_always_200_no_emoji(ddb_table, p2_clients, wake_env) -> None:
    res = waker.handle({"headers": {}})
    assert res["statusCode"] == 200
    assert res["headers"]["Content-Type"].startswith("text/html")
    body = res["body"]
    assert 'http-equiv="refresh" content="5"' in body
    # 이모지 없음(ASCII + 한글만). surrogate/pictographs 부재 확인.
    assert all(ord(ch) < 0x1F000 for ch in body)


def test_waiting_page_returned_even_when_wake_fails(ddb_table, p2_clients, wake_env) -> None:
    # ssm/ddb 미구성이라 wake_by_host 내부에서 예외가 나도 200 대기 페이지.
    seed_app(ddb_table, "wkfail01", "u", status="ACTIVE", subdomain="wkfail")
    reserve_subdomain("wkfail", "wkfail01")
    # ecs describe_services 가 raise 하도록.
    p2_clients["ecs"].set_raise("describe_services", RuntimeError("boom"))
    res = waker.handle({"headers": {"host": "wkfail.apps.example.com"}})
    assert res["statusCode"] == 200


# ── wake_by_host 흐름 ────────────────────────────────────────────────────────


def test_wake_by_host_scales_and_sets_waking(ddb_table, p2_clients, wake_env) -> None:
    seed_preset(ddb_table, "small")  # minCount=1
    seed_app(
        ddb_table,
        "wkapp001",
        "u",
        status="ACTIVE",
        subdomain="wk1",
        presetId="small",
        runtimeState="SLEEPING",
    )
    reserve_subdomain("wk1", "wkapp001")
    p2_clients["ecs"].set_response("describe_services", {"services": [_svc("wkapp001", 0)]})
    res = waker.wake_by_host("wk1.apps.example.com")
    assert res["appId"] == "wkapp001"
    assert res["started"] is True
    # SLEEPING → WAKING.
    assert get_app("wkapp001")["runtimeState"] == "WAKING"
    # desiredCount=minCount 로 스케일업 — 공유 클러스터 위의 앱 서비스(cluster != service).
    call = p2_clients["ecs"].calls_for("update_service")[0]
    assert call["desiredCount"] == 1
    assert call["cluster"] == CLUSTER
    assert call["service"] == f"apphub-{STAGE}-app-wkapp001"


def test_wake_by_host_no_subdomain(ddb_table, p2_clients, wake_env) -> None:
    assert waker.wake_by_host(None) == {"reason": "no-subdomain"}


def test_wake_by_host_no_app_for_subdomain(ddb_table, p2_clients, wake_env) -> None:
    res = waker.wake_by_host("unknown.apps.example.com")
    assert res["reason"] == "no-app-for-subdomain"


def test_wake_by_host_inactive_status(ddb_table, p2_clients, wake_env) -> None:
    seed_app(ddb_table, "wkinact1", "u", status="CREATING", subdomain="wkin")
    reserve_subdomain("wkin", "wkinact1")
    res = waker.wake_by_host("wkin.apps.example.com")
    assert res["reason"] == "status-CREATING"


def test_wake_by_host_service_not_found(ddb_table, p2_clients, wake_env) -> None:
    seed_preset(ddb_table, "small")
    seed_app(ddb_table, "wknosvc1", "u", status="ACTIVE", subdomain="wkns", presetId="small")
    reserve_subdomain("wkns", "wknosvc1")
    p2_clients["ecs"].set_response("describe_services", {"services": []})
    res = waker.wake_by_host("wkns.apps.example.com")
    assert res["reason"] == "service-not-found"
    assert res["started"] is False
