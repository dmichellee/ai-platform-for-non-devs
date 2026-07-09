"""CloudFormation — 앱 스택 삭제 시작 / 삭제 상태 조회 (DESIGN.md 3.6).

DeleteApp 상태 기계가 소비. 무거운 작업은 시작만(DeleteStack) — 폴링은 SFN Choice+Wait 루프가,
task Lambda 는 DescribeStacks 로 삭제 상태 조회만.
스택명 규약: `apphub-{stage}-app-{appId}-{runtime|pipeline}`.
"""

from __future__ import annotations

import re
from typing import Any

from botocore.exceptions import ClientError

from .clients import client


def runtime_stack_name(stage: str, app_id: str) -> str:
    return f"apphub-{stage}-app-{app_id}-runtime"


def pipeline_stack_name(stage: str, app_id: str) -> str:
    return f"apphub-{stage}-app-{app_id}-pipeline"


def delete_stack(stack_name: str) -> None:
    """스택 삭제 시작(멱등 — 이미 없어도 DeleteStack 은 성공 처리)."""
    client("cloudformation").delete_stack(StackName=stack_name)


def get_stack_delete_state(stack_name: str) -> str:
    """스택 삭제 상태를 DELETE_COMPLETE / DELETE_FAILED / DELETE_IN_PROGRESS 로 정규화.

    스택이 이미 없으면(ValidationError: does not exist) 삭제 완료로 간주(멱등).
    """
    try:
        res = client("cloudformation").describe_stacks(StackName=stack_name)
        stacks: list[dict[str, Any]] = res.get("Stacks") or []
        status = stacks[0].get("StackStatus", "") if stacks else ""
        if status == "DELETE_COMPLETE":
            return "DELETE_COMPLETE"
        if status == "DELETE_FAILED":
            return "DELETE_FAILED"
        return "DELETE_IN_PROGRESS"
    except ClientError as err:
        code = err.response.get("Error", {}).get("Code", "")
        msg = err.response.get("Error", {}).get("Message", "")
        if code == "ValidationError" or re.search(r"does not exist", msg, re.IGNORECASE):
            return "DELETE_COMPLETE"
        raise
