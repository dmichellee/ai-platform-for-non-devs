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


# ── D20: 다중 ALB 배정 / 조건부 증가 / WAIT / PENDING ───────────────────────────

ALB1_ARN = "arn:aws:elasticloadbalancing:ap-northeast-2:111122223333:loadbalancer/app/internal-1/def"
NET_ARN = "arn:aws:elasticloadbalancing:ap-northeast-2:111122223333:loadbalancer/app/internet/xyz"


def _set_rule_count(table, alb_arn: str, count: int) -> None:
    table.update_item(
        Key={"PK": "CONFIG", "SK": f"ALB#{alb_arn}"},
        UpdateExpression="SET ruleCount = :c",
        ExpressionAttributeValues={":c": count},
    )


def test_allocate_assigns_n0_with_index_and_priority(ddb_table) -> None:
    slot = reg.allocate_alb_slot("internal", ALB_ARN, "vpc-1")
    assert slot == {
        "slotStatus": "ASSIGNED",
        "albArn": ALB_ARN,
        "albIndex": 0,
        "rulePriority": 1,
        "spare": 89,
    }
    slot2 = reg.allocate_alb_slot("internal", ALB_ARN, "vpc-1")
    assert slot2["rulePriority"] == 2
    item = [i for i in list_alb_registry() if i.get("albArn") == ALB_ARN][0]
    assert item["index"] == 0
    assert item["status"] == "ACTIVE"
    assert item["schemeSlug"] == "internal"
    assert item["ruleCount"] == 2


def test_allocate_corrects_legacy_item_without_index_status(ddb_table) -> None:
    # 기존 항목(index/status/schemeSlug 없음) → 0/ACTIVE 로 간주해 배정, 쓰기 때 보정.
    ddb_table.put_item(
        Item={
            "PK": "CONFIG",
            "SK": f"ALB#{NET_ARN}",
            "entityType": "AlbRegistry",
            "albArn": NET_ARN,
            "scheme": "internet-facing",
            "vpcId": "vpc-1",
            "ruleCount": 3,
        }
    )
    slot = reg.allocate_alb_slot("internet-facing", NET_ARN, "vpc-1")
    assert slot["slotStatus"] == "ASSIGNED"
    assert slot["albIndex"] == 0
    raw = ddb_table.get_item(Key={"PK": "CONFIG", "SK": f"ALB#{NET_ARN}"})["Item"]
    assert raw["ruleCount"] == 4
    assert raw["index"] == 0
    assert raw["status"] == "ACTIVE"
    assert raw["schemeSlug"] == "internet"


def test_try_increment_rejects_at_limit(ddb_table) -> None:
    reg.ensure_alb_registered(ALB_ARN, "internal", "vpc-1")
    _set_rule_count(ddb_table, ALB_ARN, reg.ALB_RULE_LIMIT - 1)
    assert reg.try_increment_alb_rule_count(ALB_ARN, "internal") == 90
    assert reg.try_increment_alb_rule_count(ALB_ARN, "internal") is None  # 조건(<90) 실패
    raw = ddb_table.get_item(Key={"PK": "CONFIG", "SK": f"ALB#{ALB_ARN}"})["Item"]
    assert raw["ruleCount"] == 90


def test_allocate_wait_when_all_full_and_no_priority_consumed(ddb_table) -> None:
    reg.ensure_alb_registered(ALB_ARN, "internal", "vpc-1")
    _set_rule_count(ddb_table, ALB_ARN, 90)
    slot = reg.allocate_alb_slot("internal", ALB_ARN, "vpc-1")
    assert slot == {"slotStatus": "WAIT", "spare": 0}
    # rulePriority 는 배정 성공 시에만 발급 → 카운터 미사용.
    assert reg.next_rule_priority() == 1


def test_allocate_moves_to_next_alb_by_index(ddb_table) -> None:
    reg.ensure_alb_registered(ALB_ARN, "internal", "vpc-1", index=0)
    reg.ensure_alb_registered(ALB1_ARN, "internal", "vpc-1", index=1)
    reg.ensure_alb_registered(NET_ARN, "internet-facing", "vpc-1", index=0)
    _set_rule_count(ddb_table, ALB_ARN, 90)
    _set_rule_count(ddb_table, ALB1_ARN, 5)
    slot = reg.allocate_alb_slot("internal", ALB_ARN, "vpc-1")
    assert slot["slotStatus"] == "ASSIGNED"
    assert slot["albArn"] == ALB1_ARN
    assert slot["albIndex"] == 1
    assert slot["spare"] == 84  # (90-90) + (90-6); internet ALB 는 합산 제외
    # 다른 scheme 의 ALB 는 건드리지 않는다.
    net = [i for i in list_alb_registry() if i.get("albArn") == NET_ARN][0]
    assert net["ruleCount"] == 0


def test_allocate_prefers_lowest_index_with_room(ddb_table) -> None:
    reg.ensure_alb_registered(ALB_ARN, "internal", "vpc-1", index=0)
    reg.ensure_alb_registered(ALB1_ARN, "internal", "vpc-1", index=1)
    _set_rule_count(ddb_table, ALB_ARN, 10)
    slot = reg.allocate_alb_slot("internal", ALB_ARN, "vpc-1")
    assert slot["albIndex"] == 0


def test_ensure_registered_does_not_reset_rule_count(ddb_table) -> None:
    assert reg.ensure_alb_registered(ALB1_ARN, "internal", "vpc-1", index=1) is True
    _set_rule_count(ddb_table, ALB1_ARN, 7)
    assert reg.ensure_alb_registered(ALB1_ARN, "internal", "vpc-1", index=1) is False
    raw = ddb_table.get_item(Key={"PK": "CONFIG", "SK": f"ALB#{ALB1_ARN}"})["Item"]
    assert raw["ruleCount"] == 7


def test_pending_reserve_is_conditional(ddb_table) -> None:
    assert reg.reserve_pending("internal", 1, now_epoch=1000) is True
    assert reg.reserve_pending("internal", 1, now_epoch=1000) is False  # 중복 증설 방지
    raw = ddb_table.get_item(Key={"PK": "CONFIG", "SK": "ALBPENDING#internal#1"})["Item"]
    assert raw["status"] == "PROVISIONING"
    assert raw["schemeSlug"] == "internal"
    assert raw["index"] == 1
    assert raw["ttl"] == 1000 + 2 * 60 * 60
    assert raw["createdAt"]


def test_next_index_counts_alb_and_pending(ddb_table) -> None:
    reg.ensure_alb_registered(ALB_ARN, "internal", "vpc-1", index=0)
    assert reg.next_alb_index("internal") == 1
    reg.reserve_pending("internal", 1)
    assert reg.next_alb_index("internal") == 2
    # 다른 scheme 은 독립.
    assert reg.next_alb_index("internet-facing") == 1


def test_list_pending_ignores_and_cleans_expired(ddb_table) -> None:
    reg.reserve_pending("internal", 1, now_epoch=1000)
    assert reg.list_pending("internal", now_epoch=1000 + 10)[0]["index"] == 1
    assert reg.list_pending("internal", now_epoch=1000 + 3 * 60 * 60) == []
    assert "Item" not in ddb_table.get_item(Key={"PK": "CONFIG", "SK": "ALBPENDING#internal#1"})


def test_delete_pending_respects_build_id(ddb_table) -> None:
    reg.reserve_pending("internet", 2)
    reg.set_pending_build("internet", 2, "proj:new")
    assert reg.delete_pending("internet", 2, ("proj:old",)) is False  # 늦은 구 빌드 이벤트
    assert reg.delete_pending("internet", 2, ("proj:new",)) is True
    assert reg.list_pending("internet") == []


def test_set_pending_build_does_not_resurrect_deleted(ddb_table) -> None:
    reg.set_pending_build("internal", 3, "proj:x")
    assert "Item" not in ddb_table.get_item(Key={"PK": "CONFIG", "SK": "ALBPENDING#internal#3"})


def test_list_alb_registry_includes_pending_shape(ddb_table) -> None:
    reg.ensure_alb_registered(ALB_ARN, "internal", "vpc-1", index=0)
    reg.reserve_pending("internal", 1)
    items = list_alb_registry()
    assert items[0] == {
        "albArn": ALB_ARN,
        "scheme": "internal",
        "schemeSlug": "internal",
        "index": 0,
        "status": "ACTIVE",
        "ruleCount": 0,
        "ruleLimit": 90,
        "vpcId": "vpc-1",
    }
    pend = items[1]
    assert "albArn" not in pend
    assert pend["status"] == "PROVISIONING"
    assert pend["index"] == 1
    assert pend["scheme"] == "internal"
    assert pend["ruleLimit"] == 90
