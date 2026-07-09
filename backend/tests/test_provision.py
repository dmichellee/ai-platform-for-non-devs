"""ProvisionApp task 디스패처 테스트 (D-M5-01) — step 분기·상태 전이·멱등."""

from __future__ import annotations

import pytest
from app.data.apps import get_app
from app.data.config_repo import list_alb_registry
from app.data.deployments import list_deployments
from app.integrations import clients as integ_clients
from app.orchestration import provision

from .conftest import SsmStub, seed_app

STAGE = "test"
INTERNAL_ALB = "arn:aws:elasticloadbalancing:ap-northeast-2:111122223333:loadbalancer/app/internal/x"


@pytest.fixture
def prov_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STAGE", STAGE)


def _ssm(overrides: dict[str, str] | None = None) -> SsmStub:
    params = {
        f"/apphub/{STAGE}/network/internal-alb-arn": INTERNAL_ALB,
        f"/apphub/{STAGE}/network/internet-alb-arn": "arn:...:internet",
        f"/apphub/{STAGE}/platform/provisioner-project-name": "apphub-test-provisioner",
    }
    params.update(overrides or {})
    stub = SsmStub(params)
    integ_clients.set_client("ssm", stub)
    return stub


def test_unknown_step_raises(ddb_table, prov_env) -> None:
    with pytest.raises(RuntimeError, match="알 수 없는 ProvisionApp step"):
        provision.handle({"step": "nope", "appId": "a1"})


def test_allocate_slot_assigns_priority_and_persists(ddb_table, p2_clients, prov_env) -> None:
    _ssm()
    seed_app(ddb_table, "app1abcd", "user-1", status="CREATING", scheme="internal", vpcId="vpc-1")
    out = provision.handle({"step": "allocate-slot", "appId": "app1abcd"})
    assert out["step"] == "allocate-slot"
    assert out["albArn"] == INTERNAL_ALB
    assert out["rulePriority"] == 1
    assert out["needsScaleOut"] is False
    # App 레코드에 albArn/rulePriority 영속.
    app = get_app("app1abcd")
    assert app["albArn"] == INTERNAL_ALB
    assert app["rulePriority"] == 1
    # 레지스트리 시드됨.
    assert any(i.get("albArn") == INTERNAL_ALB for i in list_alb_registry())


def test_allocate_slot_idempotent_when_already_assigned(ddb_table, p2_clients, prov_env) -> None:
    _ssm()
    seed_app(
        ddb_table,
        "app2abcd",
        "user-1",
        status="CREATING",
        scheme="internal",
        albArn=INTERNAL_ALB,
        rulePriority=7,
    )
    out = provision.handle({"step": "allocate-slot", "appId": "app2abcd"})
    # 이미 배정됨 → 재배정 없이 기존 값 반환, needsScaleOut 미포함.
    assert out["albArn"] == INTERNAL_ALB
    assert out["rulePriority"] == 7
    assert "needsScaleOut" not in out
    # priority 카운터 미사용(레지스트리 시드 안 함).
    assert list_alb_registry() == []


def test_deploy_pipeline_starts_provisioner_build(ddb_table, p2_clients, prov_env) -> None:
    _ssm()
    seed_app(
        ddb_table,
        "app3abcd",
        "user-1",
        status="CREATING",
        provider="github",
        repoUrl="https://github.com/o/r",
        branch="main",
        autoDeployEnabled=True,
        connectionArn="arn:aws:codeconnections:...:connection/xyz",
    )
    p2_clients["codebuild"].set_response("start_build", {"build": {"id": "build-123"}})
    out = provision.handle({"step": "deploy-pipeline", "appId": "app3abcd"})
    assert out == {"step": "deploy-pipeline", "appId": "app3abcd", "buildId": "build-123"}
    call = p2_clients["codebuild"].calls_for("start_build")[0]
    assert call["projectName"] == "apphub-test-provisioner"
    env = {e["name"]: e["value"] for e in call["environmentVariablesOverride"]}
    assert env["APP_ID"] == "app3abcd"
    assert env["APP_STACK_KIND"] == "pipeline"
    assert env["PROVIDER"] == "github"
    assert env["REPO_URL"] == "https://github.com/o/r"
    assert env["AUTO_DEPLOY"] == "True"
    assert env["CONNECTION_ARN"] == "arn:aws:codeconnections:...:connection/xyz"


def test_deploy_pipeline_omits_connection_when_absent(ddb_table, p2_clients, prov_env) -> None:
    _ssm()
    seed_app(ddb_table, "app4abcd", "user-1", status="CREATING", provider="codecommit")
    p2_clients["codebuild"].set_response("start_build", {"build": {"id": "b"}})
    provision.handle({"step": "deploy-pipeline", "appId": "app4abcd"})
    call = p2_clients["codebuild"].calls_for("start_build")[0]
    env = {e["name"]: e["value"] for e in call["environmentVariablesOverride"]}
    assert "CONNECTION_ARN" not in env


def test_poll_build_success_passthrough(ddb_table, p2_clients, prov_env) -> None:
    p2_clients["codebuild"].set_response(
        "batch_get_builds", {"builds": [{"buildStatus": "SUCCEEDED"}]}
    )
    out = provision.handle({"step": "poll-build", "appId": "a", "buildId": "b1"})
    assert out["buildStatus"] == "SUCCEEDED"


def test_poll_build_in_progress(ddb_table, p2_clients, prov_env) -> None:
    p2_clients["codebuild"].set_response(
        "batch_get_builds", {"builds": [{"buildStatus": "IN_PROGRESS"}]}
    )
    out = provision.handle({"step": "poll-build", "appId": "a", "buildId": "b1"})
    assert out["buildStatus"] == "IN_PROGRESS"


def test_poll_build_failed_raises(ddb_table, p2_clients, prov_env) -> None:
    p2_clients["codebuild"].set_response(
        "batch_get_builds", {"builds": [{"buildStatus": "FAILED"}]}
    )
    with pytest.raises(RuntimeError, match="provisioner CodeBuild 실패"):
        provision.handle({"step": "poll-build", "appId": "a", "buildId": "b1"})


def test_poll_build_requires_build_id(ddb_table, p2_clients, prov_env) -> None:
    with pytest.raises(RuntimeError, match="buildId 가 필요"):
        provision.handle({"step": "poll-build", "appId": "a"})


def test_first_deploy_starts_pipeline_and_records_deployment(ddb_table, p2_clients, prov_env) -> None:
    seed_app(ddb_table, "app5abcd", "user-1", status="CREATING")
    p2_clients["codepipeline"].set_response(
        "start_pipeline_execution", {"pipelineExecutionId": "exec-9"}
    )
    out = provision.handle({"step": "first-deploy", "appId": "app5abcd"})
    assert out["pipelineExecutionId"] == "exec-9"
    call = p2_clients["codepipeline"].calls_for("start_pipeline_execution")[0]
    assert call["name"] == "apphub-test-app-app5abcd"
    # PENDING Deployment 레코드 생성.
    deps = list_deployments("app5abcd")
    assert len(deps) == 1
    assert deps[0]["status"] == "PENDING"
    assert deps[0]["trigger"] == "auto"
    assert deps[0]["pipelineExecutionId"] == "exec-9"


def test_finalize_success_transitions_creating_to_active(ddb_table, p2_clients, prov_env) -> None:
    seed_app(ddb_table, "app6abcd", "user-1", status="CREATING", runtimeState="SLEEPING")
    out = provision.handle({"step": "finalize", "appId": "app6abcd"})
    assert out["status"] == "ACTIVE"
    assert out["runtimeState"] == "SLEEPING"
    assert get_app("app6abcd")["status"] == "ACTIVE"


def test_finalize_failure_transitions_creating_to_failed(ddb_table, p2_clients, prov_env) -> None:
    seed_app(ddb_table, "app7abcd", "user-1", status="CREATING")
    out = provision.handle({"step": "finalize", "appId": "app7abcd", "outcome": "failure"})
    assert out["status"] == "FAILED"
    assert get_app("app7abcd")["status"] == "FAILED"


def test_finalize_failure_is_idempotent_when_not_creating(ddb_table, p2_clients, prov_env) -> None:
    # 이미 ACTIVE 인 앱에 실패 finalize → 전이 조건 실패를 삼키고 status 유지.
    seed_app(ddb_table, "app8abcd", "user-1", status="ACTIVE")
    out = provision.handle({"step": "finalize", "appId": "app8abcd", "outcome": "failure"})
    assert out["status"] == "FAILED"  # 반환은 FAILED 라벨이지만
    assert get_app("app8abcd")["status"] == "ACTIVE"  # 실제 상태는 조건부라 불변
