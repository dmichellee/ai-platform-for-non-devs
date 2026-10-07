"""잠자기 Lambda — 유휴 알람 / 스케줄 EventBridge 트리거 (DESIGN.md 3.5, D-M5-03).

앱이 유휴하면: ECS desiredCount=0(멱등) + 리스너 규칙 forward 를 해당 ALB(App.albIndex)의
  Waker TG 로 전환(멱등, D20 — ALB마다 Waker TG 1개)
  + runtimeState=SLEEPING. always-on 앱은 잠자지 않는다.
appId 는 event.appId(직접 호출) 또는 알람명(`apphub-{stage}-app-{appId}-idle`)에서 파싱.
"""

from __future__ import annotations

import re
from typing import Any

from ..data.apps import get_app, set_runtime_state
from ..integrations.ssm import network_param
from . import stage
from .ecs_service import ensure_stopped
from .listener_rule import app_alb_routing, transition_listener_rule
from .target_group import find_app_target_group_arn


def app_id_from_sleep_event(event: dict[str, Any], stage_value: str) -> str | None:
    """event.appId(직접 호출) 우선, 없으면 CloudWatch 알람명에서 appId 파싱."""
    if event.get("appId"):
        return event["appId"]
    detail = event.get("detail") or {}
    alarm_data = event.get("alarmData") or {}
    alarm_name = detail.get("alarmName") or alarm_data.get("alarmName")
    if not alarm_name:
        return None
    match = re.match(rf"^apphub-{re.escape(stage_value)}-app-(.+)-idle$", alarm_name)
    return match.group(1) if match else None


def sleep_app(app_id: str, force: bool = False) -> dict[str, Any]:
    """앱을 잠재운다(멱등). ECS 정지 + 규칙 to=waker + SLEEPING.

    force=False(유휴/스케줄 트리거): always-on 앱은 잠들지 않는다(스킵).
    force=True(관리자 강제 중지, DESIGN 3.5): sleepMode 와 무관하게 재운다.
      (관리자가 명시적으로 멈추는 것이므로 always-on 도 대상.)
    """
    st = stage()
    app = get_app(app_id)
    if not app:
        return {"appId": app_id, "reason": "app-record-missing"}
    if app.get("status") != "ACTIVE":
        return {"appId": app_id, "reason": f"status-{app.get('status')}"}
    if not force and app.get("sleepMode") == "always-on":
        return {"appId": app_id, "reason": "always-on"}
    stop = ensure_stopped(st, app_id)
    app_tg_arn = find_app_target_group_arn(st, app_id)
    # App.albIndex 기준 ALB(D20) — listener·waker TG 는 `/network/alb/{slug}/{n}/*`.
    routing = app_alb_routing(st, app)
    domain = network_param(st, "apps-domain")
    host = f"{app['subdomain']}.{domain}"
    rule_switched = False
    if app_tg_arn:
        res = transition_listener_rule(
            listener_arn=routing["listenerArn"],
            host=host,
            app_target_group_arn=app_tg_arn,
            waker_target_group_arn=routing["wakerTgArn"],
            to="waker",
            waker_target_group_aliases=routing["wakerAliases"],
        )
        rule_switched = res.get("changed", False)
    if app.get("runtimeState") != "SLEEPING":
        try:
            set_runtime_state(app_id, "SLEEPING")
        except Exception:  # noqa: BLE001
            pass
    return {"appId": app_id, "stopped": stop.get("changed", False), "ruleSwitched": rule_switched}


def handle(event: dict[str, Any], _context: Any = None) -> dict[str, Any]:
    st = stage()
    app_id = app_id_from_sleep_event(event, st)
    if not app_id:
        print("[sleep-transition] appId 없음:", event)
        return {"reason": "no-appId"}
    result = sleep_app(app_id)
    print("[sleep-transition]", result)
    return result
