"""CodeBuild — provisioner 프로젝트 StartBuild / 상태 조회 (buildspec-contract.md §7).

무거운 작업은 시작만(StartBuild) — 폴링은 SFN Choice+Wait 루프가 하고,
task Lambda 는 BatchGetBuilds 로 상태 조회만 한다("메인 서버 무부하").
"""

from __future__ import annotations

from typing import Any

from .clients import client


def start_provisioner_build(project_name: str, env: dict[str, str]) -> str:
    """provisioner CodeBuild 를 env override 로 시작. build id 반환.

    env override 는 buildspec-contract §7의 StartBuild env override 키
    (APP_ID/STAGE/APP_STACK_KIND/PROVIDER/REPO_URL/BRANCH/AUTO_DEPLOY/CONNECTION_ARN).
    """
    overrides = [{"name": name, "value": value, "type": "PLAINTEXT"} for name, value in env.items()]
    res = client("codebuild").start_build(
        projectName=project_name,
        environmentVariablesOverride=overrides,
    )
    build_id = (res.get("build") or {}).get("id")
    if not build_id:
        raise RuntimeError("provisioner CodeBuild 시작 실패(build id 없음).")
    return build_id


def get_build_status(build_id: str) -> str:
    """빌드 상태를 SUCCEEDED / IN_PROGRESS / FAILED 로 정규화(SFN Choice 소비)."""
    res = client("codebuild").batch_get_builds(ids=[build_id])
    builds: list[dict[str, Any]] = res.get("builds") or []
    status = builds[0].get("buildStatus") if builds else None
    if status == "SUCCEEDED":
        return "SUCCEEDED"
    if status is None or status == "IN_PROGRESS":
        return "IN_PROGRESS"
    return "FAILED"


def get_build(build_id: str) -> dict[str, Any] | None:
    """BatchGetBuilds 단건. 없으면 None."""
    res = client("codebuild").batch_get_builds(ids=[build_id])
    builds: list[dict[str, Any]] = res.get("builds") or []
    return builds[0] if builds else None


def build_log_location(build: dict[str, Any] | None) -> tuple[str | None, str | None]:
    """빌드의 CloudWatch 로그 (groupName, streamName). 아직 없으면 (None, None)."""
    logs = (build or {}).get("logs") or {}
    return logs.get("groupName"), logs.get("streamName")
