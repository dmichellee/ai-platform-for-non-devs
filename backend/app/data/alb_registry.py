"""ALB 슬롯 배정 + 증설 대기 레지스트리 (DESIGN.md 3.4·D20, 계약 delta-2026-10-07 §3).

- rulePriority: 전역 단조 증가 카운터(`CONFIG/RULEPRIORITYSEQ`)를 원자적으로 발급한다.
  ALB 내 유일성만 필요하므로 전역 단조 증가면 충분(자동 채번 금지 규약). 배정 성공 후에만 발급.
- AlbRegistry `CONFIG/ALB#{albArn}`: scheme·schemeSlug·index·status(ACTIVE)·ruleCount·vpcId.
  n=0(network 스택의 기존 ALB)은 첫 사용 시 lazy 시드(조건부 Put 멱등). 기존 아이템에
  index/status 가 없으면 0/ACTIVE 로 간주하고 다음 쓰기(ruleCount 증가) 때 보정한다.
- 배정: 같은 scheme 의 ACTIVE ALB 를 index 오름차순으로 `ruleCount < 90` 조건부 +1 → 성공한 첫 ALB.
  모두 90이면 slotStatus=WAIT(호출부가 증설 시작/진행 확인 후 SFN 이 Wait 30초 → 재호출).
- 증설 대기 `CONFIG/ALBPENDING#{schemeSlug}#{n}`: 중복 증설 방지용 조건부 Put(attribute_not_exists),
  ttl=생성+2시간(고착 방지 — DDB TTL 삭제는 지연되므로 읽을 때도 만료분은 무시·정리).
- 감소는 앱 albArn 기준(delete cleanup, 현행) — ruleCount>0 조건으로 음수 방지·멱등.

config_repo.list_alb_registry(관리자 읽기)와 분리 — 쓰기/배정은 이 모듈이 소유.
"""

from __future__ import annotations

import time
from typing import Any

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from ..domain.alb_scheme import scheme_from_slug, scheme_slug
from ..util import now_iso
from .client import is_conditional_check_failed, table
from .keys import CONFIG_PK, SkPrefix, alb_pending_sk, alb_sk

RULE_PRIORITY_BASE = 1
ALB_RULE_LIMIT = 90
# 배정 후 scheme 전체 여유(Σ(90−ruleCount))가 이 값 이하면 선제 증설(= 1대 기준 80 도달).
ALB_SCALE_OUT_SPARE = 10
# 호환 별칭(구 이름).
ALB_RULE_SOFT_LIMIT = ALB_RULE_LIMIT
RULE_PRIORITY_SEQ_SK = "RULEPRIORITYSEQ"
PENDING_TTL_SECONDS = 2 * 60 * 60

ALB_STATUS_ACTIVE = "ACTIVE"
PENDING_STATUS = "PROVISIONING"


# ── AlbRegistry(ALB#) ──────────────────────────────────────────────────────────


def normalize_alb_item(item: dict[str, Any]) -> dict[str, Any]:
    """ALB# 아이템을 계약 shape 로 정규화(index/status/schemeSlug 없으면 0/ACTIVE/파생)."""
    scheme = item.get("scheme")
    slug = item.get("schemeSlug") or (scheme_slug(scheme) if scheme else None)
    return {
        "albArn": item.get("albArn"),
        "scheme": scheme,
        "schemeSlug": slug,
        "index": int(item.get("index") or 0),
        "status": item.get("status") or ALB_STATUS_ACTIVE,
        "ruleCount": int(item.get("ruleCount") or 0),
        "vpcId": item.get("vpcId"),
    }


def ensure_alb_registered(
    alb_arn: str,
    scheme: str,
    vpc_id: str | None,
    index: int = 0,
) -> bool:
    """ALB 레지스트리 아이템(ACTIVE, ruleCount=0)을 조건부 Put. 이미 있으면 no-op(False).

    n=0 lazy 시드와 증설 완료(deploy-notify) 양쪽이 사용한다. 이미 있으면 ruleCount 를 리셋하지 않는다.
    """
    item: dict[str, Any] = {
        "PK": CONFIG_PK,
        "SK": alb_sk(alb_arn),
        "entityType": "AlbRegistry",
        "albArn": alb_arn,
        "scheme": scheme_from_slug(scheme),
        "schemeSlug": scheme_slug(scheme),
        "index": int(index),
        "status": ALB_STATUS_ACTIVE,
        "ruleCount": 0,
    }
    if vpc_id:
        item["vpcId"] = vpc_id
    try:
        table().put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(PK) AND attribute_not_exists(SK)",
        )
        return True
    except ClientError as err:
        if is_conditional_check_failed(err):
            return False
        raise


def _query_config_prefix(prefix: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    kwargs: dict[str, Any] = {
        "KeyConditionExpression": Key("PK").eq(CONFIG_PK) & Key("SK").begins_with(prefix),
    }
    while True:
        res = table().query(**kwargs)
        items.extend(res.get("Items") or [])
        last = res.get("LastEvaluatedKey")
        if not last:
            return items
        kwargs["ExclusiveStartKey"] = last


def list_albs(scheme: str | None = None) -> list[dict[str, Any]]:
    """ALB# 아이템(정규화) — scheme 지정 시 해당 scheme 만. (scheme, index) 오름차순."""
    slug = scheme_slug(scheme) if scheme else None
    out = [normalize_alb_item(i) for i in _query_config_prefix(SkPrefix.ALB)]
    if slug:
        out = [a for a in out if a["schemeSlug"] == slug]
    return sorted(out, key=lambda a: (a["schemeSlug"] or "", a["index"]))


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


def try_increment_alb_rule_count(alb_arn: str, scheme: str) -> int | None:
    """`ruleCount < 90` 조건부로 +1. 성공 시 증가 후 값, 한도 도달(조건 실패)이면 None.

    같은 쓰기에서 index/status/schemeSlug 누락분을 0/ACTIVE/파생값으로 보정한다(계약 §3.1).
    """
    try:
        res = table().update_item(
            Key={"PK": CONFIG_PK, "SK": alb_sk(alb_arn)},
            UpdateExpression=(
                "SET ruleCount = if_not_exists(ruleCount, :zero) + :one, "
                "#idx = if_not_exists(#idx, :zero), "
                "#st = if_not_exists(#st, :active), "
                "schemeSlug = if_not_exists(schemeSlug, :slug)"
            ),
            ConditionExpression=(
                "attribute_exists(SK) AND (attribute_not_exists(ruleCount) OR ruleCount < :limit)"
            ),
            ExpressionAttributeNames={"#idx": "index", "#st": "status"},
            ExpressionAttributeValues={
                ":zero": 0,
                ":one": 1,
                ":limit": ALB_RULE_LIMIT,
                ":active": ALB_STATUS_ACTIVE,
                ":slug": scheme_slug(scheme),
            },
            ReturnValues="UPDATED_NEW",
        )
    except ClientError as err:
        if is_conditional_check_failed(err):
            return None
        raise
    count = (res.get("Attributes") or {}).get("ruleCount")
    return int(count) if count is not None else 0


def increment_alb_rule_count(alb_arn: str) -> int:
    """[호환용] ALB별 ruleCount 를 원자적으로 +1(한도 무관). 증가 후 값을 반환."""
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


def spare_capacity(albs: list[dict[str, Any]]) -> int:
    """ACTIVE ALB 들의 남은 규칙 자리 합 Σ(90−ruleCount)."""
    return sum(
        max(ALB_RULE_LIMIT - int(a["ruleCount"]), 0)
        for a in albs
        if a.get("status") == ALB_STATUS_ACTIVE
    )


def allocate_alb_slot(scheme: str, seed_alb_arn: str, vpc_id: str | None) -> dict[str, Any]:
    """scheme 의 ACTIVE ALB 중 index 오름차순으로 자리 배정(계약 §3.4).

    1) n=0 ALB(seed_alb_arn) lazy 시드 → 2) ACTIVE ALB 를 index 순으로 `ruleCount<90` 조건부 +1
    → 3) 성공 시 rulePriority 발급. 반환:
      - `{"slotStatus":"ASSIGNED","albArn","albIndex","rulePriority","spare"}` (spare = 배정 후 여유)
      - `{"slotStatus":"WAIT","spare":0}` (모든 ALB 가 90)
    증설 시작 여부 판단은 호출부(provision)가 spare 와 PENDING 으로 한다.
    """
    ensure_alb_registered(seed_alb_arn, scheme, vpc_id, index=0)
    albs = [a for a in list_albs(scheme) if a["status"] == ALB_STATUS_ACTIVE]
    albs.sort(key=lambda a: a["index"])
    for alb in albs:
        if alb["ruleCount"] >= ALB_RULE_LIMIT:
            continue
        new_count = try_increment_alb_rule_count(alb["albArn"], scheme)
        if new_count is None:
            # 경합으로 방금 90 도달 — 최신값 반영 후 다음 ALB 시도.
            alb["ruleCount"] = ALB_RULE_LIMIT
            continue
        alb["ruleCount"] = new_count
        return {
            "slotStatus": "ASSIGNED",
            "albArn": alb["albArn"],
            "albIndex": alb["index"],
            "rulePriority": next_rule_priority(),
            "spare": spare_capacity(albs),
        }
    return {"slotStatus": "WAIT", "spare": spare_capacity(albs)}


# ── 증설 대기(ALBPENDING#) ───────────────────────────────────────────────────────


def _pending_view(item: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "schemeSlug": item.get("schemeSlug"),
        "index": int(item.get("index") or 0),
        "status": item.get("status") or PENDING_STATUS,
        "createdAt": item.get("createdAt"),
        "ttl": int(item.get("ttl") or 0),
    }
    if item.get("buildId"):
        out["buildId"] = item["buildId"]
    return out


def list_pending(scheme: str | None = None, now_epoch: int | None = None) -> list[dict[str, Any]]:
    """만료되지 않은 PENDING 아이템(정규화). 만료분(ttl 경과)은 무시하고 최선 정리한다."""
    now = int(now_epoch if now_epoch is not None else time.time())
    prefix = SkPrefix.ALBPENDING + (f"{scheme_slug(scheme)}#" if scheme else "")
    live: list[dict[str, Any]] = []
    for item in _query_config_prefix(prefix):
        view = _pending_view(item)
        if view["ttl"] and view["ttl"] <= now:
            _delete_expired_pending(item["SK"], view["ttl"])
            continue
        live.append(view)
    return sorted(live, key=lambda p: (p["schemeSlug"] or "", p["index"]))


def _delete_expired_pending(sk: str, ttl: int) -> None:
    try:
        table().delete_item(
            Key={"PK": CONFIG_PK, "SK": sk},
            ConditionExpression="#ttl = :ttl",
            ExpressionAttributeNames={"#ttl": "ttl"},
            ExpressionAttributeValues={":ttl": ttl},
        )
    except ClientError as err:
        if not is_conditional_check_failed(err):
            raise


def next_alb_index(scheme: str, pending: list[dict[str, Any]] | None = None) -> int:
    """다음 증설 index = max(ALB# index, 살아있는 PENDING index) + 1 (계약 §3.2)."""
    slug = scheme_slug(scheme)
    indexes = [a["index"] for a in list_albs(slug)]
    pend = pending if pending is not None else list_pending(slug)
    indexes.extend(p["index"] for p in pend if p["schemeSlug"] == slug)
    return (max(indexes) if indexes else 0) + 1


def reserve_pending(scheme: str, index: int, now_epoch: int | None = None) -> bool:
    """PENDING 조건부 Put(attribute_not_exists). 성공 True, 이미 있으면(중복 증설) False."""
    now = int(now_epoch if now_epoch is not None else time.time())
    slug = scheme_slug(scheme)
    try:
        table().put_item(
            Item={
                "PK": CONFIG_PK,
                "SK": alb_pending_sk(slug, index),
                "entityType": "AlbPending",
                "schemeSlug": slug,
                "index": int(index),
                "status": PENDING_STATUS,
                "createdAt": now_iso(),
                "ttl": now + PENDING_TTL_SECONDS,
            },
            ConditionExpression="attribute_not_exists(PK) AND attribute_not_exists(SK)",
        )
        return True
    except ClientError as err:
        if is_conditional_check_failed(err):
            return False
        raise


def set_pending_build(scheme: str, index: int, build_id: str) -> None:
    """PENDING 에 buildId 기록. 이미 완료돼 삭제됐으면(빠른 빌드) 되살리지 않는다(조건 실패 삼킴)."""
    try:
        table().update_item(
            Key={"PK": CONFIG_PK, "SK": alb_pending_sk(scheme_slug(scheme), index)},
            UpdateExpression="SET buildId = :b",
            ConditionExpression="attribute_exists(SK)",
            ExpressionAttributeValues={":b": build_id},
        )
    except ClientError as err:
        if not is_conditional_check_failed(err):
            raise


def delete_pending(scheme: str, index: int, build_ids: tuple[str, ...] | None = None) -> bool:
    """PENDING 삭제(멱등). build_ids 지정 시 buildId 가 없거나 그중 하나일 때만(늦은 이벤트 방어)."""
    kwargs: dict[str, Any] = {"Key": {"PK": CONFIG_PK, "SK": alb_pending_sk(scheme_slug(scheme), index)}}
    if build_ids:
        names = [f":b{i}" for i in range(len(build_ids))]
        kwargs["ConditionExpression"] = (
            f"attribute_not_exists(buildId) OR buildId IN ({', '.join(names)})"
        )
        kwargs["ExpressionAttributeValues"] = dict(zip(names, build_ids, strict=True))
    try:
        table().delete_item(**kwargs)
        return True
    except ClientError as err:
        if is_conditional_check_failed(err):
            return False
        raise
