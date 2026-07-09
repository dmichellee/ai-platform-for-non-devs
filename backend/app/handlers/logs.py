"""로그 핸들러 (api-contract.md 로그). GET /apps/{id}/logs — 소유자/관리자만."""

from __future__ import annotations

from ..http.response import ProxyResult, ok
from ..http.router import RouteContext
from ..integrations.logs import fetch_app_logs
from .apps import load_owned_app


def get_app_logs(ctx: RouteContext) -> ProxyResult:
    """GET /apps/{id}/logs. query: limit(기본100), nextToken, startTime(epoch ms)."""
    app = load_owned_app(ctx)
    limit = _to_int(ctx.query.get("limit"), 100)
    start_time = _to_int(ctx.query.get("startTime"), None)
    result = fetch_app_logs(
        app["appId"],
        limit=limit,
        next_token=ctx.query.get("nextToken"),
        start_time=start_time,
    )
    return ok(result)


def _to_int(raw: str | None, default: int | None) -> int | None:
    if raw is None:
        return default
    try:
        return int(raw)
    except (ValueError, TypeError):
        return default
