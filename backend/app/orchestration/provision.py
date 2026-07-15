"""ProvisionApp task Lambda 디스패처 (DESIGN.md 3.2, D-M5-01).

step 흐름(ASL 이 Wait/Choice/Retry/Catch 로 감싼다):
  allocate-slot → deploy-pipeline(provisioner CodeBuild StartBuild)
    → poll-build(Choice buildStatus=SUCCEEDED + Wait 루프) → first-deploy(StartPipelineExecution)
    → finalize(status CREATING→ACTIVE/FAILED).
Catch(States.ALL) → finalize(outcome=failure) → Fail.

각 step 반환에 다음 Choice 가 쓸 필드(buildId/buildStatus 등)를 포함한다.
appId 기준 중복 실행 방지는 SFN execution name(=appId)이 1차, finalize 의 조건부 전이가 2차 방어선.
"""

from __future__ import annotations

from typing import Any, Callable

from ..data.alb_registry import allocate_alb_slot
from ..data.apps import clear_failure, get_app, set_failure, transition_status, update_app
from ..data.deployments import put_deployment
from ..integrations.codebuild import get_build_status, start_provisioner_build
from ..integrations.codepipeline import start_pipeline
from ..integrations.ssm import alb_arn_for_scheme, network_param, platform_param
from . import stage
from .failure import build_failure


def _require_app(app_id: str) -> dict[str, Any]:
    app = get_app(app_id)
    if not app:
        raise RuntimeError(f"App 레코드를 찾을 수 없습니다: {app_id}")
    return app


def allocate_slot(e: dict[str, Any]) -> dict[str, Any]:
    """ALB 슬롯 배정(멱등 — 이미 albArn/rulePriority 있으면 재배정하지 않음)."""
    app_id = e["appId"]
    app = _require_app(app_id)
    if app.get("albArn") and app.get("rulePriority") is not None:
        return {
            "step": "allocate-slot",
            "appId": app_id,
            "albArn": app["albArn"],
            "rulePriority": app["rulePriority"],
        }
    scheme = app["scheme"]
    st = stage()
    alb_arn = alb_arn_for_scheme(st, scheme)
    # VPC 선택 기능 제거 — 1차는 플랫폼 부트스트랩 VPC 단일 배치(DESIGN 3.7·10장).
    #  App 레코드에 vpcId 가 없으므로 배치 VPC 는 network SSM(vpc-id)에서 확정한다.
    #  이 값은 AlbRegistry 아이템의 vpcId 속성(관리자 인프라 현황용)으로만 쓰인다.
    vpc_id = network_param(st, "vpc-id")
    slot = allocate_alb_slot(alb_arn, scheme, vpc_id)
    update_app(app_id, {"albArn": slot["albArn"], "rulePriority": slot["rulePriority"]})
    return {
        "step": "allocate-slot",
        "appId": app_id,
        "albArn": slot["albArn"],
        "rulePriority": slot["rulePriority"],
        "needsScaleOut": slot["needsScaleOut"],
    }


def deploy_pipeline(e: dict[str, Any]) -> dict[str, Any]:
    """provisioner CodeBuild 를 StartBuild 로 트리거(app-pipeline 스택 cdk deploy)."""
    app_id = e["appId"]
    st = stage()
    app = _require_app(app_id)
    project_name = platform_param(st, "provisioner-project-name")
    env: dict[str, str] = {
        "APP_ID": app_id,
        "STAGE": st,
        "APP_STACK_KIND": "pipeline",
        "PROVIDER": app["provider"],
        "REPO_URL": app["repoUrl"],
        "BRANCH": app["branch"],
        "AUTO_DEPLOY": str(app.get("autoDeployEnabled")),
    }
    connection_arn = app.get("connectionArn")
    if connection_arn:
        env["CONNECTION_ARN"] = connection_arn
    build_id = start_provisioner_build(project_name, env)
    return {"step": "deploy-pipeline", "appId": app_id, "buildId": build_id}


def poll_build(e: dict[str, Any]) -> dict[str, Any]:
    """provisioner 빌드 상태 조회. FAILED 면 예외(ASL Catch → finalize failure)."""
    build_id = e.get("buildId")
    if not build_id:
        raise RuntimeError("poll-build: buildId 가 필요합니다.")
    build_status = get_build_status(build_id)
    if build_status == "FAILED":
        raise RuntimeError(f"provisioner CodeBuild 실패(build {build_id}).")
    return {"step": "poll-build", "appId": e["appId"], "buildId": build_id, "buildStatus": build_status}


def first_deploy(e: dict[str, Any]) -> dict[str, Any]:
    """앱 파이프라인 첫 실행 트리거 + Deployment(PENDING) 최초 레코드 생성."""
    app_id = e["appId"]
    pipeline_execution_id = start_pipeline(stage(), app_id)
    put_deployment(
        app_id=app_id,
        trigger="auto",
        status="PENDING",
        pipeline_execution_id=pipeline_execution_id,
    )
    out: dict[str, Any] = {"step": "first-deploy", "appId": app_id}
    if pipeline_execution_id:
        out["pipelineExecutionId"] = pipeline_execution_id
    return out


def finalize(e: dict[str, Any]) -> dict[str, Any]:
    """상태 전이 확정. 실패면 CREATING→FAILED, 성공이면 CREATING→ACTIVE(조건부·멱등).

    실패 시 App 레코드에 failureReason/failureDetail 을 남겨 앱 상세에서 사유를 볼 수 있게 한다
    (배포 이력에 잡히기 전 단계 실패도 화면 노출). 성공 시 이전 실패 사유 잔재를 제거한다.
    """
    app_id = e["appId"]
    if e.get("outcome") == "failure":
        failure = build_failure(e, flow="provision")
        # 사유 기록은 상태 전이 성패와 독립(멱등). 전이는 조건부라 이미 다른 상태면 삼킨다.
        set_failure(app_id, failure["failureReason"], failure["failureDetail"])
        try:
            transition_status(app_id, "FAILED", ["CREATING"])
        except Exception:  # noqa: BLE001 - 이미 다른 상태면 전이 실패를 삼킴(멱등)
            pass
        return {"step": "finalize", "appId": app_id, "status": "FAILED"}
    transition_status(app_id, "ACTIVE", ["CREATING"])
    clear_failure(app_id)  # 재시도 성공 후 잔재 제거.
    app = get_app(app_id)
    runtime_state = (app or {}).get("runtimeState") or "SLEEPING"
    return {"step": "finalize", "appId": app_id, "status": "ACTIVE", "runtimeState": runtime_state}


_DISPATCH: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "allocate-slot": allocate_slot,
    "deploy-pipeline": deploy_pipeline,
    "poll-build": poll_build,
    "first-deploy": first_deploy,
    "finalize": finalize,
}


def handle(event: dict[str, Any], _context: Any = None) -> dict[str, Any]:
    """event.step 으로 단계를 분기한다(단일 task Lambda)."""
    step = event.get("step")
    fn = _DISPATCH.get(step)
    if fn is None:
        raise RuntimeError(f"알 수 없는 ProvisionApp step: {step}")
    return fn(event)
