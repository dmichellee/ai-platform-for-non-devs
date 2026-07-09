"""복원 Lambda — ECS Task State Change EventBridge 트리거 (DESIGN.md 3.5, D-M5-03).

앱 태스크가 RUNNING+healthy 가 되면: appId 파싱 → 앱 TG ARN(이름 조회) → 리스너 규칙 forward
대상을 앱 TG 로 복원(멱등) → runtimeState=RUNNING. 공유 규칙 1개(앱별 아님, stack-outputs §I).
"""

from __future__ import annotations

from typing import Any

from ..data.apps import get_app, set_runtime_state
from ..integrations.ssm import listener_arn_for_scheme, network_param
from . import stage
from .listener_rule import transition_listener_rule
from .target_group import find_app_target_group_arn


def app_id_from_ecs_event(event: dict[str, Any], stage_value: str) -> str | None:
    """ECS 이벤트의 clusterArn/group 에서 appId 파싱(`apphub-{stage}-app-{appId}`)."""
    detail = event.get("detail")
    if not detail:
        return None
    marker = f"apphub-{stage_value}-app-"
    cluster_arn = detail.get("clusterArn") or ""
    from_cluster = cluster_arn.split("/")[-1] if cluster_arn else ""
    if from_cluster.startswith(marker):
        return from_cluster[len(marker) :]
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
    listener_arn = listener_arn_for_scheme(st, app["scheme"])
    waker_tg_arn = network_param(st, "waker-tg-arn")
    domain = network_param(st, "apps-domain")
    host = f"{app['subdomain']}.{domain}"
    res = transition_listener_rule(
        listener_arn=listener_arn,
        host=host,
        app_target_group_arn=app_tg_arn,
        waker_target_group_arn=waker_tg_arn,
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
