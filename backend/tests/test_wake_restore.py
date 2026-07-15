"""복원 Lambda 테스트 (D-M5-03) — ECS RUNNING+healthy 판정, 규칙 복원, runtimeState=RUNNING."""

from __future__ import annotations

import pytest
from app.data.apps import get_app
from app.data.subdomains import reserve_subdomain
from app.integrations import clients as integ_clients
from app.wake import restore
from app.wake.restore import app_id_from_ecs_event, is_running_and_healthy

from .conftest import SsmStub, seed_app

STAGE = "test"
APP_TG = "arn:aws:elasticloadbalancing:...:targetgroup/app-tg/1"
WAKER_TG = "arn:aws:elasticloadbalancing:...:targetgroup/waker-tg/2"
LISTENER = "arn:aws:elasticloadbalancing:...:listener/x"


@pytest.fixture
def restore_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STAGE", STAGE)


def _ssm(scheme_key: str = "internal-https-listener-arn") -> SsmStub:
    stub = SsmStub(
        {
            f"/apphub/{STAGE}/network/{scheme_key}": LISTENER,
            f"/apphub/{STAGE}/network/waker-tg-arn": WAKER_TG,
            f"/apphub/{STAGE}/network/apps-domain": "apps.example.com",
        }
    )
    integ_clients.set_client("ssm", stub)
    return stub


def _ecs_event(app_id: str, last_status: str = "RUNNING", health: str = "HEALTHY") -> dict:
    # 공유 클러스터(D18): clusterArn 은 모든 앱 공통이라 appId 를 담지 않는다 — group 만 파싱 소스.
    return {
        "detail": {
            "clusterArn": f"arn:aws:ecs:...:cluster/apphub-{STAGE}-cluster",
            "group": f"service:apphub-{STAGE}-app-{app_id}",
            "lastStatus": last_status,
            "healthStatus": health,
        }
    }


def _forward_rule(target: str, host: str) -> dict:
    return {
        "RuleArn": "arn:...:rule1",
        "Conditions": [{"Field": "host-header", "HostHeaderConfig": {"Values": [host]}}],
        "Actions": [{"Type": "forward", "Order": 1, "TargetGroupArn": target}],
    }


# ── 파싱/판정 ────────────────────────────────────────────────────────────────


def test_app_id_from_group() -> None:
    """detail.group 이 1차(그리고 유일한) 파싱 소스 — `service:` 접두어 제거 후 서비스명 규약."""
    ev = {"detail": {"group": f"service:apphub-{STAGE}-app-def67890"}}
    assert app_id_from_ecs_event(ev, STAGE) == "def67890"


def test_app_id_shared_cluster_arn_not_parsed() -> None:
    """공유 클러스터(D18): clusterArn 은 `apphub-{stage}-cluster` 라 appId 를 담지 않는다.

    group 이 없으면(clusterArn 만 있으면) None — clusterArn 을 잘못 파싱해 엉뚱한 앱을
    깨우지 않도록 한다.
    """
    ev = {"detail": {"clusterArn": f"arn:aws:ecs:...:cluster/apphub-{STAGE}-cluster"}}
    assert app_id_from_ecs_event(ev, STAGE) is None


def test_app_id_prefers_group_over_cluster_arn() -> None:
    """실이벤트처럼 clusterArn(공유)+group(앱 서비스) 공존 시 group 에서 appId 를 얻는다."""
    ev = {
        "detail": {
            "clusterArn": f"arn:aws:ecs:...:cluster/apphub-{STAGE}-cluster",
            "group": f"service:apphub-{STAGE}-app-ghi13579",
        }
    }
    assert app_id_from_ecs_event(ev, STAGE) == "ghi13579"


def test_is_running_and_healthy_true() -> None:
    assert is_running_and_healthy(_ecs_event("x")) is True


def test_is_running_and_healthy_unknown_health_true() -> None:
    assert is_running_and_healthy(_ecs_event("x", health="UNKNOWN")) is True


def test_is_running_and_healthy_not_running_false() -> None:
    assert is_running_and_healthy(_ecs_event("x", last_status="PENDING")) is False


def test_is_running_and_healthy_container_health() -> None:
    ev = {
        "detail": {
            "lastStatus": "RUNNING",
            "healthStatus": "UNHEALTHY",
            "containers": [{"healthStatus": "HEALTHY"}],
        }
    }
    assert is_running_and_healthy(ev) is True


# ── 복원 흐름 ────────────────────────────────────────────────────────────────


def test_restore_switches_rule_to_app_and_sets_running(ddb_table, p2_clients, restore_env) -> None:
    _ssm()
    seed_app(
        ddb_table,
        "rst00001",
        "u",
        status="ACTIVE",
        subdomain="rst",
        scheme="internal",
        runtimeState="WAKING",
    )
    reserve_subdomain("rst", "rst00001")
    p2_clients["elbv2"].set_response("describe_target_groups", {"TargetGroups": [{"TargetGroupArn": APP_TG}]})
    p2_clients["elbv2"].set_response(
        "describe_rules", {"Rules": [_forward_rule(WAKER_TG, "rst.apps.example.com")]}
    )
    res = restore.handle_task_state_change(_ecs_event("rst00001"))
    assert res["appId"] == "rst00001"
    assert res["restored"] is True
    # forward 대상 → 앱 TG.
    call = p2_clients["elbv2"].calls_for("modify_rule")[0]
    fwd = next(a for a in call["Actions"] if a["Type"] == "forward")
    assert fwd["TargetGroupArn"] == APP_TG
    # runtimeState WAKING → RUNNING.
    assert get_app("rst00001")["runtimeState"] == "RUNNING"


def test_restore_skips_when_not_running_healthy(ddb_table, p2_clients, restore_env) -> None:
    res = restore.handle_task_state_change(_ecs_event("x", last_status="STOPPED"))
    assert res == {"reason": "not-running-healthy"}


def test_restore_app_tg_not_found(ddb_table, p2_clients, restore_env) -> None:
    _ssm()
    seed_app(ddb_table, "rst00002", "u", status="ACTIVE", subdomain="rst2", scheme="internal")
    reserve_subdomain("rst2", "rst00002")
    # describe_target_groups 미설정 → StubClient 기본 {} → TargetGroups 없음.
    res = restore.handle_task_state_change(_ecs_event("rst00002"))
    assert res["reason"] == "app-tg-not-found"


def test_restore_inactive_status(ddb_table, p2_clients, restore_env) -> None:
    seed_app(ddb_table, "rst00003", "u", status="DELETING", subdomain="rst3")
    res = restore.handle_task_state_change(_ecs_event("rst00003"))
    assert res["reason"] == "status-DELETING"


def test_restore_idempotent_rule_already_app(ddb_table, p2_clients, restore_env) -> None:
    _ssm()
    seed_app(
        ddb_table,
        "rst00004",
        "u",
        status="ACTIVE",
        subdomain="rst4",
        scheme="internal",
        runtimeState="RUNNING",
    )
    reserve_subdomain("rst4", "rst00004")
    p2_clients["elbv2"].set_response("describe_target_groups", {"TargetGroups": [{"TargetGroupArn": APP_TG}]})
    # 이미 앱 TG 로 forward 중 → no-op.
    p2_clients["elbv2"].set_response(
        "describe_rules", {"Rules": [_forward_rule(APP_TG, "rst4.apps.example.com")]}
    )
    res = restore.handle_task_state_change(_ecs_event("rst00004"))
    assert res["restored"] is False
    assert p2_clients["elbv2"].calls_for("modify_rule") == []
