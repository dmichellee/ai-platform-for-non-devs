"""App 아이템 데이터 액세스 (DESIGN.md 4장).

App 도메인 모델은 dict(camelCase 키). 저장 시 PK/SK/entityType 를 붙이고,
조회 시 이 키들을 제거해 계약 응답 shape 로 되돌린다(strip_item).
상태 전이는 상태 기계(apphub-conventions 5장)만 허용 — 조건부 쓰기로 강제.
"""

from __future__ import annotations

from typing import Any

from boto3.dynamodb.conditions import Key

from ..util import now_iso as _now_iso
from .client import clean_item, strip_item, table
from .keys import APP_META_SK, app_pk

_APP_DROP = ("PK", "SK", "entityType")


def _to_app(item: dict[str, Any] | None) -> dict[str, Any] | None:
    return strip_item(item, _APP_DROP)


def put_app(app_input: dict[str, Any]) -> dict[str, Any]:
    """App 생성. 조건: 같은 appId 미존재. 서브도메인 유일성은 reserve_subdomain 이 별도 보장."""
    now = _now_iso()
    app = {**app_input, "createdAt": now, "updatedAt": now}
    item = clean_item(
        {
            "PK": app_pk(app["appId"]),
            "SK": APP_META_SK,
            "entityType": "App",
            **app,
        }
    )
    table().put_item(Item=item, ConditionExpression="attribute_not_exists(PK)")
    return app


def get_app(app_id: str) -> dict[str, Any] | None:
    res = table().get_item(Key={"PK": app_pk(app_id), "SK": APP_META_SK})
    return _to_app(res.get("Item"))


def list_apps_by_owner(owner_id: str) -> list[dict[str, Any]]:
    """사용자별 앱 목록(GSI1: ownerId). App 메타만(SK=META) 필터."""
    res = table().query(
        IndexName="GSI1",
        KeyConditionExpression=Key("ownerId").eq(owner_id) & Key("SK").eq(APP_META_SK),
    )
    return [_to_app(i) for i in res.get("Items", [])]  # type: ignore[misc]


def count_apps_by_owner(owner_id: str) -> int:
    """사용자 앱 개수(쿼터 검사용)."""
    res = table().query(
        IndexName="GSI1",
        KeyConditionExpression=Key("ownerId").eq(owner_id) & Key("SK").eq(APP_META_SK),
        Select="COUNT",
    )
    return res.get("Count", 0)


def list_all_apps(status: str | None = None) -> list[dict[str, Any]]:
    """관리자 전체 현황(GSI2: status). status 미지정 시 App 메타 아이템 스캔."""
    if status:
        res = table().query(
            IndexName="GSI2",
            KeyConditionExpression=Key("status").eq(status) & Key("SK").eq(APP_META_SK),
        )
        return [_to_app(i) for i in res.get("Items", [])]  # type: ignore[misc]
    res = table().scan(
        FilterExpression="entityType = :t AND SK = :sk",
        ExpressionAttributeValues={":t": "App", ":sk": APP_META_SK},
    )
    return [_to_app(i) for i in res.get("Items", [])]  # type: ignore[misc]


def update_app(app_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    """부분 업데이트(설정 변경). updatedAt 자동 갱신. 존재 조건 강제."""
    now = _now_iso()
    entries = {k: v for k, v in {**patch, "updatedAt": now}.items() if v is not None}
    names: dict[str, str] = {}
    values: dict[str, Any] = {}
    sets: list[str] = []
    for key, value in entries.items():
        names[f"#{key}"] = key
        values[f":{key}"] = value
        sets.append(f"#{key} = :{key}")
    res = table().update_item(
        Key={"PK": app_pk(app_id), "SK": APP_META_SK},
        UpdateExpression="SET " + ", ".join(sets),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=clean_item(values),
        ConditionExpression="attribute_exists(PK)",
        ReturnValues="ALL_NEW",
    )
    return _to_app(res.get("Attributes"))  # type: ignore[return-value]


def transition_status(app_id: str, next_status: str, allowed_from: list[str]) -> None:
    """상태 전이(상태 기계 준수). 허용 전이만 조건부로 수행.

    status: CREATING→ACTIVE|FAILED, ACTIVE→DELETING, FAILED→DELETING, DELETING→FAILED
    """
    now = _now_iso()
    values: dict[str, Any] = {":next": next_status, ":now": now}
    for idx, source in enumerate(allowed_from):
        values[f":from{idx}"] = source
    condition = (
        "attribute_exists(PK) AND ("
        + " OR ".join(f"#s = :from{idx}" for idx in range(len(allowed_from)))
        + ")"
    )
    table().update_item(
        Key={"PK": app_pk(app_id), "SK": APP_META_SK},
        UpdateExpression="SET #s = :next, updatedAt = :now",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues=values,
        ConditionExpression=condition,
    )


def set_runtime_state(app_id: str, state: str) -> None:
    """runtimeState 갱신(RUNNING|WAKING|SLEEPING). status=ACTIVE에서만 의미 있음(호출부 보장)."""
    now = _now_iso()
    table().update_item(
        Key={"PK": app_pk(app_id), "SK": APP_META_SK},
        UpdateExpression="SET runtimeState = :r, updatedAt = :now",
        ExpressionAttributeValues={":r": state, ":now": now},
        ConditionExpression="attribute_exists(PK)",
    )


def delete_app_record(app_id: str) -> None:
    table().delete_item(Key={"PK": app_pk(app_id), "SK": APP_META_SK})
