"""ALB 슬롯 배정 — 전역 rulePriority 카운터 + ALB별 ruleCount (DESIGN.md 3.4, D-M5-04).

- rulePriority: 전역 단조 증가 카운터(`CONFIG/RULEPRIORITYSEQ`)를 원자적으로 발급한다.
  ALB 내 유일성만 필요하므로 전역 단조 증가면 충분(자동 채번 금지 규약).
- ALB별 ruleCount: `CONFIG/ALB#{arn}` 아이템에 원자적 증감. 감소는 ruleCount>0 조건으로
  음수 방지(멱등 — 없거나 0이면 조건 실패를 삼킨다).
- ALB 레지스트리는 첫 사용 시 lazy 시드(ensure_alb_registered, 조건부 Put 멱등).
- ruleCount≥90(soft limit)이면 needsScaleOut 신호만 반환(증설은 후속, 1차 미구현).

config_repo.list_alb_registry(관리자 읽기)와 분리 — 쓰기/배정은 이 모듈이 소유.
"""

from __future__ import annotations

from typing import Any

from botocore.exceptions import ClientError

from .client import is_conditional_check_failed, table
from .keys import CONFIG_PK, alb_sk

RULE_PRIORITY_BASE = 1
ALB_RULE_SOFT_LIMIT = 90
RULE_PRIORITY_SEQ_SK = "RULEPRIORITYSEQ"


def ensure_alb_registered(alb_arn: str, scheme: str, vpc_id: str) -> None:
    """ALB 레지스트리 아이템을 lazy 시드. 이미 있으면 no-op(조건부 Put 멱등)."""
    try:
        table().put_item(
            Item={
                "PK": CONFIG_PK,
                "SK": alb_sk(alb_arn),
                "entityType": "AlbRegistry",
                "albArn": alb_arn,
                "scheme": scheme,
                "vpcId": vpc_id,
                "ruleCount": 0,
            },
            ConditionExpression="attribute_not_exists(PK) AND attribute_not_exists(SK)",
        )
    except ClientError as err:
        if is_conditional_check_failed(err):
            return
        raise


def next_rule_priority() -> int:
    """전역 rulePriority 카운터를 원자적으로 증가시켜 다음 값을 발급한다.

    `SET #seq = if_not_exists(#seq, base-1) + 1` → 최초 발급은 base(=1)부터 단조 증가.
    """
    res = table().update_item(
        Key={"PK": CONFIG_PK, "SK": RULE_PRIORITY_SEQ_SK},
        UpdateExpression="SET #seq = if_not_exists(#seq, :base) + :one",
        ExpressionAttributeNames={"#seq": "seq"},
        ExpressionAttributeValues={":base": RULE_PRIORITY_BASE - 1, ":one": 1},
        ReturnValues="UPDATED_NEW",
    )
    seq = (res.get("Attributes") or {}).get("seq")
    if seq is None:
        raise RuntimeError("규칙 priority 카운터 발급 실패(seq 미반환).")
    return int(seq)


def increment_alb_rule_count(alb_arn: str) -> int:
    """ALB별 ruleCount 를 원자적으로 +1. 증가 후 값을 반환."""
    res = table().update_item(
        Key={"PK": CONFIG_PK, "SK": alb_sk(alb_arn)},
        UpdateExpression="SET ruleCount = if_not_exists(ruleCount, :zero) + :one",
        ExpressionAttributeValues={":zero": 0, ":one": 1},
        ConditionExpression="attribute_exists(SK)",
        ReturnValues="UPDATED_NEW",
    )
    count = (res.get("Attributes") or {}).get("ruleCount")
    return int(count) if count is not None else 0


def decrement_alb_rule_count(alb_arn: str) -> None:
    """ALB별 ruleCount 를 -1. ruleCount>0 일 때만(음수 방지·멱등). 없거나 0이면 조건 실패를 삼킴."""
    try:
        table().update_item(
            Key={"PK": CONFIG_PK, "SK": alb_sk(alb_arn)},
            UpdateExpression="SET ruleCount = ruleCount - :one",
            ConditionExpression="attribute_exists(SK) AND ruleCount > :zero",
            ExpressionAttributeValues={":one": 1, ":zero": 0},
        )
    except ClientError as err:
        if is_conditional_check_failed(err):
            return
        raise


def allocate_alb_slot(alb_arn: str, scheme: str, vpc_id: str) -> dict[str, Any]:
    """ALB 슬롯 배정: 레지스트리 시드 → rulePriority 발급 → ruleCount 증가 → needsScaleOut 판정."""
    ensure_alb_registered(alb_arn, scheme, vpc_id)
    rule_priority = next_rule_priority()
    rule_count = increment_alb_rule_count(alb_arn)
    return {
        "albArn": alb_arn,
        "rulePriority": rule_priority,
        "needsScaleOut": rule_count >= ALB_RULE_SOFT_LIMIT,
    }
