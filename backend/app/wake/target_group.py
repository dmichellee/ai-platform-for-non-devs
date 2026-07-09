"""앱 Target Group ARN 조회 (D-M5-03).

앱 TG 는 runtime 스택이 소유하며 App 레코드에 ARN 을 저장하지 않는다. 이름 규약
(`apphub-{stage}-app-{appId}`, ELB TG 이름 32자 제한으로 잘라냄)으로 DescribeTargetGroups 조회.
"""

from __future__ import annotations

from ..integrations.clients import client


def app_target_group_name(stage: str, app_id: str) -> str:
    return f"apphub-{stage}-app-{app_id}"[:32]


def find_app_target_group_arn(stage: str, app_id: str) -> str | None:
    """앱 TG ARN 조회. 없으면(미생성/삭제) None(예외 삼킴 — 호출부가 규칙 전환 스킵)."""
    name = app_target_group_name(stage, app_id)
    try:
        res = client("elbv2").describe_target_groups(Names=[name])
        tgs = res.get("TargetGroups") or []
        return tgs[0].get("TargetGroupArn") if tgs else None
    except Exception:  # noqa: BLE001 - TargetGroupNotFound 등은 None 으로 흡수
        return None
