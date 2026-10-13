"""리스너 규칙 전환 — forward 대상만 교체, 멱등 (D-M4-04/D-M5-02).

잠자기/복원 시 host-header 조건으로 규칙을 찾아, 액션 배열에서 **forward 액션의 TargetGroupArn만**
교체한다. authenticate-cognito(order1) 등 다른 액션의 order/타입은 보존 → cognitoProtect 앱의
ALB 인증이 잠자기 전환 중에도 유지된다(D-M4-04: order1 authenticate-cognito → order2 forward).
이미 목표 TG면 ModifyRule 미호출(멱등).
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from ..integrations.clients import client
from ..integrations.ssm import alb_param, legacy_waker_tg_arn


def find_rule_by_host(listener_arn: str, host: str) -> dict[str, Any] | None:
    """리스너 규칙 중 host-header 조건이 host 와 매칭되는 규칙을 찾는다(페이지네이션)."""
    elbv2 = client("elbv2")
    marker: str | None = None
    while True:
        params: dict[str, Any] = {"ListenerArn": listener_arn}
        if marker:
            params["Marker"] = marker
        res = elbv2.describe_rules(**params)
        for rule in res.get("Rules") or []:
            for cond in rule.get("Conditions") or []:
                if cond.get("Field") != "host-header":
                    continue
                values = (cond.get("HostHeaderConfig") or {}).get("Values") or cond.get(
                    "Values"
                ) or []
                if host in values:
                    return rule
        marker = res.get("NextMarker")
        if not marker:
            return None


def current_forward_target(actions: list[dict[str, Any]] | None) -> str | None:
    """액션 배열에서 현재 forward 대상 TG ARN 을 추출(단일 TG forward 만 확정)."""
    for action in actions or []:
        if action.get("Type") != "forward":
            continue
        if action.get("TargetGroupArn"):
            return action["TargetGroupArn"]
        tgs = (action.get("ForwardConfig") or {}).get("TargetGroups") or []
        if len(tgs) == 1:
            return tgs[0].get("TargetGroupArn")
        return None
    return None


def replace_forward_target(
    actions: list[dict[str, Any]] | None, new_target_group_arn: str
) -> list[dict[str, Any]]:
    """forward 액션의 TargetGroupArn만 새 값으로 교체. 다른 액션(authenticate-cognito 등)은 원형 유지.

    forward 액션이 없으면 order1 forward 단일 액션으로 대체(방어적).
    """
    src = actions or []
    has_forward = any(a.get("Type") == "forward" for a in src)
    if not has_forward:
        return [{"Type": "forward", "Order": 1, "TargetGroupArn": new_target_group_arn}]
    out: list[dict[str, Any]] = []
    for action in src:
        if action.get("Type") != "forward":
            out.append(action)
            continue
        replaced: dict[str, Any] = {"Type": "forward", "TargetGroupArn": new_target_group_arn}
        if action.get("Order") is not None:
            replaced["Order"] = action["Order"]
        out.append(replaced)
    return out


def transition_listener_rule(
    listener_arn: str,
    host: str,
    app_target_group_arn: str | None,
    waker_target_group_arn: str,
    to: str,
    waker_target_group_aliases: Iterable[str | None] | None = None,
) -> dict[str, Any]:
    """host 규칙의 forward 대상을 to("app"|"waker") 목표 TG 로 전환. 멱등(이미 목표면 no-op).

    waker_target_group_aliases: waker 로 간주할 추가 TG(legacy `waker-tg-arn`, 계약 §1.2).
      to="waker" 일 때 현재 forward 가 그중 하나면 이미 잠든 것으로 보고 no-op(마이그레이션 안전).
    """
    rule = find_rule_by_host(listener_arn, host)
    rule_arn = rule.get("RuleArn") if rule else None
    if not rule or not rule_arn:
        return {"changed": False, "ruleNotFound": True}
    desired_target = waker_target_group_arn if to == "waker" else app_target_group_arn
    current = current_forward_target(rule.get("Actions"))
    if current == desired_target:
        return {"changed": False, "ruleArn": rule_arn}
    if to == "waker" and current is not None:
        aliases = {a for a in (waker_target_group_aliases or []) if a}
        if current in aliases:
            return {"changed": False, "ruleArn": rule_arn}
    new_actions = replace_forward_target(rule.get("Actions"), desired_target)
    client("elbv2").modify_rule(RuleArn=rule_arn, Actions=new_actions)
    return {"changed": True, "ruleArn": rule_arn}


def app_alb_index(app: dict[str, Any]) -> int:
    """App 의 ALB index(D20). 없으면 0(기존 앱 — network 스택의 기존 ALB)."""
    try:
        return int(app.get("albIndex") or 0)
    except (TypeError, ValueError):
        return 0


def app_alb_routing(
    stage_value: str, app: dict[str, Any], need_waker: bool = True
) -> dict[str, Any]:
    """App.albIndex + scheme 기준 listener·waker TG(계약 §7) + waker 판정용 legacy TG(§1.2).

    need_waker=False(복원 — 목표가 앱 TG)면 waker TG 를 읽지 않는다(wakerTgArn="").
    """
    scheme = app["scheme"]
    index = app_alb_index(app)
    out: dict[str, Any] = {
        "albIndex": index,
        "listenerArn": alb_param(stage_value, scheme, index, "https-listener-arn"),
        "wakerTgArn": "",
        "wakerAliases": [],
    }
    if need_waker:
        out["wakerTgArn"] = alb_param(stage_value, scheme, index, "waker-tg-arn")
        legacy = legacy_waker_tg_arn(stage_value)
        out["wakerAliases"] = [legacy] if legacy else []
    return out
