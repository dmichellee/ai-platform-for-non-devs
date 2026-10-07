"""로그 핸들러 (api-contract.md 로그, QA M6/A5 2026-10-08). 소유자/관리자만.

- GET /apps/{id}/logs — 앱 실행 로그(최신부터, 시간 내림차순).
- GET /apps/{id}/deployments/{deploymentId}/logs — 그 배포의 CodeBuild 로그(검사·빌드 / 배포 / provisioner).
  해석 순서: (a) 레코드 buildId(provisioner 롤백·시크릿 변경) → BatchGetBuilds → 로그 위치.
            (b) pipelineExecutionId → ListActionExecutions 에서 실패 액션 우선, 없으면 가장 뒤 단계
                (Deploy > ValidateBuild)의 CodeBuild build id → (a)와 동일.
  로그가 아직 없으면(빌드 전/Source 단계/스트림 미생성) events:[] 200.
무거운 처리 없음 — 조회 API 몇 회(메인 서버 무부하).
"""

from __future__ import annotations

from typing import Any

from ..config import load_config
from ..data.deployments import get_deployment
from ..http.errors import errors
from ..http.query import int_param
from ..http.response import ProxyResult, ok
from ..http.router import RouteContext
from ..integrations.codebuild import build_log_location, get_build
from ..integrations.codepipeline import list_action_executions
from ..integrations.logs import (
    LogQueryInvalid,
    LogQueryThrottled,
    fetch_app_logs,
    fetch_stream_logs,
)
from .apps import load_owned_app

_BAD_QUERY = "로그 조회 조건이 올바르지 않아요. 새로고침한 뒤 다시 시도해 주세요."
_THROTTLED = "지금 로그를 보려는 요청이 많아요. 잠시 후 다시 시도해 주세요."

# 파이프라인 스테이지 → (응답 source, 응답 stage). 뒤 단계일수록 우선(Deploy > ValidateBuild).
_STAGE_SOURCE: dict[str, tuple[str, str]] = {
    "ValidateBuild": ("validate-build", "VALIDATING"),
    "Deploy": ("deploy", "DEPLOYING"),
}
_STAGE_PRIORITY = ("Deploy", "ValidateBuild")


def get_app_logs(ctx: RouteContext) -> ProxyResult:
    """GET /apps/{id}/logs. query: limit(1~1000, 기본 100), nextToken, startTime(epoch ms)."""
    app = load_owned_app(ctx)
    limit = int_param(ctx.query, "limit", default=100, minimum=1, maximum=1000)
    start_time = int_param(ctx.query, "startTime", default=None, minimum=0, label="startTime")
    try:
        result = fetch_app_logs(
            app["appId"],
            limit=limit or 100,
            next_token=ctx.query.get("nextToken") or None,
            start_time=start_time,
        )
    except LogQueryInvalid as err:
        raise errors.validation(_BAD_QUERY) from err
    except LogQueryThrottled as err:
        raise errors.rate_limited(_THROTTLED) from err
    return ok(result)


def get_deployment_logs(ctx: RouteContext) -> ProxyResult:
    """GET /apps/{id}/deployments/{deploymentId}/logs. query: limit(1~1000, 기본 200), nextToken."""
    app = load_owned_app(ctx)
    limit = int_param(ctx.query, "limit", default=200, minimum=1, maximum=1000) or 200
    deployment = get_deployment(app["appId"], ctx.params.get("deploymentId") or "")
    if deployment is None:
        raise errors.not_found("배포 이력을 찾을 수 없어요.")

    located = _locate_build(app["appId"], deployment)
    if located is None:
        # 아직 CodeBuild 단계 전(Source 진행 중 등) — 다음에 로그가 생길 단계는 검사·빌드.
        #  source 는 항상 내려준다(프론트 타입 필수 필드).
        fallback = "provisioner" if deployment.get("buildId") else "validate-build"
        return ok({"events": [], "source": fallback})
    build_id, source, stage = located
    meta: dict[str, Any] = {"source": source}
    if stage:
        meta["stage"] = stage

    group, stream = _log_location(build_id)
    if not group or not stream:
        return ok({"events": [], **meta})
    try:
        result = fetch_stream_logs(
            group, stream, limit=limit, next_token=ctx.query.get("nextToken") or None
        )
    except LogQueryInvalid as err:
        raise errors.validation(_BAD_QUERY) from err
    except LogQueryThrottled as err:
        raise errors.rate_limited(_THROTTLED) from err
    return ok({**result, **meta})


# ── 내부 ─────────────────────────────────────────────────────────────────────


def _locate_build(app_id: str, deployment: dict[str, Any]) -> tuple[str, str, str | None] | None:
    """배포 레코드 → (CodeBuild build id, source, stage). 찾을 수 없으면 None."""
    build_id = deployment.get("buildId")
    if isinstance(build_id, str) and build_id:
        return build_id, "provisioner", "DEPLOYING"
    execution_id = deployment.get("pipelineExecutionId")
    if not isinstance(execution_id, str) or not execution_id:
        return None
    try:
        details = list_action_executions(load_config().stage, app_id, execution_id)
    except Exception as err:  # noqa: BLE001 - 실행 조회 실패(만료·미존재)는 "로그 없음"으로 취급
        print("[logs] list_action_executions failed:", type(err).__name__, str(err)[:200])
        return None
    candidates = [d for d in details if d.get("stageName") in _STAGE_SOURCE and _external_id(d)]
    if not candidates:
        return None
    failed = [d for d in candidates if d.get("status") == "Failed"]
    pool = failed or candidates
    chosen = None
    for stage_name in _STAGE_PRIORITY:
        chosen = _latest([d for d in pool if d.get("stageName") == stage_name])
        if chosen is not None:
            break
    if chosen is None:
        return None
    source, stage = _STAGE_SOURCE[chosen["stageName"]]
    return _external_id(chosen), source, stage  # type: ignore[return-value]


def _external_id(detail: dict[str, Any]) -> str | None:
    result = (detail.get("output") or {}).get("executionResult") or {}
    value = result.get("externalExecutionId")
    return value if isinstance(value, str) and value else None


def _latest(details: list[dict[str, Any]]) -> dict[str, Any] | None:
    """같은 스테이지에 액션 실행이 여럿(재시도)이면 가장 최근 시작한 것."""
    if not details:
        return None
    return max(details, key=lambda d: str(d.get("startTime") or ""))


def _log_location(build_id: str) -> tuple[str | None, str | None]:
    try:
        return build_log_location(get_build(build_id))
    except Exception as err:  # noqa: BLE001 - 빌드 조회 실패(만료 등)는 "로그 없음"으로 취급
        print("[logs] batch_get_builds failed:", type(err).__name__, str(err)[:200])
        return None, None
