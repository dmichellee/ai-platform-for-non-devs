"""앱 생성/수정 요청 파싱·형식 검증.

비즈니스 규칙(쿼터/프리셋 존재/서브도메인 유일성)은 핸들러 소관.
반환 dict 의 키는 camelCase(계약 정합) — 내부 로컬 변수만 snake_case.
"""

from __future__ import annotations

import json
import re
from typing import Any

from ..http.errors import ApiError, errors

_SCHEMES = ("internet-facing", "internal")
_SLEEP_MODES = ("always-on", "on-demand", "schedule")
_PROVIDERS = ("codecommit", "github", "gitlab")
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def parse_body(raw: str | None) -> dict[str, Any]:
    """안전 파서 — JSON 본문을 객체로. 실패 시 VALIDATION_ERROR."""
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError) as err:
        raise errors.validation("요청 본문을 해석할 수 없어요.") from err
    if not isinstance(parsed, dict):
        raise errors.validation("요청 본문 형식이 올바르지 않아요.")
    return parsed


def _str(body: dict[str, Any], key: str, required: bool = True) -> str | None:
    value = body.get(key)
    if value is None or value == "":
        if required:
            raise errors.validation(f"'{key}' 값이 필요해요.")
        return None
    if not isinstance(value, str):
        raise errors.validation(f"'{key}' 값은 문자열이어야 해요.")
    return value


def _bool(body: dict[str, Any], key: str, default: bool) -> bool:
    value = body.get(key)
    if value is None and key not in body:
        return default
    if value is None:
        # 명시적 null 은 default 로 취급(TS: undefined 만 default, null 은 형식오류였으나
        # JSON null → Python None. 계약상 null 전달은 없으므로 default 로 안전 처리).
        return default
    if not isinstance(value, bool):
        raise errors.validation(f"'{key}' 값은 true/false여야 해요.")
    return value


def _string_map(body: dict[str, Any], key: str) -> dict[str, str]:
    value = body.get(key)
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise errors.validation(f"'{key}' 값은 객체여야 해요.")
    out: dict[str, str] = {}
    for k, v in value.items():
        if not isinstance(v, str):
            raise errors.validation(f"'{key}.{k}' 값은 문자열이어야 해요.")
        out[k] = v
    return out


def _parse_schedule(body: dict[str, Any]) -> dict[str, Any] | None:
    value = body.get("schedule")
    if value is None:
        return None
    if not isinstance(value, dict):
        raise errors.validation("'schedule' 값은 객체여야 해요.")
    start_time = value.get("startTime")
    stop_time = value.get("stopTime")
    days = value.get("days")
    timezone_value = value.get("timezone", "Asia/Seoul")
    if not isinstance(start_time, str) or not _TIME_RE.match(start_time):
        raise errors.validation("가동 시작 시각 형식이 올바르지 않아요(예: 09:00).")
    if not isinstance(stop_time, str) or not _TIME_RE.match(stop_time):
        raise errors.validation("가동 종료 시각 형식이 올바르지 않아요(예: 19:00).")
    if (
        not isinstance(days, list)
        or len(days) == 0
        or not all(isinstance(d, int) and not isinstance(d, bool) and 0 <= d <= 6 for d in days)
    ):
        raise errors.validation("가동 요일 설정이 올바르지 않아요.")
    if not isinstance(timezone_value, str):
        raise errors.validation("시간대 값이 올바르지 않아요.")
    return {
        "startTime": start_time,
        "stopTime": stop_time,
        "days": days,
        "timezone": timezone_value,
    }


def parse_create_app(raw: str | None) -> dict[str, Any]:
    """앱 생성 요청 파싱·형식 검증."""
    body = parse_body(raw)

    name = _str(body, "name")
    assert name is not None
    if len(name) > 60:
        raise errors.validation("앱 이름은 60자 이하여야 해요.")

    provider = _str(body, "provider")
    if provider not in _PROVIDERS:
        raise errors.validation("지원하지 않는 저장소 방식이에요.")

    scheme = _str(body, "scheme")
    if scheme not in _SCHEMES:
        raise errors.validation("공개 범위 값이 올바르지 않아요.")

    sleep_mode = _str(body, "sleepMode")
    if sleep_mode not in _SLEEP_MODES:
        raise errors.validation("가동 방식 값이 올바르지 않아요.")

    schedule = _parse_schedule(body)
    if sleep_mode == "schedule" and schedule is None:
        raise errors.validation("시간표대로 가동하려면 가동 시간표를 설정해야 해요.")

    connection_id = _str(body, "connectionId", required=False)
    if provider in ("github", "gitlab") and not connection_id:
        raise errors.validation("이 저장소 방식은 먼저 저장소 연결이 필요해요.")

    result: dict[str, Any] = {
        "name": name,
        "subdomain": _str(body, "subdomain"),
        "provider": provider,
        "repoUrl": _str(body, "repoUrl"),
        "branch": _str(body, "branch", required=False) or "main",
        "presetId": _str(body, "presetId"),
        "permissionTemplateId": _str(body, "permissionTemplateId"),
        "scheme": scheme,
        "vpcId": _str(body, "vpcId"),
        "autoDeployEnabled": _bool(body, "autoDeployEnabled", True),
        "sleepMode": sleep_mode,
        "envVars": _string_map(body, "envVars"),
        "cognitoProtect": _bool(body, "cognitoProtect", scheme == "internet-facing"),
    }
    if connection_id is not None:
        result["connectionId"] = connection_id
    if schedule is not None:
        result["schedule"] = schedule
    return result


def parse_patch_app(raw: str | None) -> dict[str, Any]:
    """앱 설정 변경(부분). 변경 가능한 필드만 허용 — name/subdomain/scheme/vpc 등 불변."""
    body = parse_body(raw)
    out: dict[str, Any] = {}
    if "autoDeployEnabled" in body:
        out["autoDeployEnabled"] = _bool(body, "autoDeployEnabled", True)
    if "sleepMode" in body:
        sleep_mode = body.get("sleepMode")
        if sleep_mode not in _SLEEP_MODES:
            raise errors.validation("가동 방식 값이 올바르지 않아요.")
        out["sleepMode"] = sleep_mode
    schedule = _parse_schedule(body)
    if schedule is not None:
        out["schedule"] = schedule
    if "envVars" in body:
        out["envVars"] = _string_map(body, "envVars")
    if "cognitoProtect" in body:
        out["cognitoProtect"] = _bool(body, "cognitoProtect", False)
    if len(out) == 0:
        raise errors.validation("변경할 내용이 없어요.")
    return out


__all__ = ["parse_body", "parse_create_app", "parse_patch_app", "ApiError"]
