"""배포 핸들러 (api-contract.md 배포).

[M3 stub] deploy/rollback은 배포 이력 레코드 생성 + 접수 응답까지. 실제 파이프라인 실행은 후속 연결.
"""

from __future__ import annotations

from ..data.deployments import list_deployments, put_deployment
from ..domain.validate import parse_body
from ..http.errors import errors
from ..http.response import ProxyResult, created, list_response, ok
from ..http.router import RouteContext
from .apps import load_owned_app


def trigger_deploy(ctx: RouteContext) -> ProxyResult:
    """POST /apps/{id}/deploy — 수동 배포 트리거(stub). ACTIVE만."""
    app = load_owned_app(ctx)
    if app["status"] != "ACTIVE":
        raise errors.invalid_state("앱이 준비된 상태(정상)일 때만 배포할 수 있어요.")
    deployment = put_deployment(app_id=app["appId"], trigger="manual")
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
    """POST /apps/{id}/rollback — 이전 성공 배포로 되돌리기(stub). body {deploymentId}."""
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
    deployment = put_deployment(
        app_id=app["appId"],
        trigger="rollback",
        commit_sha=target.get("commitSha"),
        commit_message=target.get("commitMessage"),
    )
    return ok({**deployment, "note": "이전 버전으로 되돌리는 요청이 접수되었어요."})


def _parse_limit(raw: str | None, default: int) -> int:
    if raw is None:
        return default
    try:
        value = int(raw)
    except (ValueError, TypeError):
        return default
    return value
