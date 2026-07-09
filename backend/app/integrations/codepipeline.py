"""CodePipeline — 앱 파이프라인 실행 트리거 (DESIGN.md 3.2/3.3).

파이프라인 생성 직후 첫 배포, 그리고 수동 배포/롤백을 StartPipelineExecution 으로 트리거.
파이프라인명 규약: `apphub-{stage}-app-{appId}`.
"""

from __future__ import annotations

from .clients import client


def app_pipeline_name(stage: str, app_id: str) -> str:
    return f"apphub-{stage}-app-{app_id}"


def start_pipeline(stage: str, app_id: str) -> str | None:
    """앱 파이프라인 실행 시작. pipelineExecutionId 반환."""
    res = client("codepipeline").start_pipeline_execution(name=app_pipeline_name(stage, app_id))
    return res.get("pipelineExecutionId")
