"""ECS 서비스 desiredCount 멱등 조정 (desiredCount 는 런타임이 바꾸는 값).

CloudFormation 드리프트 방지: app-runtime 스택은 desiredCount 를 관리하지 않고,
Waker(깨우기)/잠자기 Lambda 가 UpdateService 로만 조정한다. 이미 목표면 UpdateService 미호출(멱등).

클러스터/서비스 규약(D18): stage 당 공유 클러스터 1개(`apphub-{stage}-cluster`) 위에
앱 서비스(`apphub-{stage}-app-{appId}`)만 만든다. 클러스터명은 CLUSTER_NAME env(network 스택
주입)에서 읽고, 서비스명은 이름 규약으로 파생한다 — 둘은 더 이상 동일하지 않다.
"""

from __future__ import annotations

from typing import Any

from ..integrations.clients import client
from . import cluster_name


def app_service_name(stage: str, app_id: str) -> str:
    return f"apphub-{stage}-app-{app_id}"


def describe_service(cluster: str, service: str) -> dict[str, Any]:
    """서비스 현재 desiredCount 조회. INACTIVE/미존재면 found=False."""
    res = client("ecs").describe_services(cluster=cluster, services=[service])
    for svc in res.get("services") or []:
        if svc.get("serviceName") == service and svc.get("status") != "INACTIVE":
            return {"desiredCount": svc.get("desiredCount", 0), "found": True}
    return {"desiredCount": 0, "found": False}


def ensure_running(stage: str, app_id: str, minimum: int) -> dict[str, Any]:
    """desiredCount 를 최소 minimum 으로 끌어올린다(이미 크거나 같으면 no-op)."""
    cluster = cluster_name()
    service = app_service_name(stage, app_id)
    info = describe_service(cluster, service)
    if not info["found"]:
        return {"changed": False, "serviceNotFound": True}
    if info["desiredCount"] >= minimum:
        return {"changed": False, "previous": info["desiredCount"]}
    client("ecs").update_service(cluster=cluster, service=service, desiredCount=minimum)
    return {"changed": True, "previous": info["desiredCount"]}


def ensure_stopped(stage: str, app_id: str) -> dict[str, Any]:
    """desiredCount 를 0 으로 내린다(이미 0이면 no-op)."""
    cluster = cluster_name()
    service = app_service_name(stage, app_id)
    info = describe_service(cluster, service)
    if not info["found"]:
        return {"changed": False, "serviceNotFound": True}
    if info["desiredCount"] == 0:
        return {"changed": False, "previous": info["desiredCount"]}
    client("ecs").update_service(cluster=cluster, service=service, desiredCount=0)
    return {"changed": True, "previous": info["desiredCount"]}
