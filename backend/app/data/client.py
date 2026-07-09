"""공유 DynamoDB 접근 (boto3 resource Table).

- boto3 resource 인터페이스는 marshalling(dict ↔ AttributeValue)을 자동 처리한다.
- 숫자는 DynamoDB에서 Decimal 로 올라오므로, API 응답 직전에 int/float 로 되돌린다(strip_item).
- None 값은 저장 시 attribute 자체를 제거(TS removeUndefinedValues 대응).

테스트에서는 moto(@mock_aws)로 실제 테이블을 만들어 이 리소스를 그대로 쓴다.
클라이언트는 지연 생성(모듈 임포트 시점이 아니라 최초 호출 시) — moto 컨텍스트 진입 후 생성되도록.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import boto3
from botocore.exceptions import ClientError

from ..config import load_config


def is_conditional_check_failed(err: BaseException) -> bool:
    """조건부 쓰기 실패(ConditionalCheckFailedException) 판별 — 멱등/충돌 처리용."""
    return (
        isinstance(err, ClientError)
        and err.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException"
    )


_resource = None
_table_cache: dict[str, Any] = {}


def _get_resource() -> Any:
    global _resource
    if _resource is None:
        _resource = boto3.resource("dynamodb")
    return _resource


def table() -> Any:
    """설정된 TABLE_NAME 의 DynamoDB Table 리소스."""
    name = load_config().table_name
    cached = _table_cache.get(name)
    if cached is None:
        cached = _get_resource().Table(name)
        _table_cache[name] = cached
    return cached


def reset_client_cache() -> None:
    """테스트에서 리소스/테이블 캐시를 비운다(moto 컨텍스트 재진입 대비)."""
    global _resource
    _resource = None
    _table_cache.clear()


def clean_item(item: dict[str, Any]) -> dict[str, Any]:
    """None 값 attribute 제거 + float → Decimal(DynamoDB 저장 요건)."""
    out: dict[str, Any] = {}
    for key, value in item.items():
        if value is None:
            continue
        out[key] = _to_ddb(value)
    return out


def _to_ddb(value: Any) -> Any:
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: _to_ddb(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [_to_ddb(v) for v in value]
    return value


def strip_item(item: dict[str, Any] | None, drop_keys: tuple[str, ...]) -> dict[str, Any] | None:
    """DDB 아이템에서 키 제거(PK/SK/entityType/ttl 등) + Decimal → int/float 복원."""
    if item is None:
        return None
    return {k: _from_ddb(v) for k, v in item.items() if k not in drop_keys}


def _from_ddb(value: Any) -> Any:
    if isinstance(value, Decimal):
        # 정수면 int, 아니면 float 로 복원(JSON 직렬화 및 계약 정합).
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {k: _from_ddb(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_from_ddb(v) for v in value]
    return value
