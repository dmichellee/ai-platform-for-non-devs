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
# 시크릿/환경변수 KEY: 컨테이너 env 로 주입되므로 env 변수명 규약(대문자·숫자·밑줄, 숫자로 시작 금지).
#  Secrets Manager 이름 경로 세그먼트로도 안전하다(apphub/{stage}/app/{appId}/{KEY}).
_SECRET_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


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


def _parse_secrets(body: dict[str, Any]) -> dict[str, str]:
    """시크릿 맵 {KEY: value} 파싱. KEY 는 env 변수명 규약. **값은 여기서만 통과(로그 금지).

    envVars(평문)와 분리된 필드다. 값은 Secrets Manager 로만 가고 DDB/응답엔 ARN 만 남는다.
    """
    value = body.get("secrets")
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise errors.validation("'secrets' 값은 객체여야 해요.")
    out: dict[str, str] = {}
    for k, v in value.items():
        if not isinstance(k, str) or not _SECRET_KEY_RE.match(k):
            raise errors.validation(
                "비밀 값 이름은 영문 대소문자·숫자·밑줄(_)만 쓸 수 있고 숫자로 시작할 수 없어요."
            )
        if not isinstance(v, str):
            raise errors.validation(f"'{k}' 비밀 값은 문자열이어야 해요.")
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
        # vpcId 는 제거됨(1차 플랫폼 부트스트랩 VPC 단일 배치 — DESIGN 3.7·10장).
        #  body 에 와도(구 클라이언트) 파싱하지 않고 무시한다(App 레코드에 저장하지 않음).
        "autoDeployEnabled": _bool(body, "autoDeployEnabled", True),
        "sleepMode": sleep_mode,
        "envVars": _string_map(body, "envVars"),
        # 시크릿(평문 값)은 계약상 envVars 와 분리된 별도 필드. 핸들러가 Secrets Manager 로
        #  옮기고 App.secretArns 에 ARN 만 기록한다(값은 DDB/응답에 남기지 않음).
        "secrets": _parse_secrets(body),
        "cognitoProtect": _bool(body, "cognitoProtect", scheme == "internet-facing"),
    }
    if connection_id is not None:
        result["connectionId"] = connection_id
    if schedule is not None:
        result["schedule"] = schedule
    return result


def _parse_secrets_remove(body: dict[str, Any]) -> list[str]:
    """PATCH 의 secretsRemove: 삭제할 시크릿 KEY 목록. 각 KEY 는 env 변수명 규약."""
    value = body.get("secretsRemove")
    if value is None:
        return []
    if not isinstance(value, list):
        raise errors.validation("'secretsRemove' 값은 목록이어야 해요.")
    out: list[str] = []
    for k in value:
        if not isinstance(k, str) or not _SECRET_KEY_RE.match(k):
            raise errors.validation(
                "비밀 값 이름은 영문 대소문자·숫자·밑줄(_)만 쓸 수 있고 숫자로 시작할 수 없어요."
            )
        out.append(k)
    return out


def parse_patch_app(raw: str | None) -> dict[str, Any]:
    """앱 설정 변경(부분). 변경 가능한 필드만 허용 — name/subdomain/scheme/vpc 등 불변.

    시크릿은 프론트 계약(api-requests.md 항목 9)에 맞춰 부분 갱신 + 명시 삭제로 분리한다:
      - secrets: {KEY: value} — 보낸 KEY 만 upsert(기존 유지, 빠진 KEY 를 자동 삭제하지 않음).
      - secretsRemove: [KEY, ...] — 명시된 KEY 만 삭제.
    둘 다 값이므로 update_app 에 직접 넣지 않는다 — 핸들러가 소비 후 secretArns 만 갱신한다.
    """
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
    if "secrets" in body:
        # 부분 upsert 대상(보낸 KEY 만 저장/갱신). 핸들러가 소비 후 제거.
        out["secrets"] = _parse_secrets(body)
    if "secretsRemove" in body:
        # 명시 삭제 KEY 목록. 핸들러가 소비 후 제거.
        out["secretsRemove"] = _parse_secrets_remove(body)
    if "cognitoProtect" in body:
        out["cognitoProtect"] = _bool(body, "cognitoProtect", False)
    if len(out) == 0:
        raise errors.validation("변경할 내용이 없어요.")
    return out


__all__ = ["parse_body", "parse_create_app", "parse_patch_app", "ApiError"]
