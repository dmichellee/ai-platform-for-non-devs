"""ALB 슬롯 배정 테스트 (D-M5-04) — moto DynamoDB 로 원자적 증감·멱등 검증."""

from __future__ import annotations

from app.data import alb_registry as reg
from app.data.config_repo import list_alb_registry

ALB_ARN = "arn:aws:elasticloadbalancing:ap-northeast-2:111122223333:loadbalancer/app/internal/abc"


def test_next_rule_priority_monotonic_from_base(ddb_table) -> None:
    assert reg.next_rule_priority() == 1
    assert reg.next_rule_priority() == 2
    assert reg.next_rule_priority() == 3


def test_ensure_alb_registered_seeds_once_idempotent(ddb_table) -> None:
    reg.ensure_alb_registered(ALB_ARN, "internal", "vpc-1")
    reg.ensure_alb_registered(ALB_ARN, "internal", "vpc-1")  # 두 번째는 no-op
    items = [i for i in list_alb_registry() if i.get("albArn") == ALB_ARN]
    assert len(items) == 1
    assert items[0]["ruleCount"] == 0
    assert items[0]["scheme"] == "internal"


def test_increment_alb_rule_count(ddb_table) -> None:
    reg.ensure_alb_registered(ALB_ARN, "internal", "vpc-1")
    assert reg.increment_alb_rule_count(ALB_ARN) == 1
    assert reg.increment_alb_rule_count(ALB_ARN) == 2


def test_decrement_alb_rule_count_floors_at_zero_idempotent(ddb_table) -> None:
    reg.ensure_alb_registered(ALB_ARN, "internal", "vpc-1")
    reg.increment_alb_rule_count(ALB_ARN)  # ruleCount=1
    reg.decrement_alb_rule_count(ALB_ARN)  # -> 0
    reg.decrement_alb_rule_count(ALB_ARN)  # 0에서 또 감소 시도 → 조건 실패 삼킴(멱등)
    items = [i for i in list_alb_registry() if i.get("albArn") == ALB_ARN]
    assert items[0]["ruleCount"] == 0


def test_decrement_missing_alb_is_noop(ddb_table) -> None:
    # 레지스트리에 없는 ALB 감소 → 조건 실패 삼킴(예외 없음).
    reg.decrement_alb_rule_count("arn:aws:elasticloadbalancing:...:missing")


def test_allocate_alb_slot_returns_priority_and_no_scaleout(ddb_table) -> None:
    slot = reg.allocate_alb_slot(ALB_ARN, "internal", "vpc-1")
    assert slot["albArn"] == ALB_ARN
    assert slot["rulePriority"] == 1
    assert slot["needsScaleOut"] is False
    # 두 번째 배정은 priority 단조 증가.
    slot2 = reg.allocate_alb_slot(ALB_ARN, "internal", "vpc-1")
    assert slot2["rulePriority"] == 2


def test_allocate_alb_slot_signals_scaleout_at_soft_limit(ddb_table) -> None:
    reg.ensure_alb_registered(ALB_ARN, "internal", "vpc-1")
    # ruleCount 를 soft limit-1 까지 올린 뒤 배정하면 needsScaleOut=True.
    for _ in range(reg.ALB_RULE_SOFT_LIMIT - 1):
        reg.increment_alb_rule_count(ALB_ARN)
    slot = reg.allocate_alb_slot(ALB_ARN, "internal", "vpc-1")
    assert slot["needsScaleOut"] is True
