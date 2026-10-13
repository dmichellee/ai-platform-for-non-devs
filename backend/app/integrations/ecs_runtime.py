"""ECS 런타임 조회 — 앱 서비스의 활성 태스크 정의 (D8 지연 정리 / 재배포 커밋 폴백).

- 시크릿 지연 정리: 서비스의 **모든 활성 배포(PRIMARY/ACTIVE)** 태스크 정의가 `valueFrom: <arn>:KEY::`
  로 참조하는 KEY 는 JSON 에서 지우면 안 된다(재시작·확장·깨우기 시 기동 실패 — QA H4).
- 재배포 커밋 폴백: 마지막 SUCCEEDED 배포의 commitSha 가 없으면 PRIMARY 태스크 정의의 앱 이미지 태그.

읽기 전용(DescribeServices / DescribeTaskDefinition). 태스크 정의의 secrets 는 ARN 참조만 담고 값은 없다.
클러스터/서비스 규약은 wake 모듈(D18)과 동일.
"""

from __future__ import annotations

from typing import Any

from .clients import client


def describe_app_task_definitions(cluster: str, service: str) -> dict[str, Any]:
    """서비스의 활성 태스크 정의들을 조회한다.

    반환: {"found": bool, "primary": taskDef|None, "taskDefinitions": [taskDef, ...]}.
    서비스 미존재/INACTIVE 면 found=False. AWS 호출 실패는 예외 전파(호출부가 안전 측으로 처리).
    """
    ecs = client("ecs")
    res = ecs.describe_services(cluster=cluster, services=[service])
    svc = next(
        (
            s
            for s in res.get("services") or []
            if s.get("serviceName") == service and s.get("status") != "INACTIVE"
        ),
        None,
    )
    if svc is None:
        return {"found": False, "primary": None, "taskDefinitions": []}
    primary_arn = svc.get("taskDefinition")
    arns: list[str] = []
    for arn in [primary_arn, *[d.get("taskDefinition") for d in svc.get("deployments") or []]]:
        if arn and arn not in arns:
            arns.append(arn)
    defs: dict[str, dict[str, Any]] = {}
    for arn in arns:
        td = ecs.describe_task_definition(taskDefinition=arn).get("taskDefinition") or {}
        defs[arn] = td
    return {
        "found": True,
        "primary": defs.get(primary_arn) if primary_arn else None,
        "taskDefinitions": list(defs.values()),
    }


def referenced_secret_keys(task_definitions: list[dict[str, Any]], secret_arn: str) -> set[str]:
    """태스크 정의들의 secrets[].valueFrom 중 `<secret_arn>:KEY::` 형식의 KEY 집합."""
    keys: set[str] = set()
    prefix = f"{secret_arn}:"
    for td in task_definitions:
        for container in td.get("containerDefinitions") or []:
            for sec in container.get("secrets") or []:
                value_from = str(sec.get("valueFrom") or "")
                if not value_from.startswith(prefix):
                    continue
                key = value_from[len(prefix) :].split(":", 1)[0]
                if key:
                    keys.add(key)
    return keys


def image_tag_for_repo(task_definition: dict[str, Any] | None, repo_name: str) -> str | None:
    """태스크 정의에서 `.../{repo_name}:{tag}` 이미지의 태그. 다이제스트(@sha256)/미일치는 None."""
    if not task_definition:
        return None
    for container in task_definition.get("containerDefinitions") or []:
        image = str(container.get("image") or "")
        if "@" in image:
            continue
        path, sep, tag = image.rpartition(":")
        if not sep or "/" in tag:
            continue
        if path.rsplit("/", 1)[-1] == repo_name and tag:
            return tag
    return None
