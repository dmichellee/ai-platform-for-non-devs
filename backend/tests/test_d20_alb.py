"""D20 ALB 증설 — deploy-notify alb build 처리, sleep/restore albIndex·legacy TG 판정, 관리자 레지스트리.

계약: _workspace/contracts/delta-2026-10-07-d19-d21.md §1.2·§3.2·§7·§8.
"""

from __future__ import annotations

from typing import Any

import pytest
from app.data import alb_registry as reg
from app.data.apps import get_app
from app.data.subdomains import reserve_subdomain
from app.handler import handler
from app.integrations import clients as integ_clients
from app.integrations import ssm as ssm_module
from app.orchestration import deploy_notify
from app.wake import restore, sleep

from .conftest import SsmStub, make_event, parse_result, seed_app

STAGE = "test"
PROVISIONER = f"apphub-{STAGE}-provisioner"
APP_TG = "arn:tg:app"
LEGACY_WAKER = "arn:tg:waker-legacy"
NET1_WAKER = "arn:tg:waker-internet-1"
NET1_LISTENER = "arn:listener:internet-1"
INT0_WAKER = "arn:tg:waker-internal-0"
INT0_LISTENER = "arn:listener:internal-0"
NET1_ALB = "arn:aws:elasticloadbalancing:ap-northeast-2:111122223333:loadbalancer/app/apphub-test-internet-alb-1/abc"


@pytest.fixture
def d20_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STAGE", STAGE)
    monkeypatch.setenv("CLUSTER_NAME", f"apphub-{STAGE}-cluster")


def _ssm(extra: dict[str, str] | None = None) -> SsmStub:
    params = {
        f"/apphub/{STAGE}/network/waker-tg-arn": LEGACY_WAKER,
        f"/apphub/{STAGE}/network/apps-domain": "apps.example.com",
        f"/apphub/{STAGE}/network/vpc-id": "vpc-platform",
        f"/apphub/{STAGE}/network/alb/internet/1/https-listener-arn": NET1_LISTENER,
        f"/apphub/{STAGE}/network/alb/internet/1/waker-tg-arn": NET1_WAKER,
        f"/apphub/{STAGE}/network/alb/internet/1/alb-arn": NET1_ALB,
        f"/apphub/{STAGE}/network/alb/internal/0/https-listener-arn": INT0_LISTENER,
        f"/apphub/{STAGE}/network/alb/internal/0/waker-tg-arn": INT0_WAKER,
    }
    params.update(extra or {})
    ssm_module.reset_cache()
    stub = SsmStub(params)
    integ_clients.set_client("ssm", stub)
    return stub


def _rule(target: str, host: str) -> dict[str, Any]:
    return {
        "RuleArn": "arn:rule:1",
        "Conditions": [{"Field": "host-header", "HostHeaderConfig": {"Values": [host]}}],
        "Actions": [{"Type": "forward", "Order": 1, "TargetGroupArn": target}],
    }


# ── SSM 헬퍼 ────────────────────────────────────────────────────────────────


def test_alb_param_path_uses_scheme_slug(ddb_table, p2_clients, d20_env) -> None:
    stub = _ssm()
    assert ssm_module.alb_param(STAGE, "internet-facing", 1, "waker-tg-arn") == NET1_WAKER
    assert stub.calls[-1]["Name"] == f"/apphub/{STAGE}/network/alb/internet/1/waker-tg-arn"


def test_alb_param_n0_falls_back_to_legacy_keys(ddb_table, p2_clients, d20_env) -> None:
    _ssm(
        {
            f"/apphub/{STAGE}/network/internet-https-listener-arn": "arn:listener:legacy-net",
            f"/apphub/{STAGE}/network/internet-alb-arn": "arn:alb:legacy-net",
        }
    )
    assert ssm_module.alb_param(STAGE, "internet-facing", 0, "https-listener-arn") == "arn:listener:legacy-net"
    assert ssm_module.alb_param(STAGE, "internet-facing", 0, "alb-arn") == "arn:alb:legacy-net"
    assert ssm_module.alb_param(STAGE, "internet-facing", 0, "waker-tg-arn") == LEGACY_WAKER


def test_alb_param_no_legacy_fallback_for_n_ge_1(ddb_table, p2_clients, d20_env) -> None:
    _ssm()
    with pytest.raises(KeyError):
        ssm_module.alb_param(STAGE, "internal", 3, "waker-tg-arn")


# ── sleep / restore — App.albIndex 기준 ─────────────────────────────────────


def _seed_sleepable(table, app_id: str, sub: str, **kw: Any) -> None:
    seed_app(table, app_id, "u", status="ACTIVE", subdomain=sub, sleepMode="on-demand", **kw)
    reserve_subdomain(sub, app_id)


def test_sleep_uses_alb_index_listener_and_waker(ddb_table, p2_clients, d20_env) -> None:
    _ssm()
    _seed_sleepable(ddb_table, "slpnet01", "n1", scheme="internet-facing", albIndex=1)
    p2_clients["ecs"].set_response(
        "describe_services",
        {"services": [{"serviceName": "x", "status": "ACTIVE", "desiredCount": 1}]},
    )
    p2_clients["elbv2"].set_response("describe_target_groups", {"TargetGroups": [{"TargetGroupArn": APP_TG}]})
    p2_clients["elbv2"].set_response("describe_rules", {"Rules": [_rule(APP_TG, "n1.apps.example.com")]})
    res = sleep.sleep_app("slpnet01")
    assert res["ruleSwitched"] is True
    assert p2_clients["elbv2"].calls_for("describe_rules")[0]["ListenerArn"] == NET1_LISTENER
    fwd = p2_clients["elbv2"].calls_for("modify_rule")[0]["Actions"][0]
    assert fwd["TargetGroupArn"] == NET1_WAKER
    assert get_app("slpnet01")["runtimeState"] == "SLEEPING"


def test_sleep_internal_n0_uses_new_internal_waker(ddb_table, p2_clients, d20_env) -> None:
    # albIndex 없음(기존 앱) → 0. internal n=0 은 신규 TG(apphub-{stage}-waker-internal-0) 사용.
    _ssm()
    _seed_sleepable(ddb_table, "slpint01", "i0", scheme="internal")
    p2_clients["elbv2"].set_response("describe_target_groups", {"TargetGroups": [{"TargetGroupArn": APP_TG}]})
    p2_clients["elbv2"].set_response("describe_rules", {"Rules": [_rule(APP_TG, "i0.apps.example.com")]})
    sleep.sleep_app("slpint01")
    assert p2_clients["elbv2"].calls_for("describe_rules")[0]["ListenerArn"] == INT0_LISTENER
    assert p2_clients["elbv2"].calls_for("modify_rule")[0]["Actions"][0]["TargetGroupArn"] == INT0_WAKER


def test_sleep_treats_legacy_waker_as_already_sleeping(ddb_table, p2_clients, d20_env) -> None:
    # 현재 forward 가 legacy waker-tg-arn → waker 로 간주(마이그레이션 안전) → ModifyRule 없음.
    _ssm()
    _seed_sleepable(ddb_table, "slpleg01", "lg", scheme="internal")
    p2_clients["elbv2"].set_response("describe_target_groups", {"TargetGroups": [{"TargetGroupArn": APP_TG}]})
    p2_clients["elbv2"].set_response("describe_rules", {"Rules": [_rule(LEGACY_WAKER, "lg.apps.example.com")]})
    res = sleep.sleep_app("slpleg01")
    assert res["ruleSwitched"] is False
    assert p2_clients["elbv2"].calls_for("modify_rule") == []


def _ecs_event(app_id: str) -> dict[str, Any]:
    return {
        "detail": {
            "group": f"service:apphub-{STAGE}-app-{app_id}",
            "lastStatus": "RUNNING",
            "healthStatus": "HEALTHY",
        }
    }


def test_restore_uses_alb_index_listener(ddb_table, p2_clients, d20_env) -> None:
    _ssm()
    _seed_sleepable(
        ddb_table, "rstnet01", "r1", scheme="internet-facing", albIndex=1, runtimeState="SLEEPING"
    )
    p2_clients["elbv2"].set_response("describe_target_groups", {"TargetGroups": [{"TargetGroupArn": APP_TG}]})
    p2_clients["elbv2"].set_response("describe_rules", {"Rules": [_rule(NET1_WAKER, "r1.apps.example.com")]})
    res = restore.handle_task_state_change(_ecs_event("rstnet01"))
    assert res["restored"] is True
    assert p2_clients["elbv2"].calls_for("describe_rules")[0]["ListenerArn"] == NET1_LISTENER
    assert p2_clients["elbv2"].calls_for("modify_rule")[0]["Actions"][0]["TargetGroupArn"] == APP_TG
    assert get_app("rstnet01")["runtimeState"] == "RUNNING"


def test_restore_from_legacy_waker_switches_to_app(ddb_table, p2_clients, d20_env) -> None:
    _ssm()
    _seed_sleepable(ddb_table, "rstleg01", "r2", scheme="internal", runtimeState="SLEEPING")
    p2_clients["elbv2"].set_response("describe_target_groups", {"TargetGroups": [{"TargetGroupArn": APP_TG}]})
    p2_clients["elbv2"].set_response("describe_rules", {"Rules": [_rule(LEGACY_WAKER, "r2.apps.example.com")]})
    res = restore.handle_task_state_change(_ecs_event("rstleg01"))
    assert res["restored"] is True
    assert p2_clients["elbv2"].calls_for("modify_rule")[0]["Actions"][0]["TargetGroupArn"] == APP_TG


# ── deploy-notify — provisioner APP_STACK_KIND=alb ───────────────────────────


def _alb_build_event(status: str, slug: str = "internet", index: str = "1", uuid: str = "u1") -> dict[str, Any]:
    return {
        "detail-type": "CodeBuild Build State Change",
        "source": "aws.codebuild",
        "detail": {
            "build-status": status,
            "project-name": PROVISIONER,
            "build-id": f"arn:aws:codebuild:ap-northeast-2:111122223333:build/{PROVISIONER}:{uuid}",
            "additional-information": {
                "environment": {
                    "environment-variables": [
                        {"name": "APP_ID", "value": "-", "type": "PLAINTEXT"},
                        {"name": "APP_STACK_KIND", "value": "alb", "type": "PLAINTEXT"},
                        {"name": "ALB_SCHEME", "value": slug, "type": "PLAINTEXT"},
                        {"name": "ALB_INDEX", "value": index, "type": "PLAINTEXT"},
                    ]
                }
            },
        },
    }


def _pending(table, slug: str, n: int) -> dict[str, Any] | None:
    return table.get_item(Key={"PK": "CONFIG", "SK": f"ALBPENDING#{slug}#{n}"}).get("Item")


def test_notify_alb_succeeded_registers_active_and_clears_pending(ddb_table, p2_clients, d20_env) -> None:
    _ssm()
    reg.reserve_pending("internet", 1)
    reg.set_pending_build("internet", 1, f"{PROVISIONER}:u1")
    out = deploy_notify.handle_event(_alb_build_event("SUCCEEDED"))
    assert out["albArn"] == NET1_ALB
    assert out["registered"] is True
    item = ddb_table.get_item(Key={"PK": "CONFIG", "SK": f"ALB#{NET1_ALB}"})["Item"]
    assert item["index"] == 1
    assert item["status"] == "ACTIVE"
    assert item["ruleCount"] == 0
    assert item["scheme"] == "internet-facing"
    assert item["schemeSlug"] == "internet"
    assert item["vpcId"] == "vpc-platform"
    assert _pending(ddb_table, "internet", 1) is None


def test_notify_alb_succeeded_is_idempotent(ddb_table, p2_clients, d20_env) -> None:
    _ssm()
    deploy_notify.handle_event(_alb_build_event("SUCCEEDED"))
    ddb_table.update_item(
        Key={"PK": "CONFIG", "SK": f"ALB#{NET1_ALB}"},
        UpdateExpression="SET ruleCount = :c",
        ExpressionAttributeValues={":c": 4},
    )
    out = deploy_notify.handle_event(_alb_build_event("SUCCEEDED"))
    assert out["registered"] is False
    item = ddb_table.get_item(Key={"PK": "CONFIG", "SK": f"ALB#{NET1_ALB}"})["Item"]
    assert item["ruleCount"] == 4  # 재수신해도 ruleCount 리셋 없음


@pytest.mark.parametrize("status", ["FAILED", "STOPPED", "FAULT", "TIMED_OUT"])
def test_notify_alb_failed_deletes_pending(ddb_table, p2_clients, d20_env, status: str) -> None:
    _ssm()
    reg.reserve_pending("internet", 1)
    reg.set_pending_build("internet", 1, f"{PROVISIONER}:u1")
    out = deploy_notify.handle_event(_alb_build_event(status))
    assert out["pendingDeleted"] is True
    assert _pending(ddb_table, "internet", 1) is None
    assert reg.list_albs("internet") == []


def test_notify_alb_failed_from_stale_build_keeps_newer_pending(ddb_table, p2_clients, d20_env) -> None:
    _ssm()
    reg.reserve_pending("internet", 1)
    reg.set_pending_build("internet", 1, f"{PROVISIONER}:newer")
    out = deploy_notify.handle_event(_alb_build_event("FAILED", uuid="older"))
    assert out["pendingDeleted"] is False
    assert _pending(ddb_table, "internet", 1) is not None


def test_notify_alb_in_progress_skipped(ddb_table, p2_clients, d20_env) -> None:
    _ssm()
    reg.reserve_pending("internet", 1)
    out = deploy_notify.handle_event(_alb_build_event("IN_PROGRESS"))
    assert "skipped" in out["reason"]
    assert _pending(ddb_table, "internet", 1) is not None


def test_notify_non_alb_non_runtime_build_still_ignored(ddb_table, p2_clients, d20_env) -> None:
    ev = _alb_build_event("SUCCEEDED")
    for v in ev["detail"]["additional-information"]["environment"]["environment-variables"]:
        if v["name"] == "APP_STACK_KIND":
            v["value"] = "pipeline"
    assert deploy_notify.handle_event(ev) == {"reason": "not-runtime-build"}


# ── 관리자 API / App 응답 ────────────────────────────────────────────────────


def test_admin_alb_registry_response_shape(ddb_table, stub_clients) -> None:
    reg.ensure_alb_registered("arn:alb:int0", "internal", "vpc-platform", index=0)
    reg.ensure_alb_registered(NET1_ALB, "internet", "vpc-platform", index=1)
    reg.reserve_pending("internet", 2)
    # 구 항목(index/status 없음)도 0/ACTIVE 로 응답.
    ddb_table.put_item(
        Item={
            "PK": "CONFIG",
            "SK": "ALB#arn:alb:net0",
            "entityType": "AlbRegistry",
            "albArn": "arn:alb:net0",
            "scheme": "internet-facing",
            "vpcId": "vpc-platform",
            "ruleCount": 12,
        }
    )
    res = parse_result(handler(make_event("GET", "/admin/alb-registry", user_id="a1", groups=["admin"])))
    assert res["status"] == 200
    items = res["data"]["items"]
    assert [(i["schemeSlug"], i["index"], i["status"]) for i in items] == [
        ("internal", 0, "ACTIVE"),
        ("internet", 0, "ACTIVE"),
        ("internet", 1, "ACTIVE"),
        ("internet", 2, "PROVISIONING"),
    ]
    assert items[1] == {
        "albArn": "arn:alb:net0",
        "scheme": "internet-facing",
        "schemeSlug": "internet",
        "index": 0,
        "status": "ACTIVE",
        "ruleCount": 12,
        "ruleLimit": 90,
        "vpcId": "vpc-platform",
    }
    assert "albArn" not in items[3]
    assert items[3]["scheme"] == "internet-facing"
    assert all(i["ruleLimit"] == 90 for i in items)


def test_admin_alb_registry_requires_admin(ddb_table, stub_clients) -> None:
    res = parse_result(handler(make_event("GET", "/admin/alb-registry", user_id="u1", groups=["user"])))
    assert res["status"] == 403


def test_app_response_includes_alb_index(ddb_table, stub_clients) -> None:
    seed_app(ddb_table, "appidx01", "u1", albArn="arn:alb:x", rulePriority=3)
    seed_app(ddb_table, "appidx02", "u1", subdomain="b", albArn="arn:alb:y", rulePriority=4, albIndex=2)
    r1 = parse_result(handler(make_event("GET", "/apps/appidx01", user_id="u1")))
    r2 = parse_result(handler(make_event("GET", "/apps/appidx02", user_id="u1")))
    assert r1["data"]["albIndex"] == 0
    assert r2["data"]["albIndex"] == 2
