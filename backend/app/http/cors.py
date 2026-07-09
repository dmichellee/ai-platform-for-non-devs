"""CORS 헤더 주입 (프록시 통합 대응).

배경: API GW `/{proxy+}` ANY 는 Lambda 프록시 통합이므로 실제 GET/POST/PATCH/DELETE 응답의
 헤더는 이 핸들러가 직접 만든다. defaultCorsPreflightOptions(API GW)는 OPTIONS preflight의
 MOCK 응답에만 CORS 헤더를 붙이므로, 본 요청 응답에는 여기서 Access-Control-* 를 넣어야
 브라우저가 크로스 오리진 응답을 통과시킨다.

정책:
 - Access-Control-Allow-Origin 은 절대 `*` 를 쓰지 않는다(credentialed 시맨틱·보안).
 - 허용 origin 목록(ALLOWED_ORIGINS, 콤마 구분)을 env 로 주입받아, 요청 Origin 헤더가
   목록에 있으면 그 값을 그대로 echo. 목록에 없으면 ACAO 를 아예 넣지 않아 브라우저가 차단.
 - Vary: Origin 으로 origin echo 캐시 오염을 방지한다.
 - Allow-Credentials: true (특정 origin echo 시에만 유효).
"""

from __future__ import annotations

import os
from typing import Any

from .response import ProxyResult

ALLOW_HEADERS = "Authorization, Content-Type"
ALLOW_METHODS = "GET,POST,PATCH,DELETE,OPTIONS"
MAX_AGE_SECONDS = "600"


def allowed_origins() -> list[str]:
    """ALLOWED_ORIGINS env 를 파싱해 정규화한 허용 origin 목록. 미설정이면 빈 목록."""
    raw = os.environ.get("ALLOWED_ORIGINS")
    if not raw:
        return []
    return [item for item in (segment.strip().rstrip("/") for segment in raw.split(",")) if item]


def extract_origin(event: dict[str, Any]) -> str | None:
    """요청 헤더에서 Origin 추출 (헤더명 대소문자 무시)."""
    headers = event.get("headers") or {}
    for key, value in headers.items():
        if key.lower() == "origin" and isinstance(value, str):
            return value.rstrip("/")
    return None


def cors_headers(event: dict[str, Any]) -> dict[str, str]:
    """요청 Origin 에 대해 응답에 붙일 CORS 헤더 집합.

    요청 Origin 이 허용목록에 있을 때만 Access-Control-Allow-Origin 을 echo.
    허용되지 않으면 Vary 만 남겨(캐시 안전) ACAO 를 넣지 않는다.
    """
    headers: dict[str, str] = {"Vary": "Origin"}
    origin = extract_origin(event)
    if origin is not None and origin in allowed_origins():
        headers["Access-Control-Allow-Origin"] = origin
        headers["Access-Control-Allow-Credentials"] = "true"
        headers["Access-Control-Allow-Headers"] = ALLOW_HEADERS
        headers["Access-Control-Allow-Methods"] = ALLOW_METHODS
        headers["Access-Control-Max-Age"] = MAX_AGE_SECONDS
    return headers


def with_cors(event: dict[str, Any], res: ProxyResult) -> ProxyResult:
    """응답 객체에 CORS 헤더를 병합한다. 기존 헤더는 유지, CORS 헤더가 우선."""
    merged = dict(res.get("headers") or {})
    merged.update(cors_headers(event))
    return {**res, "headers": merged}


def preflight_response(event: dict[str, Any]) -> ProxyResult:
    """OPTIONS preflight 방어 응답 (이중 안전).

    정상 경로에선 API GW defaultCorsPreflightOptions(MOCK)가 처리하나, 프록시로 OPTIONS 가
    Lambda 까지 도달하는 경우를 대비해 204 + CORS 헤더로 응답한다. 인증 검사 이전에 호출해야
    한다(preflight 요청은 Authorization 헤더를 동반하지 않으므로 authorizer 를 우회한다).
    """
    return {"statusCode": 204, "headers": cors_headers(event), "body": ""}
