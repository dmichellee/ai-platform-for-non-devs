"""앱 로그 프록시 (DESIGN.md 6 앱 상세 "실시간 로그 뷰어").

앱 로그 그룹 규약: runtime 스택이 만드는 `/apphub/{stage}/app/{appId}`.
CloudWatch Logs FilterLogEvents로 최근 이벤트를 반환한다.
IAM: logs:FilterLogEvents on `/apphub/{stage}/app/*` (platform-stack이 부여, stack-outputs §M4-B).
"""

from __future__ import annotations

from typing import Any

from ..config import load_config
from .clients import client


def app_log_group_name(stage: str, app_id: str) -> str:
    return f"/apphub/{stage}/app/{app_id}"


def fetch_app_logs(
    app_id: str,
    limit: int | None = None,
    next_token: str | None = None,
    start_time: int | None = None,
) -> dict[str, Any]:
    cfg = load_config()
    params: dict[str, Any] = {
        "logGroupName": app_log_group_name(cfg.stage, app_id),
        "limit": limit if limit is not None else 100,
    }
    if next_token is not None:
        params["nextToken"] = next_token
    if start_time is not None:
        params["startTime"] = start_time

    res = client("logs").filter_log_events(**params)
    events = [
        {"timestamp": e.get("timestamp", 0), "message": e.get("message", "")}
        for e in res.get("events", [])
    ]
    result: dict[str, Any] = {"events": events}
    if res.get("nextToken") is not None:
        result["nextToken"] = res["nextToken"]
    return result
