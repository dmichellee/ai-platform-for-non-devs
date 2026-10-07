"""CONFIG 파티션 데이터 액세스 — AdminSettings / ComputePreset / PermissionTemplate / AlbRegistry(읽기)."""

from __future__ import annotations

from typing import Any

from boto3.dynamodb.conditions import Key

from ..domain.alb_scheme import scheme_from_slug
from ..util import now_iso
from .client import clean_item, strip_item, table
from .keys import (
    CONFIG_PK,
    SETTINGS_SK,
    SkPrefix,
    perm_sk,
    preset_sk,
)

_CONFIG_DROP = ("PK", "SK", "entityType")
# AdminSettings 응답에서 추가로 떨어뜨릴 폐기 필드(구 스키마 잔여, 스키마리스 — 저장은 무해):
#  - allowedBaseImages: 베이스 이미지 허용목록 기능 폐기.
#  - registeredVpcs: VPC 등록/선택 기능 폐기(1차 플랫폼 부트스트랩 VPC 단일 배치).
#  - logRetentionDays: 미사용 설정 폐기.
_SETTINGS_DROP = (*_CONFIG_DROP, "allowedBaseImages", "registeredVpcs", "logRetentionDays")

# 플랫폼 기본 설정(부트스트랩용). GET 시 없으면 이 값으로 응답.
DEFAULT_ADMIN_SETTINGS: dict[str, Any] = {
    "enabledProviders": ["codecommit"],
    "userAppQuota": 5,
    "allowInternetFacing": False,
    "updatedAt": "1970-01-01T00:00:00.000Z",
}


# ── AdminSettings ─────────────────────────────────────────────────────────────


def get_admin_settings() -> dict[str, Any]:
    res = table().get_item(Key={"PK": CONFIG_PK, "SK": SETTINGS_SK})
    item = res.get("Item")
    if not item:
        return dict(DEFAULT_ADMIN_SETTINGS)
    # 구 스키마 잔여 allowedBaseImages 는 응답에서 무시(스키마리스 — 저장은 무해).
    return strip_item(item, _SETTINGS_DROP)  # type: ignore[return-value]


def put_admin_settings(settings: dict[str, Any]) -> dict[str, Any]:
    updated_at = now_iso()
    item = clean_item(
        {
            "PK": CONFIG_PK,
            "SK": SETTINGS_SK,
            "entityType": "AdminSettings",
            **settings,
            "updatedAt": updated_at,
        }
    )
    table().put_item(Item=item)
    return {**settings, "updatedAt": updated_at}


# ── ComputePreset ─────────────────────────────────────────────────────────────


def get_preset(preset_id: str) -> dict[str, Any] | None:
    res = table().get_item(Key={"PK": CONFIG_PK, "SK": preset_sk(preset_id)})
    return strip_item(res.get("Item"), _CONFIG_DROP)


def list_presets() -> list[dict[str, Any]]:
    res = table().query(
        KeyConditionExpression=Key("PK").eq(CONFIG_PK) & Key("SK").begins_with(SkPrefix.PRESET),
    )
    return [strip_item(i, _CONFIG_DROP) for i in res.get("Items", [])]  # type: ignore[misc]


def put_preset(preset: dict[str, Any]) -> dict[str, Any]:
    item = clean_item(
        {
            "PK": CONFIG_PK,
            "SK": preset_sk(preset["presetId"]),
            "entityType": "ComputePreset",
            **preset,
        }
    )
    table().put_item(Item=item)
    return preset


def delete_preset(preset_id: str) -> None:
    table().delete_item(Key={"PK": CONFIG_PK, "SK": preset_sk(preset_id)})


# ── PermissionTemplate ────────────────────────────────────────────────────────


def get_permission_template(perm_id: str) -> dict[str, Any] | None:
    res = table().get_item(Key={"PK": CONFIG_PK, "SK": perm_sk(perm_id)})
    return strip_item(res.get("Item"), _CONFIG_DROP)


def list_permission_templates() -> list[dict[str, Any]]:
    res = table().query(
        KeyConditionExpression=Key("PK").eq(CONFIG_PK) & Key("SK").begins_with(SkPrefix.PERM),
    )
    return [strip_item(i, _CONFIG_DROP) for i in res.get("Items", [])]  # type: ignore[misc]


def put_permission_template(template: dict[str, Any]) -> dict[str, Any]:
    item = clean_item(
        {
            "PK": CONFIG_PK,
            "SK": perm_sk(template["permId"]),
            "entityType": "PermissionTemplate",
            **template,
        }
    )
    table().put_item(Item=item)
    return template


def delete_permission_template(perm_id: str) -> None:
    table().delete_item(Key={"PK": CONFIG_PK, "SK": perm_sk(perm_id)})


# ── AlbRegistry (읽기 위주 — 조작은 P2 SFN) ──────────────────────────────────


def list_alb_registry() -> list[dict[str, Any]]:
    """관리자 인프라 현황(계약 delta §8): ALB# 항목 + 증설 대기(PENDING) 항목.

    ALB#: `{albArn, scheme, schemeSlug, index, status, ruleCount, ruleLimit, vpcId}`
      (기존 아이템에 index/status 없으면 0/ACTIVE).
    PENDING: `{scheme, schemeSlug, index, status:"PROVISIONING", ruleCount:0, ruleLimit, createdAt}`
      (albArn 없음, 만료(ttl 경과)분 제외). 정렬: schemeSlug → index, 같은 index 면 ALB# 먼저.
    """
    from . import alb_registry  # 순환 import 방지(alb_registry 는 쓰기 소유 모듈)

    items: list[dict[str, Any]] = []
    for alb in alb_registry.list_albs():
        items.append({**alb, "ruleLimit": alb_registry.ALB_RULE_LIMIT})
    for pend in alb_registry.list_pending():
        items.append(
            {
                "scheme": scheme_from_slug(pend["schemeSlug"]),
                "schemeSlug": pend["schemeSlug"],
                "index": pend["index"],
                "status": alb_registry.PENDING_STATUS,
                "ruleCount": 0,
                "ruleLimit": alb_registry.ALB_RULE_LIMIT,
                "createdAt": pend.get("createdAt"),
            }
        )
    items.sort(key=lambda i: (i.get("schemeSlug") or "", i["index"], "albArn" not in i))
    return [{k: v for k, v in i.items() if v is not None} for i in items]
