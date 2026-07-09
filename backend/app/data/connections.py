"""레포 연결 데이터 액세스 (RepoConnection). PK=USER#{userId}, SK=CONN#{connId}."""

from __future__ import annotations

from typing import Any

from boto3.dynamodb.conditions import Key

from ..util import now_iso
from .client import clean_item, strip_item, table
from .keys import SkPrefix, conn_sk, user_pk

_CONN_DROP = ("PK", "SK", "entityType")


def _to_connection(item: dict[str, Any] | None) -> dict[str, Any] | None:
    return strip_item(item, _CONN_DROP)


def put_connection(
    conn_id: str,
    owner_id: str,
    provider: str,
    connection_arn: str,
    status: str,
    display_name: str,
) -> dict[str, Any]:
    now = now_iso()
    conn: dict[str, Any] = {
        "connId": conn_id,
        "ownerId": owner_id,
        "provider": provider,
        "connectionArn": connection_arn,
        "status": status,
        "displayName": display_name,
        "createdAt": now,
        "updatedAt": now,
    }
    item = clean_item(
        {
            "PK": user_pk(owner_id),
            "SK": conn_sk(conn_id),
            "entityType": "RepoConnection",
            **conn,
        }
    )
    table().put_item(Item=item)
    return conn


def get_connection(owner_id: str, conn_id: str) -> dict[str, Any] | None:
    res = table().get_item(Key={"PK": user_pk(owner_id), "SK": conn_sk(conn_id)})
    return _to_connection(res.get("Item"))


def list_connections(owner_id: str) -> list[dict[str, Any]]:
    res = table().query(
        KeyConditionExpression=Key("PK").eq(user_pk(owner_id))
        & Key("SK").begins_with(SkPrefix.CONN),
    )
    return [_to_connection(i) for i in res.get("Items", [])]  # type: ignore[misc]


def delete_connection(owner_id: str, conn_id: str) -> None:
    table().delete_item(Key={"PK": user_pk(owner_id), "SK": conn_sk(conn_id)})
