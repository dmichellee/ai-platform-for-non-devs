"""L1 — stub 구현 4기능의 실제 연결(성공/인가/에러 경계).

1) 수동 배포: StartPipelineExecution 실제 호출 + pipelineExecutionId 기록.
2) 롤백: deploymentId 검증 + ECR 태그 실존 확인 + provisioner runtime StartBuild(IMAGE_TAG).
3) 시크릿: secrets body → Secrets Manager(값 미노출) + App.secretArns(ARN만), 수정 시 재조정/삭제.
4) 관리자 강제 중지: admin 전용, ECS desiredCount=0 + 규칙 waker 전환 + SLEEPING(always-on 포함).
"""

from __future__ import annotations

from typing import Any

import pytest
from app.data.apps import get_app
from app.data.deployments import put_deployment
from app.data.subdomains import reserve_subdomain
from app.handler import handler
from app.integrations import clients as integ_clients

from .conftest import (
    SsmStub,
    StubClient,
    make_event,
    parse_result,
    seed_app,
    seed_settings,
)

OWNER = "user-alice"
OTHER = "user-bob"
ADMIN = "user-admin"
STAGE = "test"


# ── 공통 stub 헬퍼 ────────────────────────────────────────────────────────────


def _codepipeline() -> StubClient:
    stub = StubClient()
    stub.set_response("start_pipeline_execution", {"pipelineExecutionId": "exec-99"})
    integ_clients.set_client("codepipeline", stub)
    return stub


def _codebuild() -> StubClient:
    stub = StubClient()
    stub.set_response("start_build", {"build": {"id": "build-77"}})
    integ_clients.set_client("codebuild", stub)
    return stub


def _ecr(exists: bool) -> StubClient:
    stub = StubClient()
    if exists:
        stub.set_response("describe_images", {"imageDetails": [{"imageTags": ["sha123"]}]})
    else:
        from botocore.exceptions import ClientError

        stub.set_raise(
            "describe_images",
            ClientError({"Error": {"Code": "ImageNotFoundException"}}, "DescribeImages"),
        )
    integ_clients.set_client("ecr", stub)
    return stub


class SecretsStub:
    """Secrets Manager stub — Name 기반 결정적 ARN, 호출 기록. put/desc/delete 지원."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def calls_for(self, method: str) -> list[dict[str, Any]]:
        return [p for n, p in self.calls if n == method]

    @staticmethod
    def _arn(name: str) -> str:
        # 이름에서 경로 구분자를 지운 결정적 ARN(테스트 식별용).
        suffix = name.replace("/", "_")
        return f"arn:aws:secretsmanager:ap-northeast-2:111122223333:secret:{suffix}-AbCdEf"

    def create_secret(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("create_secret", kwargs))
        return {"ARN": self._arn(kwargs["Name"])}

    def put_secret_value(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("put_secret_value", kwargs))
        return {}

    def describe_secret(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("describe_secret", kwargs))
        return {"ARN": self._arn(str(kwargs.get("SecretId", "")))}

    def delete_secret(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("delete_secret", kwargs))
        return {}


def _secretsmanager() -> SecretsStub:
    stub = SecretsStub()
    integ_clients.set_client("secretsmanager", stub)
    return stub


def _ssm_network() -> SsmStub:
    stub = SsmStub(
        {
            f"/apphub/{STAGE}/network/internal-https-listener-arn": "arn:listener:internal",
            f"/apphub/{STAGE}/network/internet-https-listener-arn": "arn:listener:internet",
            f"/apphub/{STAGE}/network/waker-tg-arn": "arn:tg:waker",
            f"/apphub/{STAGE}/network/apps-domain": "apps.example.com",
        }
    )
    integ_clients.set_client("ssm", stub)
    return stub


def _ssm_platform() -> SsmStub:
    stub = SsmStub(
        {f"/apphub/{STAGE}/platform/provisioner-project-name": "apphub-test-provisioner"}
    )
    integ_clients.set_client("ssm", stub)
    return stub


# ══════════════════════════════════════════════════════════════════════════════
# 작업 1 — 수동 배포 (POST /apps/{id}/deploy)
# ══════════════════════════════════════════════════════════════════════════════


def test_deploy_starts_pipeline_and_records_execution_id(ddb_table, stub_clients) -> None:
    seed_app(ddb_table, "dpl00001", OWNER, status="ACTIVE")
    pipe = _codepipeline()
    res = handler(make_event("POST", "/apps/dpl00001/deploy", user_id=OWNER, groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 201
    assert out["data"]["status"] == "PENDING"
    assert out["data"]["trigger"] == "manual"
    assert out["data"]["pipelineExecutionId"] == "exec-99"
    calls = pipe.calls_for("start_pipeline_execution")
    assert calls[0]["name"] == "apphub-test-app-dpl00001"


def test_deploy_creating_invalid_state(ddb_table, stub_clients) -> None:
    seed_app(ddb_table, "dpl00002", OWNER, status="CREATING")
    _codepipeline()
    res = handler(make_event("POST", "/apps/dpl00002/deploy", user_id=OWNER, groups=["user"]))
    assert parse_result(res)["error"]["code"] == "INVALID_STATE"


def test_deploy_other_owner_forbidden(ddb_table, stub_clients) -> None:
    seed_app(ddb_table, "dpl00003", OWNER, status="ACTIVE")
    res = handler(make_event("POST", "/apps/dpl00003/deploy", user_id=OTHER, groups=["user"]))
    assert parse_result(res)["status"] == 403


def test_deploy_pipeline_missing_friendly_error(ddb_table, stub_clients) -> None:
    seed_app(ddb_table, "dpl00004", OWNER, status="ACTIVE")
    pipe = StubClient()
    pipe.set_raise("start_pipeline_execution", RuntimeError("PipelineNotFoundException"))
    integ_clients.set_client("codepipeline", pipe)
    res = handler(make_event("POST", "/apps/dpl00004/deploy", user_id=OWNER, groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 409
    assert out["error"]["code"] == "INVALID_STATE"


# ══════════════════════════════════════════════════════════════════════════════
# 작업 2 — 롤백 (POST /apps/{id}/rollback)
# ══════════════════════════════════════════════════════════════════════════════


def _seed_succeeded_deployment(app_id: str, sha: str = "sha123") -> str:
    d = put_deployment(app_id=app_id, trigger="auto", status="SUCCEEDED", commit_sha=sha)
    return d["deploymentId"]


def test_rollback_starts_runtime_build_with_image_tag(ddb_table, stub_clients) -> None:
    seed_app(ddb_table, "rbk00001", OWNER, status="ACTIVE")
    dep_id = _seed_succeeded_deployment("rbk00001", "sha123")
    _ecr(exists=True)
    cb = _codebuild()
    _ssm_platform()
    res = handler(
        make_event(
            "POST", "/apps/rbk00001/rollback", user_id=OWNER, groups=["user"],
            body={"deploymentId": dep_id},
        )
    )
    out = parse_result(res)
    assert out["status"] == 200
    assert out["data"]["trigger"] == "rollback"
    assert out["data"]["commitSha"] == "sha123"
    assert out["data"]["buildId"] == "build-77"
    # provisioner StartBuild env override 에 runtime + IMAGE_TAG.
    ov = {e["name"]: e["value"] for e in cb.calls_for("start_build")[0]["environmentVariablesOverride"]}
    assert ov["APP_STACK_KIND"] == "runtime"
    assert ov["IMAGE_TAG"] == "sha123"
    assert ov["APP_ID"] == "rbk00001"


def test_rollback_unknown_deployment_404(ddb_table, stub_clients) -> None:
    seed_app(ddb_table, "rbk00002", OWNER, status="ACTIVE")
    res = handler(
        make_event(
            "POST", "/apps/rbk00002/rollback", user_id=OWNER, groups=["user"],
            body={"deploymentId": "2099-01-01"},
        )
    )
    assert parse_result(res)["error"]["code"] == "NOT_FOUND"


def test_rollback_non_succeeded_invalid_state(ddb_table, stub_clients) -> None:
    seed_app(ddb_table, "rbk00003", OWNER, status="ACTIVE")
    d = put_deployment(app_id="rbk00003", trigger="auto", status="FAILED", commit_sha="shaX")
    res = handler(
        make_event(
            "POST", "/apps/rbk00003/rollback", user_id=OWNER, groups=["user"],
            body={"deploymentId": d["deploymentId"]},
        )
    )
    assert parse_result(res)["error"]["code"] == "INVALID_STATE"


def test_rollback_image_missing_invalid_state(ddb_table, stub_clients) -> None:
    seed_app(ddb_table, "rbk00004", OWNER, status="ACTIVE")
    dep_id = _seed_succeeded_deployment("rbk00004", "shaGone")
    _ecr(exists=False)
    res = handler(
        make_event(
            "POST", "/apps/rbk00004/rollback", user_id=OWNER, groups=["user"],
            body={"deploymentId": dep_id},
        )
    )
    out = parse_result(res)
    assert out["status"] == 409
    assert out["error"]["code"] == "INVALID_STATE"


def test_rollback_missing_deployment_id_validation(ddb_table, stub_clients) -> None:
    seed_app(ddb_table, "rbk00005", OWNER, status="ACTIVE")
    res = handler(
        make_event("POST", "/apps/rbk00005/rollback", user_id=OWNER, groups=["user"], body={})
    )
    assert parse_result(res)["error"]["code"] == "VALIDATION_ERROR"


def test_rollback_other_owner_forbidden(ddb_table, stub_clients) -> None:
    seed_app(ddb_table, "rbk00006", OWNER, status="ACTIVE")
    dep_id = _seed_succeeded_deployment("rbk00006")
    res = handler(
        make_event(
            "POST", "/apps/rbk00006/rollback", user_id=OTHER, groups=["user"],
            body={"deploymentId": dep_id},
        )
    )
    assert parse_result(res)["status"] == 403


# ══════════════════════════════════════════════════════════════════════════════
# 작업 3 — 시크릿 (POST /apps + PATCH /apps/{id})
# ══════════════════════════════════════════════════════════════════════════════


def _create_body(**overrides: Any) -> dict[str, Any]:
    body = {
        "name": "My App",
        "subdomain": "myapp",
        "provider": "codecommit",
        "repoUrl": "https://git/repo",
        "presetId": "small",
        "permissionTemplateId": "basic",
        "scheme": "internal",
        "sleepMode": "always-on",
    }
    body.update(overrides)
    return body


def _seed_catalog(table) -> None:
    seed_settings(table, enabledProviders=["codecommit"])
    from .conftest import seed_perm, seed_preset

    seed_preset(table)
    seed_perm(table)


def test_create_app_stores_secrets_and_records_arns_only(ddb_table, stub_clients) -> None:
    _seed_catalog(ddb_table)
    sm = _secretsmanager()
    res = handler(
        make_event(
            "POST", "/apps", user_id=OWNER, groups=["user"],
            body=_create_body(
                envVars={"PUBLIC_URL": "https://x"},
                secrets={"DB_PASSWORD": "sup3r-secret", "API_KEY": "abc"},
            ),
        )
    )
    out = parse_result(res)
    assert out["status"] == 201
    app_id = out["data"]["appId"]
    # 응답의 secretArns 는 {KEY: ARN} — 값 없음.
    assert set(out["data"]["secretArns"].keys()) == {"DB_PASSWORD", "API_KEY"}
    for arn in out["data"]["secretArns"].values():
        assert arn.startswith("arn:aws:secretsmanager:")
    # 평문 값이 DDB 에 없다(App 레코드에 secrets 필드 없음, secretArns 값에 평문 없음).
    stored = get_app(app_id)
    assert "secrets" not in stored
    assert "sup3r-secret" not in str(stored)
    assert set(stored["secretArns"].keys()) == {"DB_PASSWORD", "API_KEY"}
    # Secrets Manager 에 각 KEY 저장(create_secret) — 이름 규약, SecretString 은 값.
    creates = sm.calls_for("create_secret")
    names = {c["Name"] for c in creates}
    assert f"apphub/{STAGE}/app/{app_id}/DB_PASSWORD" in names
    assert f"apphub/{STAGE}/app/{app_id}/API_KEY" in names


def test_create_app_invalid_secret_key(ddb_table, stub_clients) -> None:
    _seed_catalog(ddb_table)
    _secretsmanager()
    res = handler(
        make_event(
            "POST", "/apps", user_id=OWNER, groups=["user"],
            body=_create_body(secrets={"1BAD": "x"}),
        )
    )
    assert parse_result(res)["error"]["code"] == "VALIDATION_ERROR"


def test_patch_app_upserts_only_sent_keys_keeps_untouched(ddb_table, stub_clients) -> None:
    """프론트 계약 항목 9: secrets 는 부분 upsert. 보낸 KEY 만 갱신/추가, 안 보낸 기존 KEY 는 유지.

    (구 "목표 상태 재조정"과 다름 — secrets 에서 빠졌다고 자동 삭제하지 않는다.)
    """
    existing_arn = "arn:aws:secretsmanager:ap-northeast-2:111122223333:secret:old-XyZ"
    untouched_arn = "arn:aws:secretsmanager:ap-northeast-2:111122223333:secret:keep-Zzz"
    seed_app(
        ddb_table, "sec00001", OWNER, status="ACTIVE",
        secretArns={"DB_PASSWORD": existing_arn, "UNTOUCHED": untouched_arn},
    )
    sm = _secretsmanager()
    # DB_PASSWORD 갱신 + NEW_KEY 추가. UNTOUCHED 는 body 에 없음 → 그대로 유지(삭제 금지).
    res = handler(
        make_event(
            "PATCH", "/apps/sec00001", user_id=OWNER, groups=["user"],
            body={"secrets": {"DB_PASSWORD": "rotated", "NEW_KEY": "v"}},
        )
    )
    out = parse_result(res)
    assert out["status"] == 200
    # UNTOUCHED 는 유지, 보낸 두 키는 upsert 됨.
    assert set(out["data"]["secretArns"].keys()) == {"DB_PASSWORD", "NEW_KEY", "UNTOUCHED"}
    assert out["data"]["secretArns"]["UNTOUCHED"] == untouched_arn
    # 보낸 두 KEY 만 put_app_secret(create 시도 2회). UNTOUCHED 는 건드리지 않음.
    assert len(sm.calls_for("create_secret")) == 2
    # secretsRemove 가 없으므로 삭제 미호출.
    assert sm.calls_for("delete_secret") == []


def test_patch_app_secrets_remove_deletes_named_keys(ddb_table, stub_clients) -> None:
    """secretsRemove: 명시된 KEY 만 삭제. secrets(upsert)와 함께 보낼 수 있다(항목 9)."""
    old_arn = "arn:aws:secretsmanager:ap-northeast-2:111122223333:secret:gone-Aaa"
    keep_arn = "arn:aws:secretsmanager:ap-northeast-2:111122223333:secret:keep-Bbb"
    seed_app(
        ddb_table, "sec00002", OWNER, status="ACTIVE",
        secretArns={"OLD": old_arn, "KEEP": keep_arn},
    )
    sm = _secretsmanager()
    # KEEP 값 교체(upsert) + OLD 삭제(secretsRemove).
    res = handler(
        make_event(
            "PATCH", "/apps/sec00002", user_id=OWNER, groups=["user"],
            body={"secrets": {"KEEP": "rotated"}, "secretsRemove": ["OLD"]},
        )
    )
    out = parse_result(res)
    assert out["status"] == 200
    assert set(out["data"]["secretArns"].keys()) == {"KEEP"}
    # OLD 는 기존 ARN 으로 삭제.
    dels = sm.calls_for("delete_secret")
    assert any(d["SecretId"] == old_arn for d in dels)
    # KEEP 은 upsert(create 시도 1회).
    assert len(sm.calls_for("create_secret")) == 1


def test_patch_app_secrets_remove_only(ddb_table, stub_clients) -> None:
    """secretsRemove 만 보내면(secrets 없이) 해당 KEY 만 삭제, 나머지 유지."""
    old_arn = "arn:aws:secretsmanager:ap-northeast-2:111122223333:secret:gone-Aaa"
    keep_arn = "arn:aws:secretsmanager:ap-northeast-2:111122223333:secret:keep-Bbb"
    seed_app(
        ddb_table, "sec00004", OWNER, status="ACTIVE",
        secretArns={"OLD": old_arn, "KEEP": keep_arn},
    )
    sm = _secretsmanager()
    res = handler(
        make_event(
            "PATCH", "/apps/sec00004", user_id=OWNER, groups=["user"],
            body={"secretsRemove": ["OLD"]},
        )
    )
    out = parse_result(res)
    assert out["status"] == 200
    assert set(out["data"]["secretArns"].keys()) == {"KEEP"}
    assert sm.calls_for("create_secret") == []
    assert any(d["SecretId"] == old_arn for d in sm.calls_for("delete_secret"))


def test_put_app_secret_updates_existing_via_put_value() -> None:
    """put_app_secret: 이미 존재하면 create → ResourceExists → put_secret_value + describe."""
    from app.integrations.secrets import put_app_secret
    from botocore.exceptions import ClientError

    class _ExistingSecrets:
        def __init__(self) -> None:
            self.calls: list[str] = []

        def create_secret(self, **kwargs: Any) -> dict[str, Any]:
            self.calls.append("create_secret")
            raise ClientError(
                {"Error": {"Code": "ResourceExistsException"}}, "CreateSecret"
            )

        def put_secret_value(self, **kwargs: Any) -> dict[str, Any]:
            self.calls.append("put_secret_value")
            return {}

        def describe_secret(self, **kwargs: Any) -> dict[str, Any]:
            self.calls.append("describe_secret")
            return {"ARN": "arn:aws:secretsmanager:...:secret:existing-Zzz"}

    stub = _ExistingSecrets()
    integ_clients.set_client("secretsmanager", stub)
    arn = put_app_secret(STAGE, "app00099", "DB_PASSWORD", "new-value")
    assert arn == "arn:aws:secretsmanager:...:secret:existing-Zzz"
    assert stub.calls == ["create_secret", "put_secret_value", "describe_secret"]


def test_patch_app_no_secrets_field_untouched(ddb_table, stub_clients) -> None:
    seed_app(
        ddb_table, "sec00003", OWNER, status="ACTIVE",
        secretArns={"DB": "arn:aws:secretsmanager:...:secret:db-Ccc"},
    )
    sm = _secretsmanager()
    res = handler(
        make_event(
            "PATCH", "/apps/sec00003", user_id=OWNER, groups=["user"],
            body={"autoDeployEnabled": False},
        )
    )
    out = parse_result(res)
    assert out["status"] == 200
    # secrets 필드 없으면 Secrets Manager 미호출, secretArns 불변.
    assert sm.calls == []
    assert out["data"]["secretArns"] == {"DB": "arn:aws:secretsmanager:...:secret:db-Ccc"}


# ══════════════════════════════════════════════════════════════════════════════
# 작업 4 — 관리자 강제 중지 (POST /admin/apps/{id}/stop)
# ══════════════════════════════════════════════════════════════════════════════


def _svc(app_id: str, desired: int) -> dict[str, Any]:
    name = f"apphub-{STAGE}-app-{app_id}"
    return {"serviceName": name, "status": "ACTIVE", "desiredCount": desired}


def _forward_rule(target: str, host: str) -> dict[str, Any]:
    return {
        "RuleArn": "arn:...:rule1",
        "Conditions": [{"Field": "host-header", "HostHeaderConfig": {"Values": [host]}}],
        "Actions": [{"Type": "forward", "Order": 1, "TargetGroupArn": target}],
    }


@pytest.fixture
def stop_clients(p2_clients):
    """관리자 강제 중지가 사용하는 SSM(network) + ECS + ELBv2 stub 세팅."""
    _ssm_network()
    return p2_clients


def test_admin_stop_sleeps_app(ddb_table, stop_clients) -> None:
    seed_app(
        ddb_table, "stp00001", OWNER, status="ACTIVE",
        subdomain="stp", scheme="internal", sleepMode="on-demand", runtimeState="RUNNING",
    )
    reserve_subdomain("stp", "stp00001")
    stop_clients["ecs"].set_response("describe_services", {"services": [_svc("stp00001", 1)]})
    stop_clients["elbv2"].set_response(
        "describe_target_groups", {"TargetGroups": [{"TargetGroupArn": "arn:tg:app"}]}
    )
    stop_clients["elbv2"].set_response(
        "describe_rules", {"Rules": [_forward_rule("arn:tg:app", "stp.apps.example.com")]}
    )
    res = handler(make_event("POST", "/admin/apps/stp00001/stop", user_id=ADMIN, groups=["admin"]))
    out = parse_result(res)
    assert out["status"] == 200
    assert out["data"]["runtimeState"] == "SLEEPING"
    assert stop_clients["ecs"].calls_for("update_service")[0]["desiredCount"] == 0
    assert get_app("stp00001")["runtimeState"] == "SLEEPING"


def test_admin_stop_always_on_still_sleeps(ddb_table, stop_clients) -> None:
    seed_app(
        ddb_table, "stp00002", OWNER, status="ACTIVE",
        subdomain="stp2", scheme="internal", sleepMode="always-on", runtimeState="RUNNING",
    )
    reserve_subdomain("stp2", "stp00002")
    stop_clients["ecs"].set_response("describe_services", {"services": [_svc("stp00002", 2)]})
    stop_clients["elbv2"].set_response(
        "describe_target_groups", {"TargetGroups": [{"TargetGroupArn": "arn:tg:app2"}]}
    )
    stop_clients["elbv2"].set_response(
        "describe_rules", {"Rules": [_forward_rule("arn:tg:app2", "stp2.apps.example.com")]}
    )
    res = handler(make_event("POST", "/admin/apps/stp00002/stop", user_id=ADMIN, groups=["admin"]))
    out = parse_result(res)
    assert out["status"] == 200
    # always-on 이라도 관리자 강제 중지는 재운다(force).
    assert stop_clients["ecs"].calls_for("update_service")[0]["desiredCount"] == 0
    assert get_app("stp00002")["runtimeState"] == "SLEEPING"


def test_admin_stop_requires_admin(ddb_table, stop_clients) -> None:
    seed_app(ddb_table, "stp00003", OWNER, status="ACTIVE")
    res = handler(make_event("POST", "/admin/apps/stp00003/stop", user_id=OWNER, groups=["user"]))
    assert parse_result(res)["status"] == 403


def test_admin_stop_missing_app_404(ddb_table, stop_clients) -> None:
    res = handler(make_event("POST", "/admin/apps/nope0001/stop", user_id=ADMIN, groups=["admin"]))
    assert parse_result(res)["error"]["code"] == "NOT_FOUND"


def test_admin_stop_non_active_invalid_state(ddb_table, stop_clients) -> None:
    seed_app(ddb_table, "stp00004", OWNER, status="CREATING")
    res = handler(make_event("POST", "/admin/apps/stp00004/stop", user_id=ADMIN, groups=["admin"]))
    assert parse_result(res)["error"]["code"] == "INVALID_STATE"
