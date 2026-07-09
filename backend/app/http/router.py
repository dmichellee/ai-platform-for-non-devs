"""최소 라우터. API GW `/{proxy+}` 통합이므로 event.path(또는 pathParameters.proxy)로

경로를 얻어 메서드 + 패턴 매칭으로 핸들러를 분기한다.

패턴 문법: `/apps/:id/deploy` — `:` 세그먼트는 params로 캡처.
"""

from __future__ import annotations

import urllib.parse
from dataclasses import dataclass
from typing import Any, Callable

from ..auth.identity import Identity
from .errors import errors
from .response import ProxyResult


@dataclass(frozen=True)
class RouteContext:
    event: dict[str, Any]
    identity: Identity
    params: dict[str, str]
    query: dict[str, str]


RouteHandler = Callable[[RouteContext], ProxyResult]


@dataclass(frozen=True)
class _Route:
    method: str
    segments: list[str]
    handler: RouteHandler


def _split_path(path: str) -> list[str]:
    return [s for s in path.split("/") if s]


def extract_path(event: dict[str, Any]) -> str:
    """REST proxy 통합의 pathParameters.proxy 우선, 없으면 event.path."""
    path_params = event.get("pathParameters") or {}
    proxy = path_params.get("proxy")
    if isinstance(proxy, str) and proxy:
        return proxy if proxy.startswith("/") else f"/{proxy}"
    raw = event.get("path") or "/"
    return raw


def _match_segments(pattern: list[str], actual: list[str]) -> dict[str, str] | None:
    """segments 패턴과 실제 경로 세그먼트 매칭. 실패 None, 성공 시 캡처 params."""
    if len(pattern) != len(actual):
        return None
    params: dict[str, str] = {}
    for p, a in zip(pattern, actual):
        if p.startswith(":"):
            params[p[1:]] = urllib.parse.unquote(a)
        elif p != a:
            return None
    return params


def _normalize_query(event: dict[str, Any]) -> dict[str, str]:
    query = event.get("queryStringParameters") or {}
    return {k: v for k, v in query.items() if isinstance(v, str)}


class Router:
    def __init__(self) -> None:
        self._routes: list[_Route] = []

    def add(self, method: str, pattern: str, handler: RouteHandler) -> "Router":
        self._routes.append(_Route(method, _split_path(pattern), handler))
        return self

    def get(self, pattern: str, handler: RouteHandler) -> "Router":
        return self.add("GET", pattern, handler)

    def post(self, pattern: str, handler: RouteHandler) -> "Router":
        return self.add("POST", pattern, handler)

    def patch(self, pattern: str, handler: RouteHandler) -> "Router":
        return self.add("PATCH", pattern, handler)

    def put(self, pattern: str, handler: RouteHandler) -> "Router":
        return self.add("PUT", pattern, handler)

    def delete(self, pattern: str, handler: RouteHandler) -> "Router":
        return self.add("DELETE", pattern, handler)

    def dispatch(self, event: dict[str, Any], identity: Identity) -> ProxyResult:
        """매칭 후 핸들러 실행. 경로만 맞고 메서드가 다르면 405, 경로 자체가 없으면 404."""
        method = (event.get("httpMethod") or "GET").upper()
        path_segments = _split_path(extract_path(event))
        path_matched_but_not_method = False

        for route in self._routes:
            params = _match_segments(route.segments, path_segments)
            if params is None:
                continue
            if route.method != method:
                path_matched_but_not_method = True
                continue
            query = _normalize_query(event)
            return route.handler(
                RouteContext(event=event, identity=identity, params=params, query=query)
            )

        if path_matched_but_not_method:
            raise errors.method_not_allowed()
        raise errors.route_not_found()
