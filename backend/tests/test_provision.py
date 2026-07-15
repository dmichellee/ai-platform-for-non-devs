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
        # VPC 선택 제거 후: allocate-slot 이 배치 VPC 를 network SSM(vpc-id)에서 확정한다.
        f"/apphub/{STAGE}/network/vpc-id": "vpc-platform",
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
    # App 레코드에 vpcId 는 더 이상 없다(VPC 선택 제거). 배치 VPC 는 network SSM 에서 확정된다.
    seed_app(ddb_table, "app1abcd", "user-1", status="CREATING", scheme="internal")
    out = provision.handle({"step": "allocate-slot", "appId": "app1abcd"})
    assert out["step"] == "allocate-slot"
    assert out["albArn"] == INTERNAL_ALB
    assert out["rulePriority"] == 1
    assert out["needsScaleOut"] is False
    # App 레코드에 albArn/rulePriority 영속.
    app = get_app("app1abcd")
    assert app["albArn"] == INTERNAL_ALB
    assert app["rulePriority"] == 1
    # 레지스트리 시드됨 — vpcId 는 network SSM(vpc-id)에서 확정된 플랫폼 VPC.
    reg_items = [i for i in list_alb_registry() if i.get("albArn") == INTERNAL_ALB]
    assert len(reg_items) == 1
    assert reg_items[0]["vpcId"] == "vpc-platform"


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


def test_first_deploy_auto_deploy_off_is_noop(ddb_table, p2_clients, prov_env) -> None:
    # 실측(test3=codecommit, autoDeployEnabled=false): CreatePipeline 자동 첫 실행이 뜬다.
    #  → first-deploy 가 StartPipelineExecution 하면 실행·이력이 중복된다(2건 버그). 따라서
    #  autoDeploy=false 여도 완전 no-op — 아무것도 트리거·기록하지 않는다.
    seed_app(ddb_table, "app5abcd", "user-1", status="CREATING", autoDeployEnabled=False)
    out = provision.handle({"step": "first-deploy", "appId": "app5abcd"})
    assert out == {"step": "first-deploy", "appId": "app5abcd"}
    # StartPipelineExecution 미호출 — CreatePipeline 자동 실행에 전적으로 위임.
    assert p2_clients["codepipeline"].calls_for("start_pipeline_execution") == []
    # Deployment 레코드도 만들지 않는다(deploy-notify 가 Source STARTED 에서 단일 레코드 생성).
    assert list_deployments("app5abcd") == []


def test_first_deploy_auto_deploy_on_is_noop(ddb_table, p2_clients, prov_env) -> None:
    # autoDeployEnabled=true(기본) → 파이프라인 생성 시 CreatePipeline 자동 첫 실행됨.
    #  first-deploy 는 아무것도 트리거하지 않는다(중복 실행·이력 방지). deploy-notify 가
    #  Source STARTED 에서 auto 배포 레코드를 만드는 게 유일한 경로.
    seed_app(ddb_table, "app5auto", "user-1", status="CREATING", autoDeployEnabled=True)
    out = provision.handle({"step": "first-deploy", "appId": "app5auto"})
    assert out == {"step": "first-deploy", "appId": "app5auto"}
    # StartPipelineExecution 미호출.
    assert p2_clients["codepipeline"].calls_for("start_pipeline_execution") == []
    # Deployment 레코드도 만들지 않는다(자동 실행이 만든 것을 신뢰).
    assert list_deployments("app5auto") == []


def test_first_deploy_noop_regardless_of_missing_flag(ddb_table, p2_clients, prov_env) -> None:
    # autoDeployEnabled 필드가 없는 앱(구 레코드 등)도 동일하게 no-op(자동 실행 위임).
    seed_app(ddb_table, "app5miss", "user-1", status="CREATING")
    ddb_table.update_item(
        Key={"PK": "APP#app5miss", "SK": "META"},
        UpdateExpression="REMOVE autoDeployEnabled",
    )
    out = provision.handle({"step": "first-deploy", "appId": "app5miss"})
    assert out == {"step": "first-deploy", "appId": "app5miss"}
    assert p2_clients["codepipeline"].calls_for("start_pipeline_execution") == []
    assert list_deployments("app5miss") == []


def test_finalize_success_keeps_creating(ddb_table, p2_clients, prov_env) -> None:
    # A안: 프로비저닝 성공 finalize 는 ACTIVE 로 전이하지 않고 CREATING 을 유지한다.
    #  ACTIVE 전이는 첫 배포 파이프라인 SUCCEEDED 시 deploy-notify 가 수행한다.
    seed_app(ddb_table, "app6abcd", "user-1", status="CREATING", runtimeState="SLEEPING")
    out = provision.handle({"step": "finalize", "appId": "app6abcd"})
    assert out["status"] == "CREATING"
    assert get_app("app6abcd")["status"] == "CREATING"


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


# ── 실패 사유 저장 (UX 갭 해소) ────────────────────────────────────────────────


def test_finalize_failure_stores_reason_and_detail_by_step(ddb_table, p2_clients, prov_env) -> None:
    # 슬롯 배정 단계 실패 → 사용자용 요약 + 기술 상세(단계 포함) 저장.
    seed_app(ddb_table, "appf01abc", "user-1", status="CREATING")
    provision.handle(
        {
            "step": "finalize",
            "appId": "appf01abc",
            "outcome": "failure",
            "failedStep": "allocate-slot",
            "error": "no free rule priority",
        }
    )
    app = get_app("appf01abc")
    assert app["status"] == "FAILED"
    assert app["failureReason"] == "앱 주소/자리 배정 중 문제가 발생했어요. 다시 시도하거나 관리자에게 문의해주세요."
    assert "allocate-slot" in app["failureDetail"]
    assert "no free rule priority" in app["failureDetail"]


def test_finalize_failure_deploy_pipeline_reason(ddb_table, p2_clients, prov_env) -> None:
    seed_app(ddb_table, "appf02abc", "user-1", status="CREATING")
    provision.handle(
        {"step": "finalize", "appId": "appf02abc", "outcome": "failure", "failedStep": "poll-build"}
    )
    app = get_app("appf02abc")
    assert app["failureReason"].startswith("배포 준비(빌드 환경 구성) 중 문제가 발생했어요.")


def test_finalize_failure_first_deploy_reason(ddb_table, p2_clients, prov_env) -> None:
    seed_app(ddb_table, "appf03abc", "user-1", status="CREATING")
    provision.handle(
        {
            "step": "finalize",
            "appId": "appf03abc",
            "outcome": "failure",
            "failedStep": "first-deploy",
        }
    )
    assert get_app("appf03abc")["failureReason"].startswith("첫 배포를 시작하지 못했어요.")


def test_finalize_failure_masks_secret_arn_in_detail(ddb_table, p2_clients, prov_env) -> None:
    # 예외 Cause 에 시크릿 ARN 이 섞여 와도 failureDetail 에 원문이 남지 않는다.
    seed_app(ddb_table, "appf04abc", "user-1", status="CREATING")
    provision.handle(
        {
            "step": "finalize",
            "appId": "appf04abc",
            "outcome": "failure",
            "failedStep": "deploy-pipeline",
            "error": "AccessDenied on arn:aws:secretsmanager:ap-northeast-2:111122223333:secret:db-AbCdEf",
        }
    )
    detail = get_app("appf04abc")["failureDetail"]
    assert "arn:aws:secretsmanager" not in detail
    assert "db-AbCdEf" not in detail
    assert "[리소스]" in detail


def test_finalize_failure_without_step_uses_provision_fallback(ddb_table, p2_clients, prov_env) -> None:
    # failedStep 없이(step=finalize) 온 실패 → provision 흐름 폴백 요약.
    seed_app(ddb_table, "appf05abc", "user-1", status="CREATING")
    provision.handle({"step": "finalize", "appId": "appf05abc", "outcome": "failure"})
    app = get_app("appf05abc")
    assert app["failureReason"].startswith("앱을 만드는 중 문제가 발생했어요.")


def test_finalize_success_does_not_clear_failure_yet(ddb_table, p2_clients, prov_env) -> None:
    # A안: 성공 finalize 는 status 를 CREATING 유지하고 clear_failure 도 하지 않는다.
    #  실패 사유 잔재 제거는 첫 배포 SUCCEEDED 시 deploy-notify 가 담당한다(status→ACTIVE 와 함께).
    seed_app(
        ddb_table,
        "appf06abc",
        "user-1",
        status="CREATING",
        failureReason="앱 주소/자리 배정 중 문제가 발생했어요. 다시 시도하거나 관리자에게 문의해주세요.",
        failureDetail="단계: allocate-slot | boom",
    )
    out = provision.handle({"step": "finalize", "appId": "appf06abc"})
    assert out["status"] == "CREATING"
    app = get_app("appf06abc")
    assert app["status"] == "CREATING"
