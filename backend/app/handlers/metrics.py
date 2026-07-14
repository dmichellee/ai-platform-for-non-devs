"""메트릭 핸들러 (DESIGN 6 앱 상세 "모니터링" 탭). GET /apps/{id}/metrics — 소유자/관리자만.

접속량(requests)·CPU·메모리 시계열을 CloudWatch GetMetricData 배치 1회로 반환한다.
로그 프록시(GET /apps/{id}/logs)는 유지 — 배포 이력 쪽에서 계속 쓴다.
"""

from __future__ import annotations

from ..http.errors import errors
from ..http.response import ProxyResult, ok
from ..http.router import RouteContext
from ..integrations.metrics import DEFAULT_RANGE, VALID_RANGES, get_app_metrics
from .apps import load_owned_app


def get_app_metrics_handler(ctx: RouteContext) -> ProxyResult:
    """GET /apps/{id}/metrics?range=1h|6h|24h|7d (기본 6h). 소유자/admin 만."""
    app = load_owned_app(ctx)
    range_key = _resolve_range(ctx.query.get("range"))
    result = get_app_metrics(app, range_key)
    return ok(result)


def _resolve_range(raw: str | None) -> str:
    """range 검증: 미지정이면 기본(6h). 지정됐는데 미지원 값이면 400 VALIDATION_ERROR."""
    if raw is None or raw == "":
        return DEFAULT_RANGE
    if raw not in VALID_RANGES:
        raise errors.validation(
            f"조회 기간이 올바르지 않아요. ({', '.join(VALID_RANGES)} 중 하나)"
        )
    return raw
