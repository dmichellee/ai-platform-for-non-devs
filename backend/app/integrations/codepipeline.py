"""CodePipeline — 앱 파이프라인 실행 트리거.

파이프라인 생성 직후 첫 배포, 그리고 수동 배포/롤백을 StartPipelineExecution 으로 트리거.
파이프라인명 규약: `apphub-{stage}-app-{appId}`.
"""

from __future__ import annotations

from typing import Any

from .clients import client


def app_pipeline_name(stage: str, app_id: str) -> str:
    return f"apphub-{stage}-app-{app_id}"


def start_pipeline(stage: str, app_id: str) -> str | None:
    """앱 파이프라인 실행 시작. pipelineExecutionId 반환."""
    res = client("codepipeline").start_pipeline_execution(name=app_pipeline_name(stage, app_id))
    return res.get("pipelineExecutionId")


def list_action_executions(stage: str, app_id: str, execution_id: str) -> list[dict[str, Any]]:
    """앱 파이프라인 실행 1건의 액션 실행 목록(actionExecutionDetails). 페이지 끝까지."""
    details: list[dict[str, Any]] = []
    token: str | None = None
    for _ in range(10):
        kwargs: dict[str, Any] = {
            "pipelineName": app_pipeline_name(stage, app_id),
            "filter": {"pipelineExecutionId": execution_id},
        }
        if token:
            kwargs["nextToken"] = token
        res = client("codepipeline").list_action_executions(**kwargs)
        details.extend(res.get("actionExecutionDetails") or [])
        token = res.get("nextToken")
        if not token:
            break
    return details
