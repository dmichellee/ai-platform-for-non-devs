"""관리자 CONFIG 입력 검증 — AdminSettings / ComputePreset / PermissionTemplate."""

from __future__ import annotations

from typing import Any

from ..http.errors import errors
from .ids import random_id
from .validate import parse_body

_PROVIDERS = ("codecommit", "github", "gitlab")

# Fargate 유효 cpu/memory 조합(DESIGN.md D11 "Fargate 유효 조합만").
_FARGATE_VALID: dict[int, list[int]] = {
    256: [512, 1024, 2048],
    512: [1024, 2048, 3072, 4096],
    1024: [2048, 3072, 4096, 5120, 6144, 7168, 8192],
    2048: [
        4096,
        5120,
        6144,
        7168,
        8192,
        9216,
        10240,
        11264,
        12288,
        13312,
        14336,
        15360,
        16384,
    ],
    4096: [
        8192,
        9216,
        10240,
        11264,
        12288,
        13312,
        14336,
        15360,
        16384,
        17408,
        18432,
        19456,
        20480,
        21504,
        22528,
        23552,
        24576,
        25600,
        26624,
        27648,
        28672,
        29696,
        30720,
    ],
}


def generate_id() -> str:
    return random_id(8)


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def parse_admin_settings(raw: str | None) -> dict[str, Any]:
    body = parse_body(raw)

    enabled_providers = body.get("enabledProviders")
    if not isinstance(enabled_providers, list) or not all(
        isinstance(p, str) and p in _PROVIDERS for p in enabled_providers
    ):
        raise errors.validation("저장소 방식 목록이 올바르지 않아요.")

    registered_vpcs = body.get("registeredVpcs")
    if not isinstance(registered_vpcs, list) or not all(
        isinstance(v, dict) and isinstance(v.get("vpcId"), str) and isinstance(v.get("label"), str)
        for v in registered_vpcs
    ):
        raise errors.validation("VPC 목록 형식이 올바르지 않아요.")

    user_app_quota = body.get("userAppQuota")
    if not _is_int(user_app_quota) or user_app_quota < 0:
        raise errors.validation("앱 쿼터는 0 이상의 정수여야 해요.")

    allow_internet_facing = body.get("allowInternetFacing")
    if not isinstance(allow_internet_facing, bool):
        raise errors.validation("회사 밖 접속 허용 값은 true/false여야 해요.")

    allowed_base_images = body.get("allowedBaseImages")
    if not isinstance(allowed_base_images, list) or not all(
        isinstance(i, str) for i in allowed_base_images
    ):
        raise errors.validation("허용 베이스 이미지 목록이 올바르지 않아요.")

    log_retention_days = body.get("logRetentionDays", 30)
    if not _is_number(log_retention_days) or log_retention_days <= 0:
        raise errors.validation("로그 보존 기간이 올바르지 않아요.")

    return {
        "enabledProviders": enabled_providers,
        "registeredVpcs": registered_vpcs,
        "userAppQuota": user_app_quota,
        "allowInternetFacing": allow_internet_facing,
        "allowedBaseImages": allowed_base_images,
        "logRetentionDays": log_retention_days,
    }


def parse_preset(raw: str | None) -> dict[str, Any]:
    body = parse_body(raw)
    display_name = body.get("displayName")
    if not isinstance(display_name, str) or display_name == "":
        raise errors.validation("프리셋 이름을 입력해주세요.")
    cpu = body.get("cpu")
    memory = body.get("memory")
    if not _is_number(cpu) or not _is_number(memory):
        raise errors.validation("cpu/memory 값이 필요해요.")
    valid_mems = _FARGATE_VALID.get(int(cpu))
    if valid_mems is None or int(memory) not in valid_mems:
        raise errors.validation("Fargate에서 지원하지 않는 cpu/memory 조합이에요.")
    min_count = body.get("minCount")
    max_count = body.get("maxCount")
    if (
        not _is_number(min_count)
        or not _is_number(max_count)
        or min_count < 0
        or max_count < min_count
    ):
        raise errors.validation("최소/최대 실행 개수가 올바르지 않아요.")
    scale_metric = body.get("scaleMetric")
    if scale_metric not in ("cpu", "requests"):
        raise errors.validation("스케일 기준 값이 올바르지 않아요.")
    scale_threshold = body.get("scaleThreshold")
    if not _is_number(scale_threshold) or scale_threshold <= 0:
        raise errors.validation("스케일 임계값이 올바르지 않아요.")
    result: dict[str, Any] = {
        "displayName": display_name,
        "cpu": cpu,
        "memory": memory,
        "minCount": min_count,
        "maxCount": max_count,
        "scaleMetric": scale_metric,
        "scaleThreshold": scale_threshold,
    }
    preset_id = body.get("presetId")
    if isinstance(preset_id, str):
        result["presetId"] = preset_id
    return result


def parse_permission_template(raw: str | None) -> dict[str, Any]:
    body = parse_body(raw)
    display_name = body.get("displayName")
    if not isinstance(display_name, str) or display_name == "":
        raise errors.validation("템플릿 이름을 입력해주세요.")
    policy_document = body.get("policyDocument")
    if not isinstance(policy_document, dict):
        raise errors.validation("정책 문서 형식이 올바르지 않아요.")
    result: dict[str, Any] = {
        "displayName": display_name,
        "policyDocument": policy_document,
    }
    perm_id = body.get("permId")
    if isinstance(perm_id, str):
        result["permId"] = perm_id
    return result
