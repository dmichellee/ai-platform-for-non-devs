"""복원 Lambda — ECS Task State Change EventBridge 트리거 (D-M5-03).

앱 태스크가 RUNNING+healthy 가 되면: appId 파싱(detail.group) → 앱 TG ARN(이름 조회) → 리스너
규칙 forward 대상을 앱 TG 로 복원(멱등) → runtimeState=RUNNING. 공유 규칙 1개(앱별 아님, §I).
공유 클러스터(D18)에서 detail.clusterArn 은 appId 를 담지 않아 detail.group 만 파싱 소스다.
"""

from __future__ import annotations

from typing import Any

from ..data.apps import get_app, set_runtime_state
from ..integrations.ssm import network_param
from . import stage
from .listener_rule import app_alb_routing, transition_listener_rule
from .target_group import find_app_target_group_arn


def app_id_from_ecs_event(event: dict[str, Any], stage_value: str) -> str | None:
    """ECS 이벤트의 detail.group 에서 appId 파싱(`service:apphub-{stage}-app-{appId}`).

    공유 클러스터(D18)에서 detail.clusterArn 은 이제 `apphub-{stage}-cluster`(모든 앱
    공통)이라 appId 를 담지 않는다. detail.group 은 클러스터와 무관하게 서비스명을 유지하므로
    유일한 파싱 소스다(`service:` 접두어 제거 후 서비스명 규약에서 appId 추출).
    """
    detail = event.get("detail")
    if not detail:
        return None
    marker = f"apphub-{stage_value}-app-"
    group = detail.get("group") or ""
    svc = group[len("service:") :] if group.startswith("service:") else group
    if svc.startswith(marker):
        return svc[len(marker) :]
    return None


def is_running_and_healthy(event: dict[str, Any]) -> bool:
    """태스크가 RUNNING 이고 healthy(HEALTHY/UNKNOWN/미지정, 또는 컨테이너 중 하나 HEALTHY)인지."""
    detail = event.get("detail")
    if not detail:
        return False
    if detail.get("lastStatus") != "RUNNING":
        return False
    health = detail.get("healthStatus")
    if health == "HEALTHY":
        return True
    if health == "UNKNOWN" or health is None:
        return True
    return any(c.get("healthStatus") == "HEALTHY" for c in detail.get("containers") or [])


def handle_task_state_change(event: dict[str, Any]) -> dict[str, Any]:
    """RUNNING+healthy 판정 → 규칙 forward 를 앱 TG 로 복원 → runtimeState=RUNNING."""
    st = stage()
    if not is_running_and_healthy(event):
        return {"reason": "not-running-healthy"}
    app_id = app_id_from_ecs_event(event, st)
    if not app_id:
        return {"reason": "no-appId"}
    app = get_app(app_id)
    if not app:
        return {"appId": app_id, "reason": "app-record-missing"}
    if app.get("status") != "ACTIVE":
        return {"appId": app_id, "reason": f"status-{app.get('status')}"}
    app_tg_arn = find_app_target_group_arn(st, app_id)
    if not app_tg_arn:
        return {"appId": app_id, "reason": "app-tg-not-found"}
    # App.albIndex 기준 ALB(D20) — listener·waker TG 는 `/network/alb/{slug}/{n}/*`.
    routing = app_alb_routing(st, app, need_waker=False)
    domain = network_param(st, "apps-domain")
    host = f"{app['subdomain']}.{domain}"
    res = transition_listener_rule(
        listener_arn=routing["listenerArn"],
        host=host,
        app_target_group_arn=app_tg_arn,
        waker_target_group_arn=routing["wakerTgArn"],
        to="app",
    )
    if not res.get("ruleNotFound") and app.get("runtimeState") != "RUNNING":
        try:
            set_runtime_state(app_id, "RUNNING")
        except Exception:  # noqa: BLE001
            pass
    return {"appId": app_id, "restored": res.get("changed", False)}


def handle(event: dict[str, Any], _context: Any = None) -> dict[str, Any]:
    try:
        result = handle_task_state_change(event)
        print("[wake-restore]", result)
        return result
    except Exception as err:  # noqa: BLE001 - 로그 후 재전파(EventBridge 재시도에 맡김)
        print("[wake-restore] failed:", str(err))
        raise
