"""ProvisionApp task Lambda 디스패처 (D-M5-01).

step 흐름(ASL 이 Wait/Choice/Retry/Catch 로 감싼다):
  allocate-slot(slotStatus=WAIT 면 Wait 30초 → 재호출, D20) → deploy-pipeline(provisioner CodeBuild StartBuild)
    → poll-build(Choice buildStatus=SUCCEEDED + Wait 루프) → first-deploy(no-op — 파이프라인
      생성 시 CreatePipeline 자동 실행에 위임, StartPipelineExecution 호출 안 함)
    → finalize(성공: status CREATING 유지 / 실패: CREATING→FAILED).
Catch(States.ALL) → finalize(outcome=failure) → Fail.

프로비저닝 성공은 status 를 ACTIVE 로 바꾸지 않는다(A안) — 첫 배포(앱 빌드·기동)는 별도 비동기
파이프라인이라, 그 파이프라인이 SUCCEEDED 로 종결될 때 deploy-notify 가 CREATING→ACTIVE 로,
FAILED 면 CREATING→FAILED 로 전이한다. CREATING 은 프로비저닝 시작부터 첫 배포 완료까지 유지된다.

각 step 반환에 다음 Choice 가 쓸 필드(buildId/buildStatus 등)를 포함한다.
appId 기준 중복 실행 방지는 SFN execution name(=appId)이 1차, finalize 의 조건부 전이가 2차 방어선.
"""

from __future__ import annotations

from typing import Any, Callable

from ..data.alb_registry import (
    ALB_SCALE_OUT_SPARE,
    allocate_alb_slot,
    delete_pending,
    list_pending,
    next_alb_index,
    reserve_pending,
    set_pending_build,
)
from ..data.apps import get_app, set_failure, transition_status, update_app
from ..domain.alb_scheme import scheme_slug
from ..domain.auto_deploy import PIPELINE_BUILD_FIELD, start_pipeline_stack_build
from ..integrations.codebuild import get_build_status, start_provisioner_build
from ..integrations.ssm import alb_param, network_param, platform_param
from . import stage
from .failure import build_failure


def _require_app(app_id: str) -> dict[str, Any]:
    app = get_app(app_id)
    if not app:
        raise RuntimeError(f"App 레코드를 찾을 수 없습니다: {app_id}")
    return app


def allocate_slot(e: dict[str, Any]) -> dict[str, Any]:
    """ALB 슬롯 배정(D20, 계약 §3.4·§4). ASSIGNED 또는 WAIT 반환.

    - 멱등: App 에 albArn/rulePriority 가 이미 있으면 재배정 없이 ASSIGNED(albIndex 없으면 0).
    - 같은 scheme 의 ACTIVE ALB 를 index 순으로 `ruleCount<90` 조건부 +1 → App 에 albArn/albIndex/
      rulePriority 기록. 배정 후 여유 ≤ 10 이면 선제 증설 시작(기다리지 않음).
    - 모두 90 이면 증설 시작(또는 진행 중 PENDING 확인) 후 WAIT — ASL 이 Wait 30초 → 재호출.
    """
    app_id = e["appId"]
    app = _require_app(app_id)
    if app.get("albArn") and app.get("rulePriority") is not None:
        return {
            "step": "allocate-slot",
            "appId": app_id,
            "slotStatus": "ASSIGNED",
            "albArn": app["albArn"],
            "albIndex": int(app.get("albIndex") or 0),
            "rulePriority": app["rulePriority"],
        }
    scheme = app["scheme"]
    st = stage()
    seed_alb_arn = alb_param(st, scheme, 0, "alb-arn")
    # VPC 선택 기능 제거 — 1차는 플랫폼 부트스트랩 VPC 단일 배치.
    #  배치 VPC 는 network SSM(vpc-id)에서 확정(AlbRegistry.vpcId — 관리자 인프라 현황용).
    vpc_id = network_param(st, "vpc-id")
    slot = allocate_alb_slot(scheme, seed_alb_arn, vpc_id)
    if slot["slotStatus"] != "ASSIGNED":
        scale = ensure_scale_out(st, scheme)
        print("[allocate-slot] WAIT", {"appId": app_id, "scheme": scheme, **scale})
        return {"step": "allocate-slot", "appId": app_id, "slotStatus": "WAIT"}
    update_app(
        app_id,
        {
            "albArn": slot["albArn"],
            "albIndex": slot["albIndex"],
            "rulePriority": slot["rulePriority"],
        },
    )
    if slot["spare"] <= ALB_SCALE_OUT_SPARE:
        scale = ensure_scale_out(st, scheme)
        print("[allocate-slot] scale-out", {"appId": app_id, "scheme": scheme, **scale})
    return {
        "step": "allocate-slot",
        "appId": app_id,
        "slotStatus": "ASSIGNED",
        "albArn": slot["albArn"],
        "albIndex": slot["albIndex"],
        "rulePriority": slot["rulePriority"],
    }


def ensure_scale_out(st: str, scheme: str) -> dict[str, Any]:
    """다음 ALB 증설을 시작(멱등). 진행 중 PENDING 이 있으면 아무것도 하지 않는다.

    PENDING 조건부 Put(중복 방지) → provisioner StartBuild(APP_STACK_KIND=alb, 계약 §5) → buildId 기록.
    StartBuild 실패 시 PENDING 을 지우고 삼킨다(다음 배정 호출이 재시도) — 배정 흐름을 깨지 않는다.
    완료(PENDING→ALB# ACTIVE)는 deploy-notify 가 provisioner Build State Change 로 처리한다.
    """
    slug = scheme_slug(scheme)
    pending = list_pending(slug)
    if pending:
        return {"scaleOut": "in-progress", "albIndex": pending[0]["index"]}
    index = next_alb_index(slug, pending)
    if not reserve_pending(slug, index):
        return {"scaleOut": "in-progress", "albIndex": index}
    try:
        project_name = platform_param(st, "provisioner-project-name")
        build_id = start_provisioner_build(
            project_name,
            {
                "APP_ID": "-",
                "STAGE": st,
                "APP_STACK_KIND": "alb",
                "ALB_SCHEME": slug,
                "ALB_INDEX": str(index),
            },
        )
    except Exception as err:  # noqa: BLE001 - 증설 시작 실패는 배정 흐름을 깨지 않는다(재시도)
        delete_pending(slug, index)
        print("[allocate-slot] scale-out start failed:", str(err))
        return {"scaleOut": "start-failed", "albIndex": index}
    set_pending_build(slug, index, build_id)
    return {"scaleOut": "started", "albIndex": index, "buildId": build_id}


def deploy_pipeline(e: dict[str, Any]) -> dict[str, Any]:
    """provisioner CodeBuild 를 StartBuild 로 트리거(app-pipeline 스택 cdk deploy).

    env 는 자동 배포 토글 반영(PATCH, QA M4)과 같은 단일 원본(domain.auto_deploy.pipeline_build_env).
    build id 를 App.pipelineStackBuildId 에 남겨 PATCH 가 "스택 빌드 진행 중/완료"를 판정하게 한다.
    """
    app_id = e["appId"]
    st = stage()
    app = _require_app(app_id)
    build_id = start_pipeline_stack_build(st, app)
    try:
        update_app(app_id, {PIPELINE_BUILD_FIELD: build_id})
    except Exception as err:  # noqa: BLE001 - 추적 기록 실패는 프로비저닝을 막지 않는다
        print("[deploy-pipeline] build id record failed:", type(err).__name__)
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
    """앱 파이프라인 첫 배포 — autoDeploy on/off 무관 완전 no-op(finalize 로 흐름만 잇는다).

    CodePipeline 은 CloudFormation 이 파이프라인을 생성하는 순간 AWS 가 첫 실행을 자동으로 건다
    (`CreatePipeline` 트리거). 이 자동 실행은 **autoDeploy on/off·provider 무관하게 파이프라인
    생성 시 항상 1회 발생한다(실측 확인: test3 = codecommit, autoDeployEnabled=false 에서도 발생.
    실행 2건 중 46819161 이 trigger=CreatePipeline 으로 떴다). AWS 문서대로 source 트리거 설정과
    무관하며 CDK L2 에 억제 옵션이 없다.

    그 자동 실행을 deploy-notify 가 Source STARTED 이벤트로 잡아 단일 Deployment 레코드(커밋
    정보 포함)를 만드는 것이 유일한 첫 배포 이력 경로다. 따라서 first-deploy 는 StartPipelineExecution
    도, put_deployment 도 호출하지 않는다 — 무엇이든 트리거하면 실행·이력이 중복된다(이력 2건 버그).

    타이밍: poll-build 가 provisioner CodeBuild(app-pipeline 스택 cdk deploy) 의 SUCCEEDED 를
    기다리므로, first-deploy 시점엔 이미 파이프라인 생성이 끝나 CreatePipeline 자동 실행이 시작돼 있다.
    """
    app_id = e["appId"]
    _require_app(app_id)  # 존재만 확인(실패면 ASL Catch → finalize failure). 아무것도 트리거하지 않는다.
    return {"step": "first-deploy", "appId": app_id}


def finalize(e: dict[str, Any]) -> dict[str, Any]:
    """프로비저닝 단계 종결. 실패면 CREATING→FAILED. 성공이면 status 를 건드리지 않는다.

    성공(outcome=success)의 의미: ALB 슬롯 배정 + provisioner 빌드(app-pipeline 스택 cdk deploy)
    완료 + 첫 배포 파이프라인의 CreatePipeline 자동 실행 트리거까지. 하지만 이 시점엔 아직 첫 배포
    (앱 빌드·기동)가 진행 중이라 앱이 실제로 뜬 게 아니다. 따라서 CREATING→ACTIVE 전이는 여기서
    하지 않고, 첫 배포 파이프라인이 SUCCEEDED 로 종결될 때 deploy-notify 가 수행한다(A안).
      - 첫 배포 SUCCEEDED → deploy-notify 가 CREATING→ACTIVE (+ clear_failure, runtimeState=RUNNING)
      - 첫 배포 FAILED    → deploy-notify 가 CREATING→FAILED (+ set_failure)
    finalize 성공은 status 를 CREATING 그대로 두므로 clear_failure 도 여기서 하지 않는다
    (첫 배포 성공 시 deploy-notify 가 잔재를 제거한다).

    실패 시(outcome=failure)는 프로비저닝 단계 자체 실패(슬롯 배정/빌드 환경 구성/스택 생성)이므로
    첫 배포에 도달하지 못한다 — 여전히 여기서 CREATING→FAILED 로 확정하고 App 레코드에
    failureReason/failureDetail 을 남겨 앱 상세에서 사유를 볼 수 있게 한다(배포 이력에 잡히기 전 단계).
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
    # 성공: status 는 CREATING 유지(ACTIVE 전이는 첫 배포 완료 시 deploy-notify 담당).
    #  ASL 은 finalize 반환 status 를 검사하지 않고 곧장 Succeed 로 종료하므로 흐름은 그대로 유효하다.
    return {"step": "finalize", "appId": app_id, "status": "CREATING"}


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
