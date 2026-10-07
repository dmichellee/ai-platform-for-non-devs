"""QA 결함 수정 2차(2026-10-08 승인) — M4 자동 배포 토글 / N4·L1 커밋 backfill / M6·A5 로그 / A6 이력 페이지."""

from __future__ import annotations

from typing import Any

import pytest
from app.data.apps import get_app
from app.data.deployments import list_deployments, put_deployment
from app.handler import handler
from app.integrations import clients as integ_clients
from app.integrations import logs as logs_mod
from app.orchestration import deploy_notify as dn
from app.orchestration import provision

from .conftest import SsmStub, StubClient, make_event, parse_result, seed_app

STAGE = "test"
APP = "app00001"
OWNER = "user-alice"
PROVISIONER = f"apphub-{STAGE}-provisioner"
PIPELINE = f"apphub-{STAGE}-app-{APP}"
EXEC = "exec-abc"


class ClientErr(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.response = {"Error": {"Code": code, "Message": code}}


@pytest.fixture
def env(ddb_table, stub_clients):
    cb = StubClient()
    cb.set_response("start_build", {"build": {"id": f"{PROVISIONER}:uuid-1"}})
    integ_clients.set_client("codebuild", cb)
    pipe = StubClient()
    integ_clients.set_client("codepipeline", pipe)
    ssm = SsmStub({f"/apphub/{STAGE}/platform/provisioner-project-name": PROVISIONER})
    integ_clients.set_client("ssm", ssm)
    return {"cb": cb, "pipe": pipe, "logs": stub_clients["logs"], "table": ddb_table}


def _get(path: str, query: dict[str, str] | None = None, user: str = OWNER) -> dict[str, Any]:
    return parse_result(handler(make_event("GET", path, user_id=user, groups=["user"], query=query)))


def _patch(body: dict[str, Any]) -> dict[str, Any]:
    return parse_result(
        handler(make_event("PATCH", f"/apps/{APP}", user_id=OWNER, groups=["user"], body=body))
    )


def _env_of(call: dict[str, Any]) -> dict[str, str]:
    return {e["name"]: e["value"] for e in call["environmentVariablesOverride"]}


# ══════════════════════════════════════════════════════════════════════════════
# M4 — 자동 배포 토글 반영
# ══════════════════════════════════════════════════════════════════════════════


def test_m4_change_starts_pipeline_build_and_applying(env) -> None:
    seed_app(env["table"], APP, OWNER, autoDeployEnabled=True, connectionArn="arn:conn")
    out = _patch({"autoDeployEnabled": False})
    assert out["status"] == 200
    assert out["data"]["autoDeployEnabled"] is False
    assert out["data"]["autoDeploy"] == {
        "status": "APPLYING",
        "note": "자동 배포 설정을 적용하는 중이에요. 몇 분 뒤 반영돼요.",
    }
    calls = env["cb"].calls_for("start_build")
    assert len(calls) == 1
    assert calls[0]["projectName"] == PROVISIONER
    e = _env_of(calls[0])
    assert e["APP_STACK_KIND"] == "pipeline"
    assert e["AUTO_DEPLOY"] == "False"  # 바뀐 값
    assert e["APP_ID"] == APP and e["CONNECTION_ARN"] == "arn:conn"
    app = get_app(APP)
    assert app["autoDeployEnabled"] is False
    assert app["pipelineStackBuildId"] == f"{PROVISIONER}:uuid-1"
    # 내부 필드는 응답에 노출되지 않는다.
    assert "pipelineStackBuildId" not in out["data"]
    assert "autoDeployPending" not in out["data"]
    # Deployment 이력을 만들지 않는다.
    assert list_deployments(APP, 20) == []


def test_m4_same_value_no_field_no_build(env) -> None:
    seed_app(env["table"], APP, OWNER, autoDeployEnabled=True)
    out = _patch({"autoDeployEnabled": True, "sleepMode": "always-on"})
    assert out["status"] == 200
    assert "autoDeploy" not in out["data"]
    assert env["cb"].calls_for("start_build") == []
    assert out["data"]["sleepMode"] == "always-on"


def test_m4_start_failed_keeps_saved_and_retries_on_same_value(env) -> None:
    seed_app(env["table"], APP, OWNER, autoDeployEnabled=False)
    env["cb"].set_raise("start_build", RuntimeError("throttled"))
    out = _patch({"autoDeployEnabled": True})
    assert out["status"] == 200
    assert out["data"]["autoDeployEnabled"] is True  # 저장 유지
    assert out["data"]["autoDeploy"]["status"] == "SKIPPED"
    assert out["data"]["autoDeploy"]["reason"] == "START_FAILED"
    assert out["data"]["autoDeploy"]["note"]
    assert get_app(APP)["autoDeployPending"] is True

    # 같은 값으로 다시 저장 → 재시도(직전 시작 실패분).
    env["cb"]._raisers.clear()
    again = _patch({"autoDeployEnabled": True})
    assert again["data"]["autoDeploy"]["status"] == "APPLYING"
    assert _env_of(env["cb"].calls_for("start_build")[-1])["AUTO_DEPLOY"] == "True"
    assert get_app(APP)["autoDeployPending"] is False


def test_m4_already_applying_skips_and_does_not_save(env) -> None:
    seed_app(env["table"], APP, OWNER, autoDeployEnabled=True, pipelineStackBuildId="b-1")
    env["cb"].set_response("batch_get_builds", {"builds": [{"buildStatus": "IN_PROGRESS"}]})
    out = _patch({"autoDeployEnabled": False})
    assert out["status"] == 200
    assert out["data"]["autoDeploy"]["status"] == "SKIPPED"
    assert out["data"]["autoDeploy"]["reason"] == "ALREADY_APPLYING"
    assert out["data"]["autoDeployEnabled"] is True  # 저장하지 않음
    assert get_app(APP)["autoDeployEnabled"] is True
    assert env["cb"].calls_for("start_build") == []


def test_m4_allowed_while_runtime_deploy_in_progress(env) -> None:
    seed_app(env["table"], APP, OWNER, autoDeployEnabled=True, pipelineStackBuildId="b-1")
    env["cb"].set_response("batch_get_builds", {"builds": [{"buildStatus": "SUCCEEDED"}]})
    put_deployment(app_id=APP, trigger="manual", status="DEPLOYING", pipeline_execution_id="x")
    out = _patch({"autoDeployEnabled": False})
    assert out["data"]["autoDeploy"]["status"] == "APPLYING"
    assert len(env["cb"].calls_for("start_build")) == 1


def test_m4_creating_before_pipeline_build_defers(env) -> None:
    seed_app(env["table"], APP, OWNER, status="CREATING", autoDeployEnabled=True)
    out = _patch({"autoDeployEnabled": False})
    assert out["data"]["autoDeploy"]["status"] == "APPLYING"
    assert env["cb"].calls_for("start_build") == []  # 곧 실행될 deploy-pipeline 이 DDB 새 값을 읽는다
    assert get_app(APP)["autoDeployEnabled"] is False


def test_m4_failed_without_pipeline_stack_not_ready(env) -> None:
    seed_app(env["table"], APP, OWNER, status="FAILED", autoDeployEnabled=True)
    out = _patch({"autoDeployEnabled": False})
    assert out["data"]["autoDeploy"]["status"] == "SKIPPED"
    assert out["data"]["autoDeploy"]["reason"] == "NOT_READY"
    assert env["cb"].calls_for("start_build") == []


def test_m4_provision_deploy_pipeline_records_build_id(env, monkeypatch) -> None:
    seed_app(env["table"], APP, OWNER, status="CREATING")
    out = provision.handle({"step": "deploy-pipeline", "appId": APP})
    assert out["buildId"] == f"{PROVISIONER}:uuid-1"
    assert get_app(APP)["pipelineStackBuildId"] == f"{PROVISIONER}:uuid-1"


def test_m4_deploy_notify_ignores_pipeline_kind_build(env) -> None:
    seed_app(env["table"], APP, OWNER)
    event = {
        "detail-type": "CodeBuild Build State Change",
        "detail": {
            "project-name": PROVISIONER,
            "build-status": "SUCCEEDED",
            "build-id": f"arn:aws:codebuild:r:a:build/{PROVISIONER}:uuid-1",
            "additional-information": {
                "environment": {
                    "environment-variables": [
                        {"name": "APP_ID", "value": APP},
                        {"name": "APP_STACK_KIND", "value": "pipeline"},
                    ]
                }
            },
        },
    }
    assert dn.handle_event(event) == {"reason": "not-runtime-build"}
    assert list_deployments(APP, 20) == []


# ══════════════════════════════════════════════════════════════════════════════
# N4 / L1 — 커밋 정보 backfill
# ══════════════════════════════════════════════════════════════════════════════


def _stage_event(stage_name: str, state: str) -> dict[str, Any]:
    return {
        "detail-type": "CodePipeline Stage Execution State Change",
        "detail": {"pipeline": PIPELINE, "stage": stage_name, "state": state, "execution-id": EXEC},
    }


def _pipeline_event(state: str) -> dict[str, Any]:
    return {
        "detail-type": "CodePipeline Pipeline Execution State Change",
        "detail": {"pipeline": PIPELINE, "state": state, "execution-id": EXEC},
    }


def _revisions(sha: str, summary: str) -> dict[str, Any]:
    return {
        "pipelineExecution": {"artifactRevisions": [{"revisionId": sha, "revisionSummary": summary}]}
    }


def test_n4_auto_record_without_sha_backfilled_by_later_stage_event(env) -> None:
    seed_app(env["table"], APP, OWNER)
    # Source STARTED 시점엔 artifactRevisions 비어 있음 → sha 없이 생성.
    dn.handle_event(_stage_event("Source", "STARTED"))
    dep = list_deployments(APP, 20)[0]
    assert "commitSha" not in dep
    # 이후 Source SUCCEEDED(상태는 건드리지 않음)에서 채워진다.
    env["pipe"].set_response("get_pipeline_execution", _revisions("abc123", "fix: bug"))
    res = dn.handle_event(_stage_event("Source", "SUCCEEDED"))
    assert res["commitBackfilled"] is True
    dep = list_deployments(APP, 20)[0]
    assert dep["commitSha"] == "abc123"
    assert dep["commitMessage"] == "fix: bug"
    assert dep["status"] == "PENDING"


def test_n4_manual_deploy_record_backfilled_on_stage_started(env) -> None:
    seed_app(env["table"], APP, OWNER)
    put_deployment(app_id=APP, trigger="manual", pipeline_execution_id=EXEC)
    env["pipe"].set_response("get_pipeline_execution", _revisions("def456", "feat"))
    res = dn.handle_event(_stage_event("ValidateBuild", "STARTED"))
    assert res["status"] == "VALIDATING"
    dep = list_deployments(APP, 20)[0]
    assert (dep["commitSha"], dep["commitMessage"], dep["trigger"]) == ("def456", "feat", "manual")


def test_n4_terminal_record_backfilled_on_pipeline_event(env) -> None:
    seed_app(env["table"], APP, OWNER)
    put_deployment(app_id=APP, trigger="manual", status="DEPLOYING", pipeline_execution_id=EXEC)
    env["pipe"].set_response("get_pipeline_execution", _revisions("aaa111", "m"))
    dn.handle_event(_pipeline_event("SUCCEEDED"))
    dep = list_deployments(APP, 20)[0]
    assert dep["status"] == "SUCCEEDED"
    assert dep["commitSha"] == "aaa111"


def test_n4_existing_sha_not_overwritten(env) -> None:
    seed_app(env["table"], APP, OWNER)
    put_deployment(app_id=APP, trigger="auto", pipeline_execution_id=EXEC, commit_sha="orig")
    env["pipe"].set_response("get_pipeline_execution", _revisions("other", "x"))
    dn.handle_event(_stage_event("Deploy", "STARTED"))
    assert list_deployments(APP, 20)[0]["commitSha"] == "orig"
    assert env["pipe"].calls_for("get_pipeline_execution") == []


def test_n4_fallback_source_output_variables(env) -> None:
    seed_app(env["table"], APP, OWNER)
    put_deployment(app_id=APP, trigger="manual", pipeline_execution_id=EXEC)
    env["pipe"].set_response("get_pipeline_execution", {"pipelineExecution": {"artifactRevisions": []}})
    env["pipe"].set_response(
        "list_action_executions",
        {
            "actionExecutionDetails": [
                {
                    "stageName": "Source",
                    "status": "Succeeded",
                    "output": {"outputVariables": {"CommitId": "fb999", "CommitMessage": "via vars"}},
                }
            ]
        },
    )
    dn.handle_event(_stage_event("ValidateBuild", "STARTED"))
    dep = list_deployments(APP, 20)[0]
    assert (dep["commitSha"], dep["commitMessage"]) == ("fb999", "via vars")


def test_n4_codestar_json_summary_parsed(env) -> None:
    seed_app(env["table"], APP, OWNER)
    put_deployment(app_id=APP, trigger="manual", pipeline_execution_id=EXEC)
    env["pipe"].set_response(
        "get_pipeline_execution",
        _revisions("gh1", '{"ProviderType":"GitHub","CommitMessage":"hello gh"}'),
    )
    dn.handle_event(_stage_event("ValidateBuild", "STARTED"))
    assert list_deployments(APP, 20)[0]["commitMessage"] == "hello gh"


# ══════════════════════════════════════════════════════════════════════════════
# M6 — 앱 실행 로그
# ══════════════════════════════════════════════════════════════════════════════


class FakeLogs:
    """filter_log_events: 창(startTime~endTime) 안 이벤트를 오름차순으로 page 건씩. get_log_events 는 고정 응답."""

    def __init__(self, events: list[dict[str, Any]] | None = None, page: int = 3) -> None:
        self.events = sorted(events or [], key=lambda e: e["timestamp"])
        self.page = page
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.raise_err: Exception | None = None
        self.get_response: dict[str, Any] = {}

    def filter_log_events(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(("filter_log_events", kw))
        if self.raise_err:
            raise self.raise_err
        window = [e for e in self.events if kw["startTime"] <= e["timestamp"] <= kw["endTime"]]
        offset = int(kw.get("nextToken") or 0)
        chunk = window[offset : offset + self.page]
        res: dict[str, Any] = {"events": chunk}
        if offset + self.page < len(window):
            res["nextToken"] = str(offset + self.page)
        return res

    def get_log_events(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(("get_log_events", kw))
        if self.raise_err:
            raise self.raise_err
        return self.get_response


NOW = 10_000_000


@pytest.fixture
def fake_logs(env, monkeypatch):
    fake = FakeLogs()
    integ_clients.set_client("logs", fake)
    real = logs_mod.fetch_app_logs
    monkeypatch.setattr(
        "app.handlers.logs.fetch_app_logs", lambda *a, **k: real(*a, now_ms=NOW, **k)
    )
    seed_app(env["table"], APP, OWNER)
    return fake


def _ev(ts: int, msg: str | None = None) -> dict[str, Any]:
    return {"timestamp": ts, "message": msg or f"m{ts}", "logStreamName": "s"}


def test_m6_app_logs_latest_first_default_window(fake_logs) -> None:
    fake_logs.events = [_ev(NOW - 3_700_000)] + [_ev(NOW - i * 1000) for i in range(10, 0, -1)]
    out = _get(f"/apps/{APP}/logs", {"limit": "4"})
    assert out["status"] == 200
    ts = [e["timestamp"] for e in out["data"]["events"]]
    assert ts == [NOW - 1000, NOW - 2000, NOW - 3000, NOW - 4000]  # 최신부터
    first_call = fake_logs.calls[0][1]
    assert first_call["startTime"] == NOW - 3_600_000 and first_call["endTime"] == NOW
    assert "nextToken" in out["data"]
    # 다음(더 오래된) 페이지 — 겹침·누락 없음.
    page2 = _get(f"/apps/{APP}/logs", {"limit": "4", "nextToken": out["data"]["nextToken"]})
    assert [e["timestamp"] for e in page2["data"]["events"]] == [
        NOW - 5000, NOW - 6000, NOW - 7000, NOW - 8000,
    ]
    page3 = _get(f"/apps/{APP}/logs", {"limit": "4", "nextToken": page2["data"]["nextToken"]})
    assert [e["timestamp"] for e in page3["data"]["events"]] == [NOW - 9000, NOW - 10000]
    assert "nextToken" not in page3["data"]  # 창(1시간) 끝


def test_m6_app_logs_same_ms_boundary_no_dup_no_loss(fake_logs) -> None:
    fake_logs.events = [_ev(NOW - 5, f"x{i}") for i in range(5)] + [_ev(NOW - 9, "old")]
    seen: list[str] = []
    token = None
    for _ in range(5):
        q = {"limit": "2"}
        if token:
            q["nextToken"] = token
        data = _get(f"/apps/{APP}/logs", q)["data"]
        seen += [e["message"] for e in data["events"]]
        token = data.get("nextToken")
        if not token:
            break
    assert sorted(seen) == sorted([f"x{i}" for i in range(5)] + ["old"])
    assert len(seen) == 6


def test_m6_app_logs_start_time_passed(fake_logs) -> None:
    _get(f"/apps/{APP}/logs", {"startTime": str(NOW - 100)})
    assert fake_logs.calls[0][1]["startTime"] == NOW - 100


def test_m6_app_logs_group_missing_empty(fake_logs) -> None:
    fake_logs.raise_err = ClientErr("ResourceNotFoundException")
    out = _get(f"/apps/{APP}/logs")
    assert out["status"] == 200
    assert out["data"] == {"events": []}


@pytest.mark.parametrize("limit", ["0", "1001", "-1", "abc"])
def test_m6_app_logs_limit_out_of_range_400(fake_logs, limit) -> None:
    out = _get(f"/apps/{APP}/logs", {"limit": limit})
    assert out["status"] == 400
    assert out["error"]["code"] == "VALIDATION_ERROR"


def test_m6_app_logs_invalid_token_400(fake_logs) -> None:
    out = _get(f"/apps/{APP}/logs", {"nextToken": "!!not-a-token"})
    assert out["status"] == 400
    assert out["error"]["code"] == "VALIDATION_ERROR"


def test_m6_app_logs_boto_invalid_param_400(fake_logs) -> None:
    fake_logs.raise_err = ClientErr("InvalidParameterException")
    out = _get(f"/apps/{APP}/logs")
    assert out["status"] == 400
    assert out["error"]["code"] == "VALIDATION_ERROR"


def test_m6_app_logs_other_user_403(fake_logs) -> None:
    assert _get(f"/apps/{APP}/logs", user="mallory")["status"] == 403


# ══════════════════════════════════════════════════════════════════════════════
# M6 / A5 — 배포 로그
# ══════════════════════════════════════════════════════════════════════════════


def _dep_logs(dep_id: str, query: dict[str, str] | None = None, user: str = OWNER) -> dict[str, Any]:
    return _get(f"/apps/{APP}/deployments/{dep_id}/logs", query, user)


def _build(group: str = "/apphub/test/app/app00001/build", stream: str = "s1") -> dict[str, Any]:
    return {"builds": [{"id": "b", "logs": {"groupName": group, "streamName": stream}}]}


def test_m6_deploy_logs_from_record_build_id(fake_logs, env) -> None:
    dep = put_deployment(app_id=APP, trigger="rollback", build_id=f"{PROVISIONER}:u1")
    env["cb"].set_response("batch_get_builds", _build("/apphub/test/provisioner", "u1"))
    fake_logs.get_response = {
        "events": [_ev(1), _ev(3), _ev(2)],
        "nextBackwardToken": "b/older",
        "nextForwardToken": "f/x",
    }
    out = _dep_logs(dep["deploymentId"])
    assert out["status"] == 200
    assert out["data"]["source"] == "provisioner"
    assert out["data"]["stage"] == "DEPLOYING"
    assert [e["timestamp"] for e in out["data"]["events"]] == [3, 2, 1]
    assert out["data"]["nextToken"] == "b/older"
    assert env["cb"].calls_for("batch_get_builds")[0]["ids"] == [f"{PROVISIONER}:u1"]
    call = fake_logs.calls[-1][1]
    assert call["logGroupName"] == "/apphub/test/provisioner"
    assert call["logStreamName"] == "u1"
    assert call["startFromHead"] is False and call["limit"] == 200


def test_m6_deploy_logs_pipeline_failed_action_preferred(fake_logs, env) -> None:
    dep = put_deployment(app_id=APP, trigger="auto", status="FAILED", pipeline_execution_id=EXEC)
    env["pipe"].set_response(
        "list_action_executions",
        {
            "actionExecutionDetails": [
                {"stageName": "Source", "status": "Succeeded", "output": {}},
                {
                    "stageName": "ValidateBuild",
                    "status": "Failed",
                    "output": {"executionResult": {"externalExecutionId": "vb:1"}},
                },
            ]
        },
    )
    env["cb"].set_response("batch_get_builds", _build())
    fake_logs.get_response = {"events": [_ev(5)], "nextBackwardToken": "t"}
    out = _dep_logs(dep["deploymentId"], {"limit": "50"})
    assert out["data"]["source"] == "validate-build"
    assert out["data"]["stage"] == "VALIDATING"
    assert env["cb"].calls_for("batch_get_builds")[0]["ids"] == ["vb:1"]
    assert env["pipe"].calls_for("list_action_executions")[0]["filter"] == {
        "pipelineExecutionId": EXEC
    }
    assert fake_logs.calls[-1][1]["limit"] == 50


def test_m6_deploy_logs_pipeline_latest_stage_when_no_failure(fake_logs, env) -> None:
    dep = put_deployment(app_id=APP, trigger="auto", status="DEPLOYING", pipeline_execution_id=EXEC)
    env["pipe"].set_response(
        "list_action_executions",
        {
            "actionExecutionDetails": [
                {
                    "stageName": "ValidateBuild",
                    "status": "Succeeded",
                    "output": {"executionResult": {"externalExecutionId": "vb:1"}},
                },
                {
                    "stageName": "Deploy",
                    "status": "InProgress",
                    "output": {"executionResult": {"externalExecutionId": "dp:1"}},
                },
            ]
        },
    )
    env["cb"].set_response("batch_get_builds", _build())
    fake_logs.get_response = {"events": []}
    out = _dep_logs(dep["deploymentId"])
    assert out["data"]["source"] == "deploy"
    assert out["data"]["stage"] == "DEPLOYING"
    assert env["cb"].calls_for("batch_get_builds")[0]["ids"] == ["dp:1"]
    assert out["data"]["events"] == []
    assert "nextToken" not in out["data"]


def test_m6_deploy_logs_not_yet_available_empty(fake_logs, env) -> None:
    dep = put_deployment(app_id=APP, trigger="manual", pipeline_execution_id=EXEC)
    env["pipe"].set_response(
        "list_action_executions",
        {"actionExecutionDetails": [{"stageName": "Source", "status": "InProgress"}]},
    )
    out = _dep_logs(dep["deploymentId"])
    assert out["status"] == 200
    assert out["data"] == {"events": [], "source": "validate-build"}


def test_m6_deploy_logs_build_without_log_location_empty(fake_logs, env) -> None:
    dep = put_deployment(app_id=APP, trigger="rollback", build_id="p:u")
    env["cb"].set_response("batch_get_builds", {"builds": [{"id": "p:u"}]})
    out = _dep_logs(dep["deploymentId"])
    assert out["data"] == {"events": [], "source": "provisioner", "stage": "DEPLOYING"}


def test_m6_deploy_logs_stream_missing_empty(fake_logs, env) -> None:
    dep = put_deployment(app_id=APP, trigger="rollback", build_id="p:u")
    env["cb"].set_response("batch_get_builds", _build())
    fake_logs.raise_err = ClientErr("ResourceNotFoundException")
    out = _dep_logs(dep["deploymentId"])
    assert out["status"] == 200
    assert out["data"]["events"] == []


def test_m6_deploy_logs_end_of_stream_no_next_token(fake_logs, env) -> None:
    dep = put_deployment(app_id=APP, trigger="rollback", build_id="p:u")
    env["cb"].set_response("batch_get_builds", _build())
    fake_logs.get_response = {"events": [_ev(1)], "nextBackwardToken": "same"}
    out = _dep_logs(dep["deploymentId"], {"nextToken": "same"})
    assert "nextToken" not in out["data"]


def test_m6_deploy_logs_record_missing_404(fake_logs) -> None:
    out = _dep_logs("2026-01-01T00:00:00.000Z")
    assert out["status"] == 404
    assert out["error"]["code"] == "NOT_FOUND"


def test_m6_deploy_logs_other_user_403(fake_logs) -> None:
    dep = put_deployment(app_id=APP, trigger="rollback", build_id="p:u")
    assert _dep_logs(dep["deploymentId"], user="mallory")["status"] == 403


@pytest.mark.parametrize("limit", ["0", "1001", "x"])
def test_m6_deploy_logs_limit_400(fake_logs, limit) -> None:
    dep = put_deployment(app_id=APP, trigger="rollback", build_id="p:u")
    assert _dep_logs(dep["deploymentId"], {"limit": limit})["status"] == 400


def test_m6_deploy_logs_invalid_token_400(fake_logs, env) -> None:
    dep = put_deployment(app_id=APP, trigger="rollback", build_id="p:u")
    env["cb"].set_response("batch_get_builds", _build())
    fake_logs.raise_err = ClientErr("InvalidParameterException")
    out = _dep_logs(dep["deploymentId"], {"nextToken": "garbage"})
    assert out["status"] == 400
    assert out["error"]["code"] == "VALIDATION_ERROR"


# ══════════════════════════════════════════════════════════════════════════════
# A6 — 배포 이력 limit 검증 + nextToken
# ══════════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("limit", ["0", "101", "-3", "abc"])
def test_a6_limit_out_of_range_400(env, limit) -> None:
    seed_app(env["table"], APP, OWNER)
    out = _get(f"/apps/{APP}/deployments", {"limit": limit})
    assert out["status"] == 400
    assert out["error"]["code"] == "VALIDATION_ERROR"


def test_a6_pagination_next_token(env, monkeypatch) -> None:
    seed_app(env["table"], APP, OWNER)
    ids = []
    for i in range(5):
        monkeypatch.setattr(
            "app.data.deployments.now_iso", lambda i=i: f"2026-01-01T00:00:0{i}.000Z"
        )
        ids.append(put_deployment(app_id=APP, trigger="auto")["deploymentId"])
    first = _get(f"/apps/{APP}/deployments", {"limit": "2"})
    assert first["status"] == 200
    assert [d["deploymentId"] for d in first["data"]["items"]] == [ids[4], ids[3]]
    token = first["data"]["nextToken"]
    second = _get(f"/apps/{APP}/deployments", {"limit": "2", "nextToken": token})
    assert [d["deploymentId"] for d in second["data"]["items"]] == [ids[2], ids[1]]
    third = _get(
        f"/apps/{APP}/deployments", {"limit": "2", "nextToken": second["data"]["nextToken"]}
    )
    assert [d["deploymentId"] for d in third["data"]["items"]] == [ids[0]]
    assert "nextToken" not in third["data"]


def test_a6_default_limit_and_bad_token_400(env) -> None:
    seed_app(env["table"], APP, OWNER)
    put_deployment(app_id=APP, trigger="auto")
    ok_res = _get(f"/apps/{APP}/deployments")
    assert ok_res["status"] == 200 and len(ok_res["data"]["items"]) == 1
    bad = _get(f"/apps/{APP}/deployments", {"nextToken": "%%%"})
    assert bad["status"] == 400
    assert bad["error"]["code"] == "VALIDATION_ERROR"


# ══════════════════════════════════════════════════════════════════════════════
# 교차 검증 F1·F2·F6 (2026-10-08)
# ══════════════════════════════════════════════════════════════════════════════


def _brute_latest(events: list[dict[str, Any]], start: int, end: int) -> list[int]:
    return sorted((e["timestamp"] for e in events if start <= e["timestamp"] <= end), reverse=True)


def _filter_calls(fake: FakeLogs) -> list[dict[str, Any]]:
    return [kw for name, kw in fake.calls if name == "filter_log_events"]


def test_f1_burst_at_window_start_still_returns_latest(fake_logs) -> None:
    """창 앞쪽에 폭주 로그가 있어도 '최신' 이 창 앞부분으로 바뀌지 않는다(이전: 10회 오름차순 스캔 후 꼬리)."""
    start = NOW - 3_600_000
    burst = [_ev(start + 100_000 + i, f"b{i}") for i in range(100)]
    latest = [_ev(NOW - i * 1000) for i in range(5, 0, -1)]
    fake_logs.events = sorted(burst + latest, key=lambda e: e["timestamp"])
    out = _get(f"/apps/{APP}/logs", {"limit": "4"})
    assert out["status"] == 200
    assert [e["timestamp"] for e in out["data"]["events"]] == [
        NOW - 1000, NOW - 2000, NOW - 3000, NOW - 4000,
    ]
    assert len(_filter_calls(fake_logs)) <= logs_mod._MAX_FILTER_CALLS
    # 다음 페이지는 바로 그 이전(NOW-5000) 부터.
    page2 = _get(f"/apps/{APP}/logs", {"limit": "4", "nextToken": out["data"]["nextToken"]})
    assert page2["data"]["events"][0]["timestamp"] == NOW - 5000


def test_f1_uniform_dense_window_exact_latest(fake_logs) -> None:
    start = NOW - 3_600_000
    fake_logs.events = [_ev(start + i * 30_000) for i in range(121)]  # 30초 간격, 창 전체
    out = _get(f"/apps/{APP}/logs", {"limit": "5"})
    assert [e["timestamp"] for e in out["data"]["events"]] == _brute_latest(
        fake_logs.events, start, NOW
    )[:5]
    assert len(_filter_calls(fake_logs)) <= logs_mod._MAX_FILTER_CALLS


@pytest.mark.parametrize("seed", range(12))
def test_f1_random_pagination_exact_no_dup_no_loss(fake_logs, seed) -> None:
    """무작위 분포(밀집 구간 포함) — 매 페이지가 '남은 것 중 최신' 이고, 끝까지 넘기면 창 전체가 정확히 1번씩."""
    import random

    rnd = random.Random(seed)
    start = NOW - 3_600_000
    events = []
    for i in range(rnd.randint(0, 60)):
        if rnd.random() < 0.3:
            ts = start + rnd.randint(0, 2_000)  # 앞쪽 폭주
        elif rnd.random() < 0.3:
            ts = NOW - rnd.randint(0, 50)  # 끝쪽 밀집
        else:
            ts = rnd.randint(start, NOW)
        events.append(_ev(ts, f"e{i}"))
    fake_logs.events = sorted(events, key=lambda e: e["timestamp"])
    limit = rnd.choice([1, 3, 7])
    expected = _brute_latest(fake_logs.events, start, NOW)
    got: list[int] = []
    msgs: list[str] = []
    token = None
    for _ in range(200):
        q = {"limit": str(limit)}
        if token:
            q["nextToken"] = token
        fake_logs.calls.clear()
        data = _get(f"/apps/{APP}/logs", q)["data"]
        assert len(_filter_calls(fake_logs)) <= logs_mod._MAX_FILTER_CALLS
        got += [e["timestamp"] for e in data["events"]]
        msgs += [e["message"] for e in data["events"]]
        token = data.get("nextToken")
        if not token:
            break
    assert got == expected  # 순서(내림차순)·개수 모두 일치
    assert len(set(msgs)) == len(msgs)


def test_f2_start_time_narrows_window_single_call(fake_logs) -> None:
    """폴링: startTime=마지막 수신 ts → 그 시각 이상만, 보통 호출 1회."""
    fake_logs.events = [_ev(NOW - 3_000_000 + i) for i in range(50)] + [_ev(NOW - 10), _ev(NOW - 5)]
    out = _get(f"/apps/{APP}/logs", {"startTime": str(NOW - 10)})
    calls = _filter_calls(fake_logs)
    assert len(calls) == 1
    assert all(c["startTime"] >= NOW - 10 for c in calls)
    assert [e["timestamp"] for e in out["data"]["events"]] == [NOW - 5, NOW - 10]
    assert "nextToken" not in out["data"]


def test_f2_app_logs_throttled_429(fake_logs) -> None:
    fake_logs.raise_err = ClientErr("ThrottlingException")
    out = _get(f"/apps/{APP}/logs")
    assert out["status"] == 429
    assert out["error"]["code"] == "RATE_LIMITED"
    assert out["error"]["message"]


def test_f2_deploy_logs_throttled_429(fake_logs, env) -> None:
    dep = put_deployment(app_id=APP, trigger="rollback", build_id=f"{PROVISIONER}:b1")
    env["cb"].set_response("batch_get_builds", _build("/apphub/test/provisioner", "b1"))
    fake_logs.raise_err = ClientErr("ThrottlingException")
    out = _dep_logs(dep["deploymentId"])
    assert out["status"] == 429
    assert out["error"]["code"] == "RATE_LIMITED"


def test_f6_not_ready_marks_pending_and_same_value_retries(env) -> None:
    seed_app(env["table"], APP, OWNER, status="FAILED", autoDeployEnabled=True)
    out = _patch({"autoDeployEnabled": False})
    assert out["data"]["autoDeploy"]["reason"] == "NOT_READY"
    assert "다시 저장" in out["data"]["autoDeploy"]["note"]
    assert get_app(APP)["autoDeployPending"] is True
    assert "autoDeployPending" not in out["data"]  # 내부 필드 은닉
    # 앱이 준비된 뒤(ACTIVE) 같은 값으로 다시 저장 → 재시도.
    env["table"].update_item(
        Key={"PK": f"APP#{APP}", "SK": "META"},
        UpdateExpression="SET #s = :a",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":a": "ACTIVE"},
    )
    again = _patch({"autoDeployEnabled": False})
    assert again["data"]["autoDeploy"]["status"] == "APPLYING"
    assert len(env["cb"].calls_for("start_build")) == 1
    assert get_app(APP)["autoDeployPending"] is False


def test_f1_pathological_same_ms_flood_bounded(fake_logs) -> None:
    """1ms 에 페이지 상한 이상(더 줄일 수 없음) — 호출 상한 안에서 끝나고 200(최신 ms 근처 일부)."""
    fake_logs.events = [_ev(NOW, f"x{i}") for i in range(30)]
    out = _get(f"/apps/{APP}/logs", {"limit": "4"})
    assert out["status"] == 200
    assert len(out["data"]["events"]) == 4
    assert all(e["timestamp"] == NOW for e in out["data"]["events"])
    assert len(_filter_calls(fake_logs)) <= logs_mod._MAX_FILTER_CALLS
