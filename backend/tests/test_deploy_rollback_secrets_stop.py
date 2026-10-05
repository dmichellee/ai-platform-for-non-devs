"""L1 — stub 구현 4기능의 실제 연결(성공/인가/에러 경계).

1) 수동 배포: StartPipelineExecution 실제 호출 + pipelineExecutionId 기록.
2) 롤백: deploymentId 검증 + ECR 태그 실존 확인 + provisioner runtime StartBuild(IMAGE_TAG).
3) 시크릿: tests/test_secrets_d8.py 로 이동(D8 앱당 1개 JSON).
4) 관리자 강제 중지: admin 전용, ECS desiredCount=0 + 규칙 waker 전환 + SLEEPING(always-on 포함).
"""

from __future__ import annotations

from typing import Any

import pytest
from app.data.apps import get_app
from app.data.deployments import put_deployment
from app.data.subdomains import reserve_subdomain
from app.handler import handler
from app.integrations import clients as integ_clients

from .conftest import (
    SsmStub,
    StubClient,
    make_event,
    parse_result,
    seed_app,
)

OWNER = "user-alice"
OTHER = "user-bob"
ADMIN = "user-admin"
STAGE = "test"


# ── 공통 stub 헬퍼 ────────────────────────────────────────────────────────────


def _codepipeline() -> StubClient:
    stub = StubClient()
    stub.set_response("start_pipeline_execution", {"pipelineExecutionId": "exec-99"})
    integ_clients.set_client("codepipeline", stub)
    return stub


def _codebuild() -> StubClient:
    stub = StubClient()
    stub.set_response("start_build", {"build": {"id": "build-77"}})
    integ_clients.set_client("codebuild", stub)
    return stub


def _ecr(exists: bool) -> StubClient:
    stub = StubClient()
    if exists:
        stub.set_response("describe_images", {"imageDetails": [{"imageTags": ["sha123"]}]})
    else:
        from botocore.exceptions import ClientError

        stub.set_raise(
            "describe_images",
            ClientError({"Error": {"Code": "ImageNotFoundException"}}, "DescribeImages"),
        )
    integ_clients.set_client("ecr", stub)
    return stub


def _ssm_network() -> SsmStub:
    stub = SsmStub(
        {
            f"/apphub/{STAGE}/network/internal-https-listener-arn": "arn:listener:internal",
            f"/apphub/{STAGE}/network/internet-https-listener-arn": "arn:listener:internet",
            f"/apphub/{STAGE}/network/waker-tg-arn": "arn:tg:waker",
            f"/apphub/{STAGE}/network/apps-domain": "apps.example.com",
        }
    )
    integ_clients.set_client("ssm", stub)
    return stub


def _ssm_platform() -> SsmStub:
    stub = SsmStub(
        {f"/apphub/{STAGE}/platform/provisioner-project-name": "apphub-test-provisioner"}
    )
    integ_clients.set_client("ssm", stub)
    return stub


# ══════════════════════════════════════════════════════════════════════════════
# 작업 1 — 수동 배포 (POST /apps/{id}/deploy)
# ══════════════════════════════════════════════════════════════════════════════


def test_deploy_starts_pipeline_and_records_execution_id(ddb_table, stub_clients) -> None:
    seed_app(ddb_table, "dpl00001", OWNER, status="ACTIVE")
    pipe = _codepipeline()
    res = handler(make_event("POST", "/apps/dpl00001/deploy", user_id=OWNER, groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 201
    assert out["data"]["status"] == "PENDING"
    assert out["data"]["trigger"] == "manual"
    assert out["data"]["pipelineExecutionId"] == "exec-99"
    calls = pipe.calls_for("start_pipeline_execution")
    assert calls[0]["name"] == "apphub-test-app-dpl00001"


def test_deploy_creating_invalid_state(ddb_table, stub_clients) -> None:
    seed_app(ddb_table, "dpl00002", OWNER, status="CREATING")
    _codepipeline()
    res = handler(make_event("POST", "/apps/dpl00002/deploy", user_id=OWNER, groups=["user"]))
    assert parse_result(res)["error"]["code"] == "INVALID_STATE"


def test_deploy_other_owner_forbidden(ddb_table, stub_clients) -> None:
    seed_app(ddb_table, "dpl00003", OWNER, status="ACTIVE")
    res = handler(make_event("POST", "/apps/dpl00003/deploy", user_id=OTHER, groups=["user"]))
    assert parse_result(res)["status"] == 403


def test_deploy_pipeline_missing_friendly_error(ddb_table, stub_clients) -> None:
    seed_app(ddb_table, "dpl00004", OWNER, status="ACTIVE")
    pipe = StubClient()
    pipe.set_raise("start_pipeline_execution", RuntimeError("PipelineNotFoundException"))
    integ_clients.set_client("codepipeline", pipe)
    res = handler(make_event("POST", "/apps/dpl00004/deploy", user_id=OWNER, groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 409
    assert out["error"]["code"] == "INVALID_STATE"


# ══════════════════════════════════════════════════════════════════════════════
# 작업 2 — 롤백 (POST /apps/{id}/rollback)
# ══════════════════════════════════════════════════════════════════════════════


def _seed_succeeded_deployment(app_id: str, sha: str = "sha123") -> str:
    d = put_deployment(app_id=app_id, trigger="auto", status="SUCCEEDED", commit_sha=sha)
    return d["deploymentId"]


def test_rollback_starts_runtime_build_with_image_tag(ddb_table, stub_clients) -> None:
    seed_app(ddb_table, "rbk00001", OWNER, status="ACTIVE")
    dep_id = _seed_succeeded_deployment("rbk00001", "sha123")
    _ecr(exists=True)
    cb = _codebuild()
    _ssm_platform()
    res = handler(
        make_event(
            "POST", "/apps/rbk00001/rollback", user_id=OWNER, groups=["user"],
            body={"deploymentId": dep_id},
        )
    )
    out = parse_result(res)
    assert out["status"] == 200
    assert out["data"]["trigger"] == "rollback"
    assert out["data"]["commitSha"] == "sha123"
    assert out["data"]["buildId"] == "build-77"
    # provisioner StartBuild env override 에 runtime + IMAGE_TAG.
    ov = {e["name"]: e["value"] for e in cb.calls_for("start_build")[0]["environmentVariablesOverride"]}
    assert ov["APP_STACK_KIND"] == "runtime"
    assert ov["IMAGE_TAG"] == "sha123"
    assert ov["APP_ID"] == "rbk00001"


def test_rollback_unknown_deployment_404(ddb_table, stub_clients) -> None:
    seed_app(ddb_table, "rbk00002", OWNER, status="ACTIVE")
    res = handler(
        make_event(
            "POST", "/apps/rbk00002/rollback", user_id=OWNER, groups=["user"],
            body={"deploymentId": "2099-01-01"},
        )
    )
    assert parse_result(res)["error"]["code"] == "NOT_FOUND"


def test_rollback_non_succeeded_invalid_state(ddb_table, stub_clients) -> None:
    seed_app(ddb_table, "rbk00003", OWNER, status="ACTIVE")
    d = put_deployment(app_id="rbk00003", trigger="auto", status="FAILED", commit_sha="shaX")
    res = handler(
        make_event(
            "POST", "/apps/rbk00003/rollback", user_id=OWNER, groups=["user"],
            body={"deploymentId": d["deploymentId"]},
        )
    )
    assert parse_result(res)["error"]["code"] == "INVALID_STATE"


def test_rollback_image_missing_invalid_state(ddb_table, stub_clients) -> None:
    seed_app(ddb_table, "rbk00004", OWNER, status="ACTIVE")
    dep_id = _seed_succeeded_deployment("rbk00004", "shaGone")
    _ecr(exists=False)
    res = handler(
        make_event(
            "POST", "/apps/rbk00004/rollback", user_id=OWNER, groups=["user"],
            body={"deploymentId": dep_id},
        )
    )
    out = parse_result(res)
    assert out["status"] == 409
    assert out["error"]["code"] == "INVALID_STATE"


def test_rollback_missing_deployment_id_validation(ddb_table, stub_clients) -> None:
    seed_app(ddb_table, "rbk00005", OWNER, status="ACTIVE")
    res = handler(
        make_event("POST", "/apps/rbk00005/rollback", user_id=OWNER, groups=["user"], body={})
    )
    assert parse_result(res)["error"]["code"] == "VALIDATION_ERROR"


def test_rollback_other_owner_forbidden(ddb_table, stub_clients) -> None:
    seed_app(ddb_table, "rbk00006", OWNER, status="ACTIVE")
    dep_id = _seed_succeeded_deployment("rbk00006")
    res = handler(
        make_event(
            "POST", "/apps/rbk00006/rollback", user_id=OTHER, groups=["user"],
            body={"deploymentId": dep_id},
        )
    )
    assert parse_result(res)["status"] == 403


# ══════════════════════════════════════════════════════════════════════════════
# 작업 3 — 시크릿: D8(앱당 1개 JSON) 재구성으로 tests/test_secrets_d8.py 로 이동.
# ══════════════════════════════════════════════════════════════════════════════


# ══════════════════════════════════════════════════════════════════════════════
# 작업 4 — 관리자 강제 중지 (POST /admin/apps/{id}/stop)
# ══════════════════════════════════════════════════════════════════════════════


def _svc(app_id: str, desired: int) -> dict[str, Any]:
    name = f"apphub-{STAGE}-app-{app_id}"
    return {"serviceName": name, "status": "ACTIVE", "desiredCount": desired}


def _forward_rule(target: str, host: str) -> dict[str, Any]:
    return {
        "RuleArn": "arn:...:rule1",
        "Conditions": [{"Field": "host-header", "HostHeaderConfig": {"Values": [host]}}],
        "Actions": [{"Type": "forward", "Order": 1, "TargetGroupArn": target}],
    }


@pytest.fixture
def stop_clients(p2_clients):
    """관리자 강제 중지가 사용하는 SSM(network) + ECS + ELBv2 stub 세팅."""
    _ssm_network()
    return p2_clients


def test_admin_stop_sleeps_app(ddb_table, stop_clients) -> None:
    seed_app(
        ddb_table, "stp00001", OWNER, status="ACTIVE",
        subdomain="stp", scheme="internal", sleepMode="on-demand", runtimeState="RUNNING",
    )
    reserve_subdomain("stp", "stp00001")
    stop_clients["ecs"].set_response("describe_services", {"services": [_svc("stp00001", 1)]})
    stop_clients["elbv2"].set_response(
        "describe_target_groups", {"TargetGroups": [{"TargetGroupArn": "arn:tg:app"}]}
    )
    stop_clients["elbv2"].set_response(
        "describe_rules", {"Rules": [_forward_rule("arn:tg:app", "stp.apps.example.com")]}
    )
    res = handler(make_event("POST", "/admin/apps/stp00001/stop", user_id=ADMIN, groups=["admin"]))
    out = parse_result(res)
    assert out["status"] == 200
    assert out["data"]["runtimeState"] == "SLEEPING"
    assert stop_clients["ecs"].calls_for("update_service")[0]["desiredCount"] == 0
    assert get_app("stp00001")["runtimeState"] == "SLEEPING"


def test_admin_stop_always_on_still_sleeps(ddb_table, stop_clients) -> None:
    seed_app(
        ddb_table, "stp00002", OWNER, status="ACTIVE",
        subdomain="stp2", scheme="internal", sleepMode="always-on", runtimeState="RUNNING",
    )
    reserve_subdomain("stp2", "stp00002")
    stop_clients["ecs"].set_response("describe_services", {"services": [_svc("stp00002", 2)]})
    stop_clients["elbv2"].set_response(
        "describe_target_groups", {"TargetGroups": [{"TargetGroupArn": "arn:tg:app2"}]}
    )
    stop_clients["elbv2"].set_response(
        "describe_rules", {"Rules": [_forward_rule("arn:tg:app2", "stp2.apps.example.com")]}
    )
    res = handler(make_event("POST", "/admin/apps/stp00002/stop", user_id=ADMIN, groups=["admin"]))
    out = parse_result(res)
    assert out["status"] == 200
    # always-on 이라도 관리자 강제 중지는 재운다(force).
    assert stop_clients["ecs"].calls_for("update_service")[0]["desiredCount"] == 0
    assert get_app("stp00002")["runtimeState"] == "SLEEPING"


def test_admin_stop_requires_admin(ddb_table, stop_clients) -> None:
    seed_app(ddb_table, "stp00003", OWNER, status="ACTIVE")
    res = handler(make_event("POST", "/admin/apps/stp00003/stop", user_id=OWNER, groups=["user"]))
    assert parse_result(res)["status"] == 403


def test_admin_stop_missing_app_404(ddb_table, stop_clients) -> None:
    res = handler(make_event("POST", "/admin/apps/nope0001/stop", user_id=ADMIN, groups=["admin"]))
    assert parse_result(res)["error"]["code"] == "NOT_FOUND"


def test_admin_stop_non_active_invalid_state(ddb_table, stop_clients) -> None:
    seed_app(ddb_table, "stp00004", OWNER, status="CREATING")
    res = handler(make_event("POST", "/admin/apps/stp00004/stop", user_id=ADMIN, groups=["admin"]))
    assert parse_result(res)["error"]["code"] == "INVALID_STATE"
