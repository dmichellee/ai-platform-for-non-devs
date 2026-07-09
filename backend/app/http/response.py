"""API 응답 형식 (apphub-conventions 3장 / api-contract.md):

- 성공(단건):  {"data": ...}
- 성공(목록):  {"data": {"items": [...], "nextToken"?}}
- 성공(본문 없음): HTTP 204, 본문 없음
- 실패:        {"error": {"code", "message"}}

API GW 프록시 통합 응답 형식: {"statusCode", "headers", "body"}(body는 JSON 문자열).
"""

from __future__ import annotations

import json
import logging
from typing import Any

from .errors import ApiError

logger = logging.getLogger("apphub.api")

# camelCase 키 보존 + 한글 원문 유지(ensure_ascii=False) — 프론트 계약과 일치.
JSON_HEADERS = {"Content-Type": "application/json; charset=utf-8"}

ProxyResult = dict[str, Any]


def _body(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def ok(data: Any, status_code: int = 200) -> ProxyResult:
    return {
        "statusCode": status_code,
        "headers": dict(JSON_HEADERS),
        "body": _body({"data": data}),
    }


def created(data: Any) -> ProxyResult:
    return ok(data, 201)


def no_content() -> ProxyResult:
    """204 No Content — body 없음."""
    return {"statusCode": 204, "headers": dict(JSON_HEADERS), "body": ""}


def list_response(items: list[Any], next_token: str | None = None) -> ProxyResult:
    payload: dict[str, Any] = {"items": items}
    if next_token is not None:
        payload["nextToken"] = next_token
    return ok(payload)


def error_response(status_code: int, code: str, message: str) -> ProxyResult:
    return {
        "statusCode": status_code,
        "headers": dict(JSON_HEADERS),
        "body": _body({"error": {"code": code, "message": message}}),
    }


def to_error_response(err: BaseException) -> ProxyResult:
    """던져진 예외를 응답으로 변환.

    ApiError는 코드/상태 보존, 그 외는 INTERNAL_ERROR로 마스킹(시크릿 노출 방지).
    """
    if isinstance(err, ApiError):
        return error_response(err.status_code, err.code, err.message)
    logger.exception("[unhandled]", exc_info=err)
    return error_response(500, "INTERNAL_ERROR", "플랫폼 내부 문제예요. 관리자에게 문의해주세요.")
