"""배포 이력 데이터 액세스 (DESIGN.md 4/9). 90일 TTL."""

from __future__ import annotations

import time
from typing import Any

from boto3.dynamodb.conditions import Key

from ..util import now_iso
from .client import clean_item, strip_item, table
from .keys import SkPrefix, app_pk, deploy_sk

_NINETY_DAYS_SEC = 90 * 24 * 60 * 60
_DEPLOY_DROP = ("PK", "SK", "entityType", "ttl")


def _to_deployment(item: dict[str, Any] | None) -> dict[str, Any] | None:
    return strip_item(item, _DEPLOY_DROP)


def put_deployment(
    app_id: str,
    trigger: str,
    status: str = "PENDING",
    commit_sha: str | None = None,
    commit_message: str | None = None,
    pipeline_execution_id: str | None = None,
) -> dict[str, Any]:
    """배포 이력 레코드 생성(수동 배포 트리거 시 PENDING). 90일 TTL."""
    ts = now_iso()
    deployment: dict[str, Any] = {
        "appId": app_id,
        "deploymentId": ts,
        "trigger": trigger,
        "status": status,
        "createdAt": ts,
        "updatedAt": ts,
    }
    if commit_sha is not None:
        deployment["commitSha"] = commit_sha
    if commit_message is not None:
        deployment["commitMessage"] = commit_message
    if pipeline_execution_id is not None:
        deployment["pipelineExecutionId"] = pipeline_execution_id

    item = clean_item(
        {
            "PK": app_pk(app_id),
            "SK": deploy_sk(ts),
            "entityType": "Deployment",
            "ttl": int(time.time()) + _NINETY_DAYS_SEC,
            **deployment,
        }
    )
    table().put_item(Item=item)
    return deployment


def list_deployments(app_id: str, limit: int = 20) -> list[dict[str, Any]]:
    """앱 배포 이력(최신순). DEPLOY# prefix, ScanIndexForward=False."""
    res = table().query(
        KeyConditionExpression=Key("PK").eq(app_pk(app_id))
        & Key("SK").begins_with(SkPrefix.DEPLOY),
        ScanIndexForward=False,
        Limit=limit,
    )
    return [_to_deployment(i) for i in res.get("Items", [])]  # type: ignore[misc]
