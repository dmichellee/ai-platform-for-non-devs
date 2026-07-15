"""배포 핸들러 (api-contract.md 배포).

수동 배포/롤백은 무거운 작업을 직접 하지 않는다("메인 서버 무부하"):
 - deploy: 앱 파이프라인(app-pipeline)을 StartPipelineExecution 으로 트리거만 하고 접수 응답.
 - rollback: 재빌드 없이 이전 커밋 SHA 이미지 태그로 runtime 스택을 provisioner CodeBuild(StartBuild,
   APP_STACK_KIND=runtime + IMAGE_TAG)로 재배포 트리거만. 진행 상태는 배포 이력/새로고침으로 확인
   (완료 폴링은 하지 않음 — Lambda 무부하 유지, 판단 명시).
Deployment 레코드는 접수 시점에 생성하고 실행 식별자(pipelineExecutionId/buildId)를 담는다.
"""

from __future__ import annotations

from ..config import load_config
from ..data.deployments import list_deployments, put_deployment
from ..domain.validate import parse_body
from ..http.errors import errors
from ..http.response import ProxyResult, created, list_response, ok
from ..http.router import RouteContext
from ..integrations.codebuild import start_provisioner_build
from ..integrations.codepipeline import start_pipeline
from ..integrations.ecr import image_tag_exists
from ..integrations.ssm import platform_param
from .apps import load_owned_app


def trigger_deploy(ctx: RouteContext) -> ProxyResult:
    """POST /apps/{id}/deploy — 수동 배포 트리거. ACTIVE만.

    앱 파이프라인(apphub-{stage}-app-{appId}) StartPipelineExecution → Deployment(PENDING) 접수.
    파이프라인 미존재/실행 실패는 INVALID_STATE 로 친절히 안내(스택 트레이스 노출 금지).
    """
    app = load_owned_app(ctx)
    if app["status"] != "ACTIVE":
        raise errors.invalid_state("앱이 준비된 상태(정상)일 때만 배포할 수 있어요.")

    stage = load_config().stage
    pipeline_execution_id = _start_pipeline_or_friendly_error(stage, app["appId"])

    deployment = put_deployment(
        app_id=app["appId"],
        trigger="manual",
        pipeline_execution_id=pipeline_execution_id,
    )
    return created(
        {
            **deployment,
            "note": "배포 요청이 접수되었어요. 진행 상황은 배포 이력에서 확인할 수 있어요.",
        }
    )


def list_app_deployments(ctx: RouteContext) -> ProxyResult:
    """GET /apps/{id}/deployments — 배포 이력(최신순)."""
    app = load_owned_app(ctx)
    limit = _parse_limit(ctx.query.get("limit"), 20)
    return list_response(list_deployments(app["appId"], limit))


def rollback_deploy(ctx: RouteContext) -> ProxyResult:
    """POST /apps/{id}/rollback — 이전 성공 배포로 되돌리기. body {deploymentId}.

    검증: 대상 Deployment 가 존재하고 SUCCEEDED 이며 commitSha 가 있고, 그 태그 이미지가 ECR 에 실존.
    실행: provisioner CodeBuild(StartBuild) 를 APP_STACK_KIND=runtime + IMAGE_TAG={commitSha} 로 트리거.
      재빌드 없이 runtime 스택만 이미지 태그를 바꿔 재배포한다(DESIGN 9). Deployment(trigger=rollback)
      레코드를 접수 상태(PENDING)로 남기고, 진행 상태는 배포 이력/새로고침으로 확인(완료 폴링 안 함).
    """
    app = load_owned_app(ctx)
    if app["status"] != "ACTIVE":
        raise errors.invalid_state("앱이 준비된 상태(정상)일 때만 되돌릴 수 있어요.")

    body = parse_body(ctx.event.get("body"))
    target_id = body.get("deploymentId")
    if not isinstance(target_id, str) or target_id == "":
        raise errors.validation("되돌릴 배포를 선택해주세요.")

    history = list_deployments(app["appId"], 100)
    target = next((d for d in history if d["deploymentId"] == target_id), None)
    if target is None:
        raise errors.not_found("되돌릴 배포 이력을 찾을 수 없어요.")
    if target["status"] != "SUCCEEDED":
        raise errors.invalid_state("성공한 배포로만 되돌릴 수 있어요.")

    commit_sha = target.get("commitSha")
    if not isinstance(commit_sha, str) or commit_sha == "":
        raise errors.invalid_state("이 배포에는 되돌릴 버전 정보(커밋)가 없어요.")

    stage = load_config().stage
    if not image_tag_exists(stage, app["appId"], commit_sha):
        raise errors.invalid_state(
            "되돌릴 버전의 앱 이미지를 찾을 수 없어요(보관 기간이 지났을 수 있어요)."
        )

    build_id = _start_rollback_build_or_friendly_error(stage, app["appId"], commit_sha)

    deployment = put_deployment(
        app_id=app["appId"],
        trigger="rollback",
        commit_sha=commit_sha,
        commit_message=target.get("commitMessage"),
        build_id=build_id,
    )
    return ok({**deployment, "note": "이전 버전으로 되돌리는 요청이 접수되었어요."})


# ── 내부 헬퍼 ─────────────────────────────────────────────────────────────────


def _start_pipeline_or_friendly_error(stage: str, app_id: str) -> str | None:
    """StartPipelineExecution. 파이프라인 미존재/실행 실패는 INVALID_STATE 로 마스킹."""
    try:
        return start_pipeline(stage, app_id)
    except Exception as err:  # noqa: BLE001 - AWS 예외를 사용자용 친절 에러로 변환
        raise errors.invalid_state(
            "지금은 배포를 시작할 수 없어요. 앱이 아직 준비 중이거나 배포가 진행 중일 수 있어요."
        ) from err


def _start_rollback_build_or_friendly_error(stage: str, app_id: str, commit_sha: str) -> str | None:
    """provisioner CodeBuild(runtime 재배포) StartBuild. 실패는 INVALID_STATE 로 마스킹."""
    project_name = platform_param(stage, "provisioner-project-name")
    env: dict[str, str] = {
        "APP_ID": app_id,
        "STAGE": stage,
        "APP_STACK_KIND": "runtime",
        "IMAGE_TAG": commit_sha,
    }
    try:
        return start_provisioner_build(project_name, env)
    except Exception as err:  # noqa: BLE001
        raise errors.invalid_state(
            "지금은 되돌리기를 시작할 수 없어요. 잠시 후 다시 시도해주세요."
        ) from err


def _parse_limit(raw: str | None, default: int) -> int:
    if raw is None:
        return default
    try:
        value = int(raw)
    except (ValueError, TypeError):
        return default
    return value
