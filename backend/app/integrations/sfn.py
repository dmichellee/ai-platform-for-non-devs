"""Step Functions 시작 래퍼 (DESIGN.md 3.2/3.6, stack-outputs.md §3.3).

무거운 작업은 Lambda에서 직접 하지 않고 SFN으로 위임한다("메인 서버 무부하" 원칙).
P1은 "start" 호출까지만 — 실제 ProvisionApp/DeleteApp 상태 기계 본문은 P2.

중복 실행 방지(DESIGN.md 9): execution name을 appId 기반으로 지정.
 - Provision: name=appId. 재실행 시 ExecutionAlreadyExists → 멱등.
 - Delete:    name=`del-{appId}`.
(앱 status DDB 조건부 전이가 1차 방어선, SFN name 유일성이 2차 방어선.)
"""

from __future__ import annotations

import json
from typing import Any

from ..config import load_config
from .clients import client


def start_provision(payload: dict[str, Any]) -> str | None:
    """ProvisionApp 상태 기계 시작. name=appId 로 중복 방지."""
    res = client("stepfunctions").start_execution(
        stateMachineArn=load_config().provision_sm_arn,
        name=payload["appId"],
        input=json.dumps(payload, ensure_ascii=False),
    )
    return res.get("executionArn")


def start_delete(payload: dict[str, Any]) -> str | None:
    """DeleteApp 상태 기계 시작. name=`del-{appId}` 로 중복 방지."""
    res = client("stepfunctions").start_execution(
        stateMachineArn=load_config().delete_sm_arn,
        name=f"del-{payload['appId']}",
        input=json.dumps(payload, ensure_ascii=False),
    )
    return res.get("executionArn")
