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
    build_id: str | None = None,
) -> dict[str, Any]:
    """배포 이력 레코드 생성(수동 배포/롤백 트리거 시 PENDING). 90일 TTL.

    pipeline_execution_id: 파이프라인 실행 식별자(deploy/auto). build_id: provisioner CodeBuild
    실행 식별자(rollback — 재빌드 없이 runtime 재배포). 둘 다 진행 추적/디버깅용.
    """
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
    if build_id is not None:
        deployment["buildId"] = build_id

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


def update_deployment(
    app_id: str,
    deployment_id: str,
    *,
    status: str | None = None,
    failure_category: str | None = None,
    commit_sha: str | None = None,
    commit_message: str | None = None,
    pipeline_execution_id: str | None = None,
    build_id: str | None = None,
) -> dict[str, Any] | None:
    """배포 이력 레코드 부분 갱신([Notify] EventBridge → deploy-notify Lambda, DESIGN.md 3.3).

    None 필드는 미변경(부분 upsert). updatedAt 은 항상 갱신. deploymentId 는 SK(`DEPLOY#{ts}`)의
    ts 이므로 이를 그대로 SK 로 재구성해 UpdateItem 한다. 존재 조건을 강제해(attribute_exists) 없는
    레코드는 조용히 무시(ConditionalCheckFailedException → None). 역행 금지/종결 보존 같은 상태 기계
    판단은 호출부(deploy_notify)가 담당하며, 이 함수는 순수한 SET 부분 갱신만 수행한다.
    """
    now = now_iso()
    patch: dict[str, Any] = {
        "status": status,
        "failureCategory": failure_category,
        "commitSha": commit_sha,
        "commitMessage": commit_message,
        "pipelineExecutionId": pipeline_execution_id,
        "buildId": build_id,
    }
    entries = {k: v for k, v in {**patch, "updatedAt": now}.items() if v is not None}
    names: dict[str, str] = {}
    values: dict[str, Any] = {}
    sets: list[str] = []
    for key, value in entries.items():
        names[f"#{key}"] = key
        values[f":{key}"] = value
        sets.append(f"#{key} = :{key}")
    try:
        res = table().update_item(
            Key={"PK": app_pk(app_id), "SK": deploy_sk(deployment_id)},
            UpdateExpression="SET " + ", ".join(sets),
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
            ConditionExpression="attribute_exists(PK)",
            ReturnValues="ALL_NEW",
        )
    except Exception:  # noqa: BLE001 - 레코드 없음(ConditionalCheckFailed)이면 조용히 무시(멱등)
        return None
    return _to_deployment(res.get("Attributes"))
