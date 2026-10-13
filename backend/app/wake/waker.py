"""Waker — ALB Lambda 타깃 (D-M5-03).

공유 Waker TG 의 유일한 대상. 잠자는 앱으로 요청이 오면:
  Host → subdomain → 예약 아이템(appId) → App → preset.minCount → ensure_running(멱등)
    → runtimeState=WAKING → **항상 200 대기 페이지**(기동 실패를 사용자에게 숨김, 5초 자동 새로고침).
대기 페이지에는 이모지를 쓰지 않는다(사용자 노출 규약).
"""

from __future__ import annotations

from typing import Any

from ..data.apps import get_app, set_runtime_state
from ..data.config_repo import get_preset
from ..data.subdomains import app_id_for_subdomain
from . import apps_domain, stage
from .ecs_service import ensure_running

# 이모지 없는 대기 페이지(HTML). 5초마다 자동 새로고침 — 앱이 깨어나면 규칙이 앱으로 되돌아간다.
_WAITING_PAGE = "".join(
    [
        '<!doctype html><html lang="ko"><head><meta charset="utf-8">',
        '<meta http-equiv="refresh" content="5">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        "<title>앱을 준비하는 중이에요</title>",
        "<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;",
        "text-align:center;padding-top:18vh;color:#1f2937;background:#f9fafb}",
        ".spinner{width:40px;height:40px;margin:0 auto 24px;border:4px solid #e5e7eb;",
        "border-top-color:#2563eb;border-radius:50%;animation:spin 1s linear infinite}",
        "@keyframes spin{to{transform:rotate(360deg)}}h1{font-size:20px}p{color:#6b7280}</style>",
        "</head><body>",
        '<div class="spinner"></div>',
        "<h1>앱을 준비하는 중이에요</h1>",
        "<p>잠시만 기다려주세요. 화면이 자동으로 새로고침됩니다.</p>",
        "<p>보통 30초에서 1분 정도 걸려요.</p>",
        "</body></html>",
    ]
)


def subdomain_from_host(host: str | None, domain: str | None) -> str | None:
    """Host 헤더에서 subdomain 추출. `{sub}.{appsDomain}` 이면 sub, 아니면 첫 라벨."""
    if not host:
        return None
    bare = host.split(":")[0].strip().lower()
    if not bare:
        return None
    if domain and bare.endswith(f".{domain.lower()}"):
        return bare[: len(bare) - len(domain) - 1]
    first_label = bare.split(".")[0]
    return first_label or None


def extract_host(event: dict[str, Any]) -> str | None:
    """ALB Lambda 통합 이벤트에서 Host 헤더 추출(headers 우선, multiValueHeaders 폴백)."""
    headers = event.get("headers") or {}
    host = headers.get("host") or headers.get("Host")
    if host:
        return host
    mv = event.get("multiValueHeaders") or {}
    mv_host = mv.get("host") or mv.get("Host")
    if mv_host:
        return mv_host[0]
    return None


def waiting_page() -> dict[str, Any]:
    """ALB Lambda 통합 응답 스키마의 200 대기 페이지."""
    return {
        "statusCode": 200,
        "statusDescription": "200 OK",
        "isBase64Encoded": False,
        "headers": {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store, must-revalidate",
        },
        "body": _WAITING_PAGE,
    }


def wake_by_host(host: str | None) -> dict[str, Any]:
    """Host 로 앱을 식별해 깨운다(멱등). runtimeState=SLEEPING 이면 WAKING 으로."""
    st = stage()
    subdomain = subdomain_from_host(host, apps_domain())
    if not subdomain:
        return {"reason": "no-subdomain"}
    app_id = app_id_for_subdomain(subdomain)
    if not app_id:
        return {"reason": "no-app-for-subdomain"}
    app = get_app(app_id)
    if not app:
        return {"appId": app_id, "reason": "app-record-missing"}
    if app.get("status") != "ACTIVE":
        return {"appId": app_id, "reason": f"status-{app.get('status')}"}
    preset = get_preset(app["presetId"])
    minimum = preset["minCount"] if preset and preset.get("minCount", 0) > 0 else 1
    res = ensure_running(st, app_id, minimum)
    if res.get("serviceNotFound"):
        return {"appId": app_id, "started": False, "reason": "service-not-found"}
    if app.get("runtimeState") == "SLEEPING":
        try:
            set_runtime_state(app_id, "WAKING")
        except Exception:  # noqa: BLE001 - runtimeState 갱신 실패는 사용자 응답을 막지 않음
            pass
    return {"appId": app_id, "started": res.get("changed", False)}


def handle(event: dict[str, Any], _context: Any = None) -> dict[str, Any]:
    """항상 200 대기 페이지를 반환한다. 깨우기 실패는 로그만 남기고 사용자에게 숨긴다."""
    try:
        host = extract_host(event)
        result = wake_by_host(host)
        print("[waker]", {"host": host, **result})
    except Exception as err:  # noqa: BLE001 - 사용자에게는 항상 대기 페이지
        print("[waker] wake failed:", str(err))
    return waiting_page()
