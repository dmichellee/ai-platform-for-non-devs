"""배포 이력 데이터 액세스. 90일 TTL."""

from __future__ import annotations

import base64
import binascii
import json
import time
from typing import Any

from boto3.dynamodb.conditions import Key

from ..util import now_iso
from .client import clean_item, strip_item, table
from .keys import SkPrefix, app_pk, deploy_build_sk, deploy_exec_sk, deploy_sk

_NINETY_DAYS_SEC = 90 * 24 * 60 * 60
_DEPLOY_DROP = ("PK", "SK", "entityType", "ttl")


def _to_deployment(item: dict[str, Any] | None) -> dict[str, Any] | None:
    return strip_item(item, _DEPLOY_DROP)


def _build_deployment(
    app_id: str,
    trigger: str,
    status: str,
    commit_sha: str | None,
    commit_message: str | None,
    pipeline_execution_id: str | None,
    build_id: str | None,
    failure_category: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """(API 노출용 deployment dict, DDB item) 생성. 공통 필드/TTL 규칙을 한 곳에 둔다."""
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
    if failure_category is not None:
        deployment["failureCategory"] = failure_category

    item = clean_item(
        {
            "PK": app_pk(app_id),
            "SK": deploy_sk(ts),
            "entityType": "Deployment",
            "ttl": int(time.time()) + _NINETY_DAYS_SEC,
            **deployment,
        }
    )
    return deployment, item


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
    deployment, item = _build_deployment(
        app_id, trigger, status, commit_sha, commit_message, pipeline_execution_id, build_id
    )
    table().put_item(Item=item)
    return deployment


def create_deployment_for_execution(
    app_id: str,
    pipeline_execution_id: str,
    *,
    trigger: str,
    status: str,
    commit_sha: str | None = None,
    commit_message: str | None = None,
    failure_category: str | None = None,
) -> dict[str, Any] | None:
    """파이프라인 실행당 Deployment 를 **최대 1건**만 만든다. 졌으면(이미 클레임됨) None.

    경합 방어(EventBridge 역순·동시 도착, 접수 API ↔ deploy-notify 경합):
      Deployment SK 는 생성 시각(`DEPLOY#{ts}`)이라 실행 ID 로 결정적이지 않아 그 자체로 조건부 Put 을
      걸 수 없다. 그래서 결정적 클레임 아이템 `APP#{appId}/DEPLOYEXEC#{executionId}` 를
      attribute_not_exists 조건으로 Put 하고, Deployment Put 과 **한 트랜잭션(TransactWriteItems)**
      으로 묶는다. → 클레임과 레코드는 함께 생기거나 함께 안 생긴다(반쯤 만든 상태가 없음).
      트랜잭션이 조건 실패로 취소되면 상대가 이미 같은 실행의 레코드를 만든 것이므로, 호출부는
      ConsistentRead 재조회로 그 레코드를 찾아 후속 처리(deploy-notify: _advance 상태 전이,
      수동 배포 접수: trigger=manual 보정)를 한다.
    사용처: deploy-notify(Source STARTED / 종결 이벤트) + 수동 배포 접수(handlers/deployments.trigger_deploy).
      세 경로 모두 같은 클레임을 거치므로 '실행이 즉시 실패해 종결 이벤트가 접수 응답보다 먼저 온'
      경우에도 레코드는 1건이다.
    IAM: 트랜잭션 Put 은 dynamodb:PutItem 권한으로 인가된다(별도 Transact 액션 불필요).
    """
    return _create_claimed(
        app_id,
        deploy_exec_sk(pipeline_execution_id),
        "DeployExecClaim",
        trigger=trigger,
        status=status,
        commit_sha=commit_sha,
        commit_message=commit_message,
        pipeline_execution_id=pipeline_execution_id,
        build_id=None,
        failure_category=failure_category,
    )


def create_deployment_for_build(
    app_id: str,
    build_id: str,
    *,
    trigger: str,
    status: str,
    commit_sha: str | None = None,
    commit_message: str | None = None,
    failure_category: str | None = None,
) -> dict[str, Any] | None:
    """provisioner 런타임 재배포 빌드(롤백/시크릿 변경)당 Deployment 최대 1건. 졌으면 None.

    create_deployment_for_execution 과 같은 패턴 — 클레임 `APP#{appId}/DEPLOYBUILD#{buildId}`.
    build_id 는 StartBuild 반환 형식(`{project}:{uuid}`)으로 정규화해 넘긴다(이벤트의 ARN 형식은
    호출부가 짧은 형식으로 바꿔서 전달 — 같은 빌드가 두 키로 클레임되지 않도록).
    """
    return _create_claimed(
        app_id,
        deploy_build_sk(build_id),
        "DeployBuildClaim",
        trigger=trigger,
        status=status,
        commit_sha=commit_sha,
        commit_message=commit_message,
        pipeline_execution_id=None,
        build_id=build_id,
        failure_category=failure_category,
    )


def _create_claimed(
    app_id: str,
    claim_sk: str,
    claim_entity: str,
    *,
    trigger: str,
    status: str,
    commit_sha: str | None,
    commit_message: str | None,
    pipeline_execution_id: str | None,
    build_id: str | None,
    failure_category: str | None,
) -> dict[str, Any] | None:
    """클레임(attribute_not_exists) + Deployment Put 을 한 트랜잭션으로. 클레임 충돌이면 None."""
    deployment, item = _build_deployment(
        app_id,
        trigger,
        status,
        commit_sha,
        commit_message,
        pipeline_execution_id,
        build_id,
        failure_category=failure_category,
    )
    claim = {
        "PK": app_pk(app_id),
        "SK": claim_sk,
        "entityType": claim_entity,
        "deploymentId": deployment["deploymentId"],
        "ttl": item["ttl"],
    }
    table_name = table().name
    try:
        # resource Table 의 meta.client 는 resource 와 같은 자동 marshalling(파이썬 값 ↔ AttributeValue)이
        # 걸려 있어 Item 을 평문 dict 로 넘긴다(TypeSerializer 로 직접 직렬화하면 이중 직렬화됨).
        table().meta.client.transact_write_items(
            TransactItems=[
                {
                    "Put": {
                        "TableName": table_name,
                        "Item": claim,
                        "ConditionExpression": "attribute_not_exists(PK)",
                    }
                },
                {
                    "Put": {
                        "TableName": table_name,
                        "Item": item,
                    }
                },
            ]
        )
    except Exception as err:  # noqa: BLE001 - 조건 실패(이미 클레임됨)만 None, 그 외는 재전파
        if _is_tx_condition_failure(err):
            return None
        raise
    return deployment


def find_deployment_by_execution(
    app_id: str, pipeline_execution_id: str, *, consistent: bool = False
) -> dict[str, Any] | None:
    """최근 20건 중 pipelineExecutionId 일치 레코드."""
    for dep in list_deployments(app_id, 20, consistent=consistent):
        if dep.get("pipelineExecutionId") == pipeline_execution_id:
            return dep
    return None


def find_deployment_by_build(
    app_id: str, build_ids: tuple[str, ...], *, consistent: bool = False
) -> dict[str, Any] | None:
    """최근 20건 중 buildId 가 build_ids(짧은 형식/ARN) 중 하나와 일치하는 레코드."""
    for dep in list_deployments(app_id, 20, consistent=consistent):
        if dep.get("buildId") in build_ids:
            return dep
    return None


def _is_tx_condition_failure(err: BaseException) -> bool:
    """TransactionCanceledException 중 ConditionalCheckFailed 사유 포함 여부."""
    response = getattr(err, "response", None) or {}
    if response.get("Error", {}).get("Code") != "TransactionCanceledException":
        return False
    reasons = response.get("CancellationReasons") or []
    if not reasons:
        # 사유 목록이 없으면 메시지로 판별(일부 SDK/모킹 환경).
        return "ConditionalCheckFailed" in str(err)
    return any(r.get("Code") == "ConditionalCheckFailed" for r in reasons)


def list_deployments(
    app_id: str, limit: int = 20, *, consistent: bool = False
) -> list[dict[str, Any]]:
    """앱 배포 이력(최신순). DEPLOY# prefix, ScanIndexForward=False.

    consistent=True: 강한 일관성 읽기(경합 직후 재조회 — create_deployment_for_execution 참고).
    """
    res = table().query(
        KeyConditionExpression=Key("PK").eq(app_pk(app_id))
        & Key("SK").begins_with(SkPrefix.DEPLOY),
        ScanIndexForward=False,
        Limit=limit,
        ConsistentRead=consistent,
    )
    return [_to_deployment(i) for i in res.get("Items", [])]  # type: ignore[misc]


def get_deployment(app_id: str, deployment_id: str) -> dict[str, Any] | None:
    """Deployment 단건(deploymentId = SK `DEPLOY#{ts}` 의 ts). 없으면 None."""
    if not deployment_id:
        return None
    res = table().get_item(Key={"PK": app_pk(app_id), "SK": deploy_sk(deployment_id)})
    item = res.get("Item")
    if not item or item.get("entityType") != "Deployment":
        return None
    return _to_deployment(item)


class InvalidPageToken(Exception):
    """배포 이력 nextToken 이 해석 불가/다른 앱의 키 — 핸들러가 400 VALIDATION_ERROR 로 변환."""


def _encode_page_token(key: dict[str, Any]) -> str:
    raw = json.dumps({"SK": key["SK"]}, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_page_token(app_id: str, token: str) -> dict[str, Any]:
    try:
        padded = token + "=" * (-len(token) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
        sk = data["SK"]
    except (ValueError, KeyError, TypeError, binascii.Error, UnicodeDecodeError) as err:
        raise InvalidPageToken() from err
    if not isinstance(sk, str) or not sk.startswith(SkPrefix.DEPLOY):
        raise InvalidPageToken()
    # PK 는 토큰에 싣지 않고 항상 요청 앱으로 고정 — 다른 앱 파티션으로의 커서 조작 방지.
    return {"PK": app_pk(app_id), "SK": sk}


def list_deployments_page(
    app_id: str, limit: int, next_token: str | None = None
) -> tuple[list[dict[str, Any]], str | None]:
    """배포 이력 1페이지(최신순) + 다음 페이지 토큰(LastEvaluatedKey → 불투명 nextToken). A6."""
    params: dict[str, Any] = {
        "KeyConditionExpression": Key("PK").eq(app_pk(app_id))
        & Key("SK").begins_with(SkPrefix.DEPLOY),
        "ScanIndexForward": False,
        "Limit": limit,
    }
    if next_token:
        params["ExclusiveStartKey"] = _decode_page_token(app_id, next_token)
    res = table().query(**params)
    items = [_to_deployment(i) for i in res.get("Items", [])]
    last = res.get("LastEvaluatedKey")
    return items, (_encode_page_token(last) if last else None)  # type: ignore[return-value]


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
    trigger: str | None = None,
) -> dict[str, Any] | None:
    """배포 이력 레코드 부분 갱신([Notify] EventBridge → deploy-notify Lambda).

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
        "trigger": trigger,
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


def adopt_deployment(
    app_id: str,
    existing: dict[str, Any],
    *,
    trigger: str,
    commit_sha: str | None = None,
    commit_message: str | None = None,
) -> dict[str, Any]:
    """클레임 경합에서 진 접수 API 가 deploy-notify 가 먼저 만든 레코드를 '자기 것'으로 보정한다.

    trigger 만 접수 경로의 값(manual/rollback/secret-change)으로 고치고, 커밋 정보는 비어 있을 때만
    채운다. status/failureCategory 는 **건드리지 않는다**(이미 종결이면 종결 유지 — 역행 금지).
    갱신 실패(레코드 소실 등)면 보정 값을 얹은 기존 레코드를 그대로 반환한다(응답 shape 유지).
    """
    patch_sha = commit_sha if not existing.get("commitSha") else None
    patch_msg = commit_message if not existing.get("commitMessage") else None
    if existing.get("trigger") == trigger and patch_sha is None and patch_msg is None:
        return existing
    updated = update_deployment(
        app_id,
        existing["deploymentId"],
        trigger=trigger,
        commit_sha=patch_sha,
        commit_message=patch_msg,
    )
    if updated is not None:
        return updated
    merged = {**existing, "trigger": trigger}
    if patch_sha is not None:
        merged["commitSha"] = patch_sha
    if patch_msg is not None:
        merged["commitMessage"] = patch_msg
    return merged
