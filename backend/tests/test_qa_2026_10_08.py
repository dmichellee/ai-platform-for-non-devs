"""QA 2026-10-06 결함 수정 회귀(2026-10-08 승인) — M3 IN_USE / N1 FRONTEND_MODE / N2 deploy-notify 실패 재수면 / N5 sweep."""

from __future__ import annotations

from typing import Any

import pytest
from app.data.deployments import put_deployment
from app.handler import handler
from app.integrations import clients as integ_clients
from app.orchestration import deploy_notify as dn
from app.wake import sleep

from .conftest import (
    StubClient,
    make_event,
    parse_result,
    seed_app,
    seed_perm,
    seed_preset,
    seed_settings,
)

STAGE = "test"
ADMIN = {"user_id": "admin1", "groups": ["admin"]}


# ══════════════════════════════════════════════════════════════════════════════
# M3 — 사용 중 프리셋·권한 템플릿 삭제 거부
# ══════════════════════════════════════════════════════════════════════════════


def _delete(path: str) -> dict[str, Any]:
    return parse_result(handler(make_event("DELETE", path, **ADMIN)))


def test_m3_preset_in_use_rejected_409(ddb_table, stub_clients) -> None:
    seed_preset(ddb_table, "small")
    seed_app(ddb_table, "app00001", "u1", status="ACTIVE", presetId="small")
    seed_app(ddb_table, "app00002", "u2", status="FAILED", presetId="small")
    out = _delete("/admin/presets/small")
    assert out["status"] == 409
    assert out["error"]["code"] == "IN_USE"
    assert "2개" in out["error"]["message"]
    # 삭제되지 않음.
    assert "Item" in ddb_table.get_item(Key={"PK": "CONFIG", "SK": "PRESET#small"})


def test_m3_preset_unused_deleted_204(ddb_table, stub_clients) -> None:
    seed_preset(ddb_table, "small")
    seed_preset(ddb_table, "big")
    seed_app(ddb_table, "app00001", "u1", status="ACTIVE", presetId="big")
    out = _delete("/admin/presets/small")
    assert out["status"] == 204
    assert "Item" not in ddb_table.get_item(Key={"PK": "CONFIG", "SK": "PRESET#small"})


def test_m3_preset_only_deleting_apps_allows_delete(ddb_table, stub_clients) -> None:
    seed_preset(ddb_table, "small")
    seed_app(ddb_table, "app00001", "u1", status="DELETING", presetId="small")
    assert _delete("/admin/presets/small")["status"] == 204


def test_m3_perm_in_use_rejected_409(ddb_table, stub_clients) -> None:
    seed_perm(ddb_table, "basic")
    seed_app(ddb_table, "app00001", "u1", status="CREATING", permissionTemplateId="basic")
    out = _delete("/admin/permission-templates/basic")
    assert out["status"] == 409
    assert out["error"]["code"] == "IN_USE"
    assert "1개" in out["error"]["message"]
    assert "Item" in ddb_table.get_item(Key={"PK": "CONFIG", "SK": "PERM#basic"})


def test_m3_perm_unused_or_deleting_only_deleted_204(ddb_table, stub_clients) -> None:
    seed_perm(ddb_table, "basic")
    seed_app(ddb_table, "app00001", "u1", status="DELETING", permissionTemplateId="basic")
    seed_app(ddb_table, "app00002", "u1", status="ACTIVE", permissionTemplateId="other")
    assert _delete("/admin/permission-templates/basic")["status"] == 204
    assert "Item" not in ddb_table.get_item(Key={"PK": "CONFIG", "SK": "PERM#basic"})


def test_m3_user_still_forbidden(ddb_table, stub_clients) -> None:
    seed_preset(ddb_table, "small")
    out = parse_result(handler(make_event("DELETE", "/admin/presets/small", user_id="u1", groups=["user"])))
    assert out["status"] == 403


# ══════════════════════════════════════════════════════════════════════════════
# N1 — FRONTEND_MODE=private 에서 로그인 보호 거부
# ══════════════════════════════════════════════════════════════════════════════


def _create_body(**overrides: Any) -> dict[str, Any]:
    body = {
        "name": "앱",
        "subdomain": "my-app",
        "provider": "codecommit",
        "repoUrl": "https://git-codecommit.ap-northeast-2.amazonaws.com/v1/repos/r",
        "presetId": "small",
        "permissionTemplateId": "basic",
        "scheme": "internet-facing",
        "sleepMode": "always-on",
    }
    body.update(overrides)
    return body


def _create(body: dict[str, Any]) -> dict[str, Any]:
    return parse_result(handler(make_event("POST", "/apps", user_id="u1", groups=["user"], body=body)))


@pytest.fixture
def create_ready(ddb_table, stub_clients):
    seed_settings(ddb_table)
    seed_preset(ddb_table, "small")
    seed_perm(ddb_table, "basic")
    return ddb_table


def test_n1_private_rejects_cognito_protect_true_on_create(create_ready, monkeypatch) -> None:
    monkeypatch.setenv("FRONTEND_MODE", "private")
    out = _create(_create_body(cognitoProtect=True))
    assert out["status"] == 400
    assert out["error"]["code"] == "COGNITO_PROTECT_UNAVAILABLE"
    # 아무것도 만들어지지 않음.
    assert create_ready.scan(FilterExpression="entityType = :t", ExpressionAttributeValues={":t": "App"})[
        "Items"
    ] == []


def test_n1_private_default_off_even_for_internet_facing(create_ready, monkeypatch) -> None:
    monkeypatch.setenv("FRONTEND_MODE", "private")
    out = _create(_create_body())
    assert out["status"] == 201
    assert out["data"]["cognitoProtect"] is False


def test_n1_private_explicit_false_ok(create_ready, monkeypatch) -> None:
    monkeypatch.setenv("FRONTEND_MODE", "private")
    out = _create(_create_body(cognitoProtect=False))
    assert out["status"] == 201
    assert out["data"]["cognitoProtect"] is False


def test_n1_public_default_on_for_internet_facing(create_ready, monkeypatch) -> None:
    monkeypatch.setenv("FRONTEND_MODE", "public")
    out = _create(_create_body())
    assert out["status"] == 201
    assert out["data"]["cognitoProtect"] is True


def test_n1_mode_unset_behaves_public(create_ready, monkeypatch) -> None:
    monkeypatch.delenv("FRONTEND_MODE", raising=False)
    out = _create(_create_body(subdomain="int-app", scheme="internal"))
    assert out["status"] == 201
    assert out["data"]["cognitoProtect"] is False  # internal 기본 끔(기존 규칙)
    out2 = _create(_create_body(subdomain="pub-app"))
    assert out2["data"]["cognitoProtect"] is True


def _patch(app_id: str, body: dict[str, Any]) -> dict[str, Any]:
    return parse_result(
        handler(make_event("PATCH", f"/apps/{app_id}", user_id="u1", groups=["user"], body=body))
    )


def test_n1_private_rejects_patch_cognito_protect_true(ddb_table, stub_clients, monkeypatch) -> None:
    monkeypatch.setenv("FRONTEND_MODE", "private")
    seed_app(ddb_table, "app00001", "u1", status="ACTIVE", cognitoProtect=False)
    out = _patch("app00001", {"cognitoProtect": True})
    assert out["status"] == 400
    assert out["error"]["code"] == "COGNITO_PROTECT_UNAVAILABLE"
    item = ddb_table.get_item(Key={"PK": "APP#app00001", "SK": "META"})["Item"]
    assert item["cognitoProtect"] is False


def test_n1_private_allows_patch_cognito_protect_false(ddb_table, stub_clients, monkeypatch) -> None:
    monkeypatch.setenv("FRONTEND_MODE", "private")
    seed_app(ddb_table, "app00001", "u1", status="ACTIVE", cognitoProtect=True)
    out = _patch("app00001", {"cognitoProtect": False})
    assert out["status"] == 200
    assert out["data"]["cognitoProtect"] is False


def test_n1_public_allows_patch_cognito_protect_true(ddb_table, stub_clients, monkeypatch) -> None:
    monkeypatch.setenv("FRONTEND_MODE", "public")
    seed_app(ddb_table, "app00001", "u1", status="ACTIVE", cognitoProtect=False)
    out = _patch("app00001", {"cognitoProtect": True})
    assert out["status"] == 200
    assert out["data"]["cognitoProtect"] is True


# ══════════════════════════════════════════════════════════════════════════════
# N2 — deploy-notify: 배포 실패에도 재수면(첫 배포 제외)
# ══════════════════════════════════════════════════════════════════════════════

APP = "app00001"
EXEC = "exec-n2"


@pytest.fixture
def resleep_calls(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    monkeypatch.setenv("STAGE", STAGE)
    calls: list[str] = []

    def _fake(app_id: str) -> dict[str, Any]:
        calls.append(app_id)
        return {"appId": app_id, "fake": True}

    monkeypatch.setattr(dn, "_resleep_if_sleeping", _fake)
    return calls


def _pipeline_failed() -> dict[str, Any]:
    return {
        "detail-type": "CodePipeline Pipeline Execution State Change",
        "detail": {"pipeline": f"apphub-{STAGE}-app-{APP}", "state": "FAILED", "execution-id": EXEC},
    }


def _deploy_stage_failed(p2_clients) -> None:
    p2_clients["codepipeline"].set_response(
        "list_action_executions",
        {"actionExecutionDetails": [{"stageName": "Deploy", "status": "Failed"}]},
    )


def test_n2_redeploy_pipeline_failed_resleeps(ddb_table, p2_clients, resleep_calls) -> None:
    seed_app(ddb_table, APP, "u1", status="ACTIVE", runtimeState="SLEEPING")
    put_deployment(app_id=APP, trigger="auto", pipeline_execution_id=EXEC)
    _deploy_stage_failed(p2_clients)
    res = dn.handle_event(_pipeline_failed())
    assert res["status"] == "FAILED"
    assert res["failureCategory"] == "DEPLOY_FAILED"
    assert resleep_calls == [APP]
    assert res["afterFailure"] == {"sleep": {"appId": APP, "fake": True}}


def test_n2_reverse_order_redeploy_failed_resleeps(ddb_table, p2_clients, resleep_calls) -> None:
    """매칭 레코드 없이 FAILED 가 먼저 와도(역순) 재수면은 동일."""
    seed_app(ddb_table, APP, "u1", status="ACTIVE", runtimeState="SLEEPING")
    _deploy_stage_failed(p2_clients)
    res = dn.handle_event(_pipeline_failed())
    assert res["created"] is True
    assert resleep_calls == [APP]


def test_n2_first_deploy_failed_does_not_resleep(ddb_table, p2_clients, resleep_calls) -> None:
    seed_app(ddb_table, APP, "u1", status="CREATING", runtimeState="SLEEPING")
    put_deployment(app_id=APP, trigger="auto", pipeline_execution_id=EXEC)
    _deploy_stage_failed(p2_clients)
    res = dn.handle_event(_pipeline_failed())
    assert res["appStatus"] == "FAILED"
    assert resleep_calls == []
    assert "afterFailure" not in res


def test_n2_resleep_error_swallowed(ddb_table, p2_clients, monkeypatch) -> None:
    monkeypatch.setenv("STAGE", STAGE)

    def _boom(app_id: str) -> dict[str, Any]:
        raise RuntimeError("elb down")

    monkeypatch.setattr(dn, "_resleep_if_sleeping", _boom)
    seed_app(ddb_table, APP, "u1", status="ACTIVE", runtimeState="SLEEPING")
    put_deployment(app_id=APP, trigger="auto", pipeline_execution_id=EXEC)
    _deploy_stage_failed(p2_clients)
    res = dn.handle_event(_pipeline_failed())
    assert res["status"] == "FAILED"  # 배포 기록은 끝남
    assert res["afterFailure"] == {"sleep": {"reason": "error"}}


def test_n2_succeeded_path_unchanged(ddb_table, p2_clients, resleep_calls) -> None:
    seed_app(ddb_table, APP, "u1", status="ACTIVE", runtimeState="SLEEPING")
    put_deployment(app_id=APP, trigger="auto", pipeline_execution_id=EXEC)
    res = dn.handle_event(
        {
            "detail-type": "CodePipeline Pipeline Execution State Change",
            "detail": {"pipeline": f"apphub-{STAGE}-app-{APP}", "state": "SUCCEEDED", "execution-id": EXEC},
        }
    )
    assert res["status"] == "SUCCEEDED"
    assert "afterSuccess" in res and "afterFailure" not in res
    assert resleep_calls == [APP]


# ══════════════════════════════════════════════════════════════════════════════
# N5 — sleep-transition sweep(유휴 알람 고착 보정)
# ══════════════════════════════════════════════════════════════════════════════


class CloudWatchStub(StubClient):
    """describe_alarms: 요청한 AlarmNames 중 states 에 있는 것만 반환(MaxRecords·NextToken 흉내)."""

    def __init__(self, states: dict[str, str], page_size: int = 100) -> None:
        super().__init__()
        self.states = states
        self.page_size = page_size

    def describe_alarms(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("describe_alarms", kwargs))
        names = [n for n in kwargs["AlarmNames"] if n in self.states]
        start = int(kwargs.get("NextToken") or 0)
        page = names[start : start + self.page_size]
        res: dict[str, Any] = {
            "MetricAlarms": [{"AlarmName": n, "StateValue": self.states[n]} for n in page]
        }
        if start + self.page_size < len(names):
            res["NextToken"] = str(start + self.page_size)
        return res


def _alarm(app_id: str) -> str:
    return f"apphub-{STAGE}-app-{app_id}-idle"


@pytest.fixture
def sweep_env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("STAGE", STAGE)
    slept: list[str] = []

    def _fake_sleep(app_id: str, force: bool = False, schedule_stop: bool = False) -> dict[str, Any]:
        assert force is False  # 일반 경로와 동일 판정
        assert schedule_stop is False  # 스윕·알람은 유휴 경로(가동 시간대 판정 적용, W-1)
        slept.append(app_id)
        return {"appId": app_id, "stopped": True, "ruleSwitched": True}

    monkeypatch.setattr(sleep, "sleep_app", _fake_sleep)
    return slept


def _install_cw(states: dict[str, str], page_size: int = 100) -> CloudWatchStub:
    stub = CloudWatchStub(states, page_size)
    integ_clients.set_client("cloudwatch", stub)
    return stub


def test_n5_sweep_sleeps_alarming_and_skips_others(ddb_table, sweep_env) -> None:
    seed_app(ddb_table, "alarm001", "u", status="ACTIVE", sleepMode="on-demand", runtimeState="RUNNING")
    seed_app(ddb_table, "okok0001", "u", status="ACTIVE", sleepMode="schedule", runtimeState="RUNNING")
    seed_app(ddb_table, "insuf001", "u", status="ACTIVE", sleepMode="on-demand", runtimeState="RUNNING")
    seed_app(ddb_table, "noalarm1", "u", status="ACTIVE", sleepMode="on-demand", runtimeState="RUNNING")
    seed_app(ddb_table, "always01", "u", status="ACTIVE", sleepMode="always-on", runtimeState="RUNNING")
    seed_app(ddb_table, "sleepin1", "u", status="ACTIVE", sleepMode="on-demand", runtimeState="SLEEPING")
    seed_app(ddb_table, "creatin1", "u", status="CREATING", sleepMode="on-demand", runtimeState="RUNNING")
    cw = _install_cw(
        {
            _alarm("alarm001"): "ALARM",
            _alarm("okok0001"): "OK",
            _alarm("insuf001"): "INSUFFICIENT_DATA",
            _alarm("always01"): "ALARM",
            _alarm("sleepin1"): "ALARM",
            _alarm("creatin1"): "ALARM",
        }
    )
    res = sleep.handle({"sweep": True})
    assert sweep_env == ["alarm001"]
    assert res["sweep"] is True
    assert res["checked"] == 4  # ACTIVE·RUNNING·always-on 아님
    assert res["slept"] == ["alarm001"]
    asked = set(cw.calls_for("describe_alarms")[0]["AlarmNames"])
    assert asked == {_alarm(a) for a in ("alarm001", "okok0001", "insuf001", "noalarm1")}


def test_n5_sweep_batches_100_names(ddb_table, sweep_env) -> None:
    ids = [f"bat{i:05d}" for i in range(205)]
    for app_id in ids:
        seed_app(ddb_table, app_id, "u", status="ACTIVE", sleepMode="on-demand", runtimeState="RUNNING")
    # 모두 ALARM, 페이지 크기 50 → 배치 내 NextToken 도 따라가야 함.
    cw = _install_cw({_alarm(a): "ALARM" for a in ids}, page_size=50)
    res = sleep.handle({"sweep": True})
    batches = [c["AlarmNames"] for c in cw.calls_for("describe_alarms") if "NextToken" not in c]
    assert [len(b) for b in batches] == [100, 100, 5]
    assert all(len(c["AlarmNames"]) <= 100 for c in cw.calls_for("describe_alarms"))
    assert sorted(sweep_env) == ids
    assert res["checked"] == 205 and len(res["slept"]) == 205


def test_n5_sweep_no_candidates_no_cloudwatch_call(ddb_table, sweep_env) -> None:
    seed_app(ddb_table, "always01", "u", status="ACTIVE", sleepMode="always-on", runtimeState="RUNNING")
    cw = _install_cw({})
    res = sleep.handle({"sweep": True})
    assert cw.calls_for("describe_alarms") == []
    assert res["checked"] == 0 and res["slept"] == []


def test_n5_sweep_one_failure_does_not_stop_others(ddb_table, monkeypatch) -> None:
    monkeypatch.setenv("STAGE", STAGE)
    seed_app(ddb_table, "fail0001", "u", status="ACTIVE", sleepMode="on-demand", runtimeState="RUNNING")
    seed_app(ddb_table, "good0001", "u", status="ACTIVE", sleepMode="on-demand", runtimeState="RUNNING")
    done: list[str] = []

    def _sleep(app_id: str, force: bool = False) -> dict[str, Any]:
        if app_id == "fail0001":
            raise RuntimeError("ecs throttled")
        done.append(app_id)
        return {"appId": app_id, "stopped": True, "ruleSwitched": True}

    monkeypatch.setattr(sleep, "sleep_app", _sleep)
    _install_cw({_alarm("fail0001"): "ALARM", _alarm("good0001"): "ALARM"})
    res = sleep.handle({"sweep": True})
    assert done == ["good0001"]
    assert res["failed"] == ["fail0001"]


def test_n5_non_sweep_event_uses_normal_path(ddb_table, sweep_env) -> None:
    """sweep 플래그가 없으면 기존 알람 이벤트 경로(appId 파싱)."""
    res = sleep.handle({"detail": {"alarmName": _alarm("abc12345")}})
    assert sweep_env == ["abc12345"]
    assert res["appId"] == "abc12345"
