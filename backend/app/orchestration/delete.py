"""DeleteApp task Lambda 디스패처 (DESIGN.md 3.6, D-M5-05).

step 흐름(ASL 이 Wait/Choice/Retry/Catch 로 감싼다):
  delete-runtime(DeleteStack) → poll-runtime(Choice DELETE_COMPLETE + Wait)
    → delete-pipeline → poll-pipeline → cleanup(시크릿 삭제, ALB ruleCount 감소,
      서브도메인 예약 해제, App 정리) → finalize.
Catch(States.ALL) → finalize(outcome=failure) → Fail. 실패 시 DELETING→FAILED(재시도 가능).

중복 실행 방지: SFN execution name(=del-{appId})이 1차, 조건부 전이가 2차 방어선.
"""

from __future__ import annotations

from typing import Any, Callable

from ..data.alb_registry import decrement_alb_rule_count
from ..data.apps import delete_app_record, get_app, set_failure, transition_status
from ..data.subdomains import release_subdomain
from ..integrations.cloudformation import (
    delete_stack,
    get_stack_delete_state,
    pipeline_stack_name,
    runtime_stack_name,
)
from ..integrations.secrets import app_secret_name, delete_secret
from . import stage
from .failure import build_failure


def delete_runtime(e: dict[str, Any]) -> dict[str, Any]:
    """runtime 스택 삭제 시작."""
    app_id = e["appId"]
    delete_stack(runtime_stack_name(stage(), app_id))
    return {"step": "delete-runtime", "appId": app_id}


def poll_runtime(e: dict[str, Any]) -> dict[str, Any]:
    """runtime 스택 삭제 상태 조회. DELETE_FAILED 면 예외(ASL Catch → finalize failure)."""
    app_id = e["appId"]
    name = runtime_stack_name(stage(), app_id)
    state = get_stack_delete_state(name)
    if state == "DELETE_FAILED":
        raise RuntimeError(f"runtime 스택 삭제 실패: {name}")
    return {"step": "poll-runtime", "appId": app_id, "stackDeleteState": state}


def delete_pipeline(e: dict[str, Any]) -> dict[str, Any]:
    """pipeline 스택 삭제 시작."""
    app_id = e["appId"]
    delete_stack(pipeline_stack_name(stage(), app_id))
    return {"step": "delete-pipeline", "appId": app_id}


def poll_pipeline(e: dict[str, Any]) -> dict[str, Any]:
    """pipeline 스택 삭제 상태 조회. DELETE_FAILED 면 예외."""
    app_id = e["appId"]
    name = pipeline_stack_name(stage(), app_id)
    state = get_stack_delete_state(name)
    if state == "DELETE_FAILED":
        raise RuntimeError(f"pipeline 스택 삭제 실패: {name}")
    return {"step": "poll-pipeline", "appId": app_id, "stackDeleteState": state}


def cleanup(e: dict[str, Any]) -> dict[str, Any]:
    """시크릿 삭제 → ALB ruleCount 감소 → 서브도메인 예약 해제 → App 레코드 정리(멱등).

    시크릿은 앱당 1개(D8). App.secretArn 이 있으면 그 ARN, 없으면 이름 규약
    `apphub/{stage}/app/{appId}` 로 ForceDelete 한다(생성 도중 실패로 DDB 에 ARN 이 안 남은 고아까지
    정리). 없는 시크릿은 ResourceNotFound → 멱등 통과.
    """
    app_id = e["appId"]
    app = get_app(app_id)
    if not app:
        return {"step": "cleanup", "appId": app_id, "cleaned": True}
    delete_secret(app.get("secretArn") or app_secret_name(stage(), app_id))
    alb_arn = app.get("albArn") or e.get("albArn")
    if alb_arn:
        decrement_alb_rule_count(alb_arn)
    release_subdomain(app["subdomain"])
    delete_app_record(app_id)
    return {"step": "cleanup", "appId": app_id, "cleaned": True}


def finalize(e: dict[str, Any]) -> dict[str, Any]:
    """실패면 DELETING→FAILED(조건부·재시도 가능), 성공이면 DELETED(레코드는 cleanup 에서 이미 삭제).

    실패 시(레코드가 남아 있으면) failureReason/failureDetail 을 남겨 앱 상세에서 사유를 볼 수 있게 한다.
    cleanup 이 이미 레코드를 지운 뒤 실패한 경우 set_failure/transition 모두 조건 실패를 삼킨다(멱등).
    """
    app_id = e["appId"]
    if e.get("outcome") == "failure":
        failure = build_failure(e, flow="delete")
        set_failure(app_id, failure["failureReason"], failure["failureDetail"])
        try:
            transition_status(app_id, "FAILED", ["DELETING"])
        except Exception:  # noqa: BLE001 - 이미 다른 상태거나 레코드 없음이면 삼킴(멱등)
            pass
        return {"step": "finalize", "appId": app_id, "status": "FAILED"}
    return {"step": "finalize", "appId": app_id, "status": "DELETED"}


_DISPATCH: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "delete-runtime": delete_runtime,
    "poll-runtime": poll_runtime,
    "delete-pipeline": delete_pipeline,
    "poll-pipeline": poll_pipeline,
    "cleanup": cleanup,
    "finalize": finalize,
}


def handle(event: dict[str, Any], _context: Any = None) -> dict[str, Any]:
    """event.step 으로 단계를 분기한다(단일 task Lambda)."""
    step = event.get("step")
    fn = _DISPATCH.get(step)
    if fn is None:
        raise RuntimeError(f"알 수 없는 DeleteApp step: {step}")
    return fn(event)
