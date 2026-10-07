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
from app.data.deployments import list_deployments, put_deployment
from app.data.subdomains import reserve_subdomain
from app.handler import handler
from app.integrations import clients as integ_clients
from app.orchestration import deploy_notify as dn

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
            # D20: ALB별 Waker TG(n=0 internal 은 신규 TG — legacy 폴백 없음, 계약 §1.2).
            f"/apphub/{STAGE}/network/alb/internal/0/waker-tg-arn": "arn:tg:waker",
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


# ── 접수 ↔ deploy-notify 경합(실행 즉시 실패로 종결 이벤트가 접수 기록보다 먼저 옴) ─────────

_SOURCE_FAILED = {"actionExecutionDetails": [{"stageName": "Source", "status": "Failed"}]}


def _pipeline_event(app_id: str, state: str, execution_id: str = "exec-99") -> dict[str, Any]:
    return {
        "detail-type": "CodePipeline Pipeline Execution State Change",
        "detail": {"pipeline": f"apphub-{STAGE}-app-{app_id}", "state": state, "execution-id": execution_id},
    }


def _stage_event(app_id: str, stage_name: str, execution_id: str = "exec-99") -> dict[str, Any]:
    return {
        "detail-type": "CodePipeline Stage Execution State Change",
        "detail": {
            "pipeline": f"apphub-{STAGE}-app-{app_id}",
            "stage": stage_name,
            "state": "STARTED",
            "execution-id": execution_id,
        },
    }


def _deploy(app_id: str) -> dict[str, Any]:
    return parse_result(handler(make_event("POST", f"/apps/{app_id}/deploy", user_id=OWNER, groups=["user"])))


def test_deploy_race_terminal_event_first_single_manual_failed(ddb_table, stub_clients) -> None:
    """종결 이벤트(FAILED)가 먼저 와 notify 가 auto FAILED 를 만든 뒤 접수 기록 → 레코드 1건 manual FAILED."""
    seed_app(ddb_table, "dpl00010", OWNER, status="ACTIVE")
    pipe = _codepipeline()
    pipe.set_response("list_action_executions", _SOURCE_FAILED)
    first = dn.handle_event(_pipeline_event("dpl00010", "FAILED"))
    assert first["created"] is True

    out = _deploy("dpl00010")
    assert out["status"] == 201
    data = out["data"]
    assert data["trigger"] == "manual"
    assert data["status"] == "FAILED"  # 종결 유지(역행 금지) — PENDING 으로 되돌리지 않음
    assert data["failureCategory"] == "SOURCE_UNAVAILABLE"
    assert data["pipelineExecutionId"] == "exec-99"
    assert "note" in data
    deps = list_deployments("dpl00010", 20)
    assert len(deps) == 1
    assert deps[0]["trigger"] == "manual"
    assert deps[0]["status"] == "FAILED"
    # 늦게 온 Source STARTED 도 새 레코드를 만들지 않는다.
    assert dn.handle_event(_stage_event("dpl00010", "Source"))["reason"] == "terminal-FAILED-preserved"
    assert len(list_deployments("dpl00010", 20)) == 1


def test_deploy_race_source_started_first_adopted_as_manual(ddb_table, stub_clients) -> None:
    """Source STARTED 가 먼저 와 auto PENDING 이 생긴 뒤 접수 → 1건 manual PENDING, 이후 SUCCEEDED."""
    seed_app(ddb_table, "dpl00011", OWNER, status="ACTIVE")
    _codepipeline()
    assert dn.handle_event(_stage_event("dpl00011", "Source"))["created"] is True
    out = _deploy("dpl00011")
    assert out["data"]["trigger"] == "manual"
    assert out["data"]["status"] == "PENDING"
    dn.handle_event(_stage_event("dpl00011", "Deploy"))
    dn.handle_event(_pipeline_event("dpl00011", "SUCCEEDED"))
    deps = list_deployments("dpl00011", 20)
    assert len(deps) == 1
    assert deps[0]["trigger"] == "manual"
    assert deps[0]["status"] == "SUCCEEDED"


def test_deploy_normal_order_single_record_no_regression(ddb_table, stub_clients) -> None:
    """정상 순서: 접수(manual PENDING, 클레임) → 스테이지/종결 이벤트 → 1건 manual SUCCEEDED."""
    seed_app(ddb_table, "dpl00012", OWNER, status="ACTIVE")
    _codepipeline()
    out = _deploy("dpl00012")
    assert out["data"]["status"] == "PENDING"
    assert "created" not in dn.handle_event(_stage_event("dpl00012", "Source"))
    dn.handle_event(_stage_event("dpl00012", "ValidateBuild"))
    res = dn.handle_event(_pipeline_event("dpl00012", "SUCCEEDED"))
    assert res["status"] == "SUCCEEDED"
    assert "created" not in res
    deps = list_deployments("dpl00012", 20)
    assert len(deps) == 1
    assert deps[0]["trigger"] == "manual"
    assert deps[0]["deploymentId"] == out["data"]["deploymentId"]
    claims = [i for i in ddb_table.scan()["Items"] if i["SK"].startswith("DEPLOYEXEC#")]
    assert [c["SK"] for c in claims] == ["DEPLOYEXEC#exec-99"]


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
    assert ov["DEPLOY_TRIGGER"] == "rollback"


def _rollback_build_event(app_id: str, status: str, trigger: str | None = "rollback") -> dict[str, Any]:
    env = [
        {"name": "APP_ID", "value": app_id},
        {"name": "APP_STACK_KIND", "value": "runtime"},
        {"name": "IMAGE_TAG", "value": "sha123"},
    ]
    if trigger is not None:
        env.append({"name": "DEPLOY_TRIGGER", "value": trigger})
    return {
        "detail-type": "CodeBuild Build State Change",
        "detail": {
            "build-status": status,
            "project-name": f"apphub-{STAGE}-provisioner",
            "build-id": "arn:aws:codebuild:ap-northeast-2:111122223333:build/build-77",
            "additional-information": {"environment": {"environment-variables": env}},
        },
    }


def _rollback(app_id: str, dep_id: str) -> dict[str, Any]:
    return parse_result(
        handler(
            make_event(
                "POST", f"/apps/{app_id}/rollback", user_id=OWNER, groups=["user"],
                body={"deploymentId": dep_id},
            )
        )
    )


def test_rollback_race_build_failed_event_first_single_record(ddb_table, stub_clients, monkeypatch) -> None:
    """StartBuild 직후 빌드 FAILED 이벤트가 접수 기록보다 먼저 처리 → 레코드 1건 rollback FAILED."""
    from app.domain import redeploy as redeploy_mod

    seed_app(ddb_table, "rbk00010", OWNER, status="ACTIVE")
    dep_id = put_deployment(
        app_id="rbk00010", trigger="auto", status="SUCCEEDED", commit_sha="sha123", commit_message="v1"
    )["deploymentId"]
    _ecr(exists=True)
    _codebuild()
    _ssm_platform()
    real_start = redeploy_mod.start_provisioner_build

    def start_then_event(project: str, env: dict[str, str]) -> str:
        build_id = real_start(project, env)
        created = dn.handle_event(_rollback_build_event("rbk00010", "FAILED", env["DEPLOY_TRIGGER"]))
        assert created["created"] is True
        return build_id

    monkeypatch.setattr(redeploy_mod, "start_provisioner_build", start_then_event)
    out = _rollback("rbk00010", dep_id)
    assert out["status"] == 200
    assert out["data"]["trigger"] == "rollback"
    assert out["data"]["status"] == "FAILED"
    assert out["data"]["failureCategory"] == "DEPLOY_FAILED"
    assert out["data"]["commitMessage"] == "v1"  # 접수 쪽이 비어 있던 커밋 메시지를 보정
    rollbacks = [d for d in list_deployments("rbk00010", 20) if d.get("buildId") == "build-77"]
    assert len(rollbacks) == 1
    assert len(list_deployments("rbk00010", 20)) == 2  # 원래 성공 배포 + 롤백 1건


def test_rollback_normal_order_event_advances_existing(ddb_table, stub_clients) -> None:
    """정상 순서: 접수(PENDING, 클레임) → 빌드 이벤트(DEPLOY_TRIGGER 있음) → 새로 만들지 않고 전진."""
    seed_app(ddb_table, "rbk00011", OWNER, status="ACTIVE")
    dep_id = _seed_succeeded_deployment("rbk00011", "sha123")
    _ecr(exists=True)
    _codebuild()
    _ssm_platform()
    assert _rollback("rbk00011", dep_id)["data"]["status"] == "PENDING"
    res = dn.handle_event(_rollback_build_event("rbk00011", "FAILED"))
    assert "created" not in res
    assert res["status"] == "FAILED"
    rollbacks = [d for d in list_deployments("rbk00011", 20) if d["trigger"] == "rollback"]
    assert len(rollbacks) == 1
    assert rollbacks[0]["status"] == "FAILED"


def test_build_event_without_trigger_env_and_no_record_skipped(ddb_table, stub_clients) -> None:
    """DEPLOY_TRIGGER 없는 빌드(이전 버전에서 시작 등)는 trigger 판단 불가 → 레코드 만들지 않음."""
    seed_app(ddb_table, "rbk00012", OWNER, status="ACTIVE")
    res = dn.handle_event(_rollback_build_event("rbk00012", "FAILED", trigger=None))
    assert res["reason"] == "no-record-skipped"
    assert list_deployments("rbk00012", 20) == []
    res = dn.handle_event(_rollback_build_event("rbk00012", "FAILED", trigger="manual"))
    assert res["reason"] == "no-record-skipped"


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
