"""L1 — 시크릿 구조 D8(앱당 1개 JSON) + 시크릿 변경 즉시 재배포 + 지연 정리 + QA M1/H2 회귀.

D8(2026-10-05): 앱당 Secrets Manager 시크릿 1개 `apphub/{stage}/app/{appId}`(JSON {KEY: value}),
DDB App 은 secretArn + secretKeys + version. 삭제 KEY 는 secretKeys 에서만 빼고 JSON 값은 배포 성공 후 정리.

검증 대상:
  - 생성: CreateSecret 1회(JSON), DDB/응답에 값 없음, secretKeys 노출
  - 수정: upsert 병합, 삭제는 지연(JSON 유지), 버전 조건부(충돌 409 CONFLICT), 진행 중 배포 409
  - 재배포: 마지막 SUCCEEDED 커밋 → provisioner runtime StartBuild + Deployment(trigger=secret-change)
           커밋 없음 → SKIPPED/NOT_DEPLOYED, ECS 태스크 정의 이미지 태그 폴백, 시작 실패 → SKIPPED/START_FAILED
  - deploy-notify: provisioner 빌드 SUCCEEDED → 정리(활성 태스크 정의 참조 KEY 보존), FAILED → 미정리
  - H2: 잠든 앱 배포 성공 후 리스너 규칙 Waker 재전환 + desiredCount=0
  - M1: rollback SSM 조회 실패 → 친절 409
  - 삭제: 시크릿 1개 ForceDelete
  - 값이 로그/응답/DDB 어디에도 없음
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from app.data.apps import claim_secret_lock, get_app
from app.data.deployments import list_deployments, put_deployment
from app.handler import handler
from app.integrations import clients as integ_clients
from app.orchestration import deploy_notify as dn
from botocore.exceptions import ClientError

from .conftest import (
    SsmStub,
    StubClient,
    make_event,
    parse_result,
    seed_app,
    seed_perm,
    seed_preset,
    seed_settings,
)

OWNER = "user-alice"
STAGE = "test"
APP = "sec00001"
SECRET_NAME = f"apphub/{STAGE}/app/{APP}"
SECRET_ARN = f"arn:aws:secretsmanager:ap-northeast-2:111122223333:secret:{SECRET_NAME}-AbCdEf"
SERVICE = f"apphub-{STAGE}-app-{APP}"
REPO = f"apphub-{STAGE}-app-{APP}"
PROVISIONER = f"apphub-{STAGE}-provisioner"
VALUE_A = "sup3r-secret-A"
VALUE_B = "sup3r-secret-B"
VALUE_NEW = "sup3r-secret-NEW"


# ── 상태 보존 fake ────────────────────────────────────────────────────────────


class FakeSecretsManager:
    """이름/ARN 양쪽으로 접근 가능한 상태 보존 Secrets Manager fake."""

    def __init__(self) -> None:
        self.secrets: dict[str, dict[str, Any]] = {}  # name -> {"arn", "string"}
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.fail: dict[str, Exception] = {}

    def _resolve(self, secret_id: str) -> str:
        for name, rec in self.secrets.items():
            if secret_id in (name, rec["arn"]):
                return name
        raise ClientError({"Error": {"Code": "ResourceNotFoundException"}}, "X")

    def calls_for(self, method: str) -> list[dict[str, Any]]:
        return [p for n, p in self.calls if n == method]

    def seed(self, name: str, arn: str, mapping: dict[str, str]) -> None:
        self.secrets[name] = {"arn": arn, "string": json.dumps(mapping)}

    def json_of(self, name: str) -> dict[str, str]:
        return json.loads(self.secrets[name]["string"])

    def _maybe_fail(self, method: str) -> None:
        if method in self.fail:
            raise self.fail[method]

    def create_secret(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(("create_secret", kw))
        self._maybe_fail("create_secret")
        name = kw["Name"]
        if name in self.secrets:
            raise ClientError({"Error": {"Code": "ResourceExistsException"}}, "CreateSecret")
        arn = f"arn:aws:secretsmanager:ap-northeast-2:111122223333:secret:{name}-AbCdEf"
        self.secrets[name] = {"arn": arn, "string": kw["SecretString"]}
        return {"ARN": arn, "Name": name}

    def get_secret_value(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(("get_secret_value", kw))
        name = self._resolve(kw["SecretId"])
        return {"SecretString": self.secrets[name]["string"]}

    def put_secret_value(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(("put_secret_value", kw))
        self._maybe_fail("put_secret_value")
        name = self._resolve(kw["SecretId"])
        self.secrets[name]["string"] = kw["SecretString"]
        return {}

    def describe_secret(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(("describe_secret", kw))
        name = self._resolve(kw["SecretId"])
        return {"ARN": self.secrets[name]["arn"], "Name": name}

    def delete_secret(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(("delete_secret", kw))
        name = self._resolve(kw["SecretId"])
        del self.secrets[name]
        return {}


class FakeEcs:
    """서비스 1개 + 태스크 정의들. task_defs: arn -> {"image", "keys"}."""

    def __init__(
        self,
        primary: str | None = None,
        task_defs: dict[str, dict[str, Any]] | None = None,
        desired: int = 1,
        extra_deployments: list[str] | None = None,
    ) -> None:
        self.primary = primary
        self.task_defs = task_defs or {}
        self.desired = desired
        self.extra = extra_deployments or []
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def calls_for(self, method: str) -> list[dict[str, Any]]:
        return [p for n, p in self.calls if n == method]

    def describe_services(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(("describe_services", kw))
        if self.primary is None:
            return {"services": []}
        return {
            "services": [
                {
                    "serviceName": SERVICE,
                    "status": "ACTIVE",
                    "desiredCount": self.desired,
                    "taskDefinition": self.primary,
                    "deployments": [{"taskDefinition": self.primary}]
                    + [{"taskDefinition": a} for a in self.extra],
                }
            ]
        }

    def describe_task_definition(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(("describe_task_definition", kw))
        td = self.task_defs[kw["taskDefinition"]]
        return {
            "taskDefinition": {
                "containerDefinitions": [
                    {
                        "name": "app",
                        "image": td["image"],
                        "secrets": [
                            {"name": k, "valueFrom": f"{SECRET_ARN}:{k}::"} for k in td["keys"]
                        ],
                    }
                ]
            }
        }

    def update_service(self, **kw: Any) -> dict[str, Any]:
        self.calls.append(("update_service", kw))
        if "desiredCount" in kw:
            self.desired = kw["desiredCount"]
        return {}


def _image(tag: str) -> str:
    return f"111122223333.dkr.ecr.ap-northeast-2.amazonaws.com/{REPO}:{tag}"


@pytest.fixture
def env(ddb_table, stub_clients):
    """API + deploy-notify 공통 stub: SM(fake), ECS(fake), CodeBuild, ECR, SSM, ELBv2."""
    sm = FakeSecretsManager()
    integ_clients.set_client("secretsmanager", sm)
    ecs = FakeEcs()
    integ_clients.set_client("ecs", ecs)
    cb = StubClient()
    cb.set_response("start_build", {"build": {"id": f"{PROVISIONER}:uuid-1"}})
    integ_clients.set_client("codebuild", cb)
    ecr = StubClient()
    ecr.set_response("describe_images", {"imageDetails": [{"imageTags": ["x"]}]})
    integ_clients.set_client("ecr", ecr)
    ssm = SsmStub(
        {
            f"/apphub/{STAGE}/platform/provisioner-project-name": PROVISIONER,
            f"/apphub/{STAGE}/network/internal-https-listener-arn": "arn:listener:internal",
            f"/apphub/{STAGE}/network/internet-https-listener-arn": "arn:listener:internet",
            f"/apphub/{STAGE}/network/waker-tg-arn": "arn:tg:waker",
            # D20: ALB별 Waker TG(n=0 internal 은 신규 TG — legacy 폴백 없음, 계약 §1.2).
            f"/apphub/{STAGE}/network/alb/internal/0/waker-tg-arn": "arn:tg:waker",
            f"/apphub/{STAGE}/network/apps-domain": "apps.example.com",
        }
    )
    integ_clients.set_client("ssm", ssm)
    elb = StubClient()
    integ_clients.set_client("elbv2", elb)
    pipe = StubClient()
    integ_clients.set_client("codepipeline", pipe)
    return {"sm": sm, "ecs": ecs, "cb": cb, "ecr": ecr, "ssm": ssm, "elb": elb, "table": ddb_table}


def _seed_app_with_secret(table, keys: list[str], json_map: dict[str, str], sm: FakeSecretsManager, **kw: Any) -> None:
    sm.seed(SECRET_NAME, SECRET_ARN, json_map)
    seed_app(table, APP, OWNER, secretArn=SECRET_ARN, secretKeys=keys, version=kw.pop("version", 3), **kw)


def _patch(body: dict[str, Any]) -> dict[str, Any]:
    return parse_result(handler(make_event("PATCH", f"/apps/{APP}", user_id=OWNER, groups=["user"], body=body)))


def _start_build_env(cb: StubClient) -> dict[str, str]:
    call = cb.calls_for("start_build")[0]
    return {e["name"]: e["value"] for e in call["environmentVariablesOverride"]}


def _raw_item(table) -> dict[str, Any]:
    return table.get_item(Key={"PK": f"APP#{APP}", "SK": "META"})["Item"]


# ══════════════════════════════════════════════════════════════════════════════
# 생성
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
    seed_preset(table)
    seed_perm(table)


def test_create_app_one_json_secret_keys_only(env) -> None:
    _seed_catalog(env["table"])
    res = parse_result(
        handler(
            make_event(
                "POST", "/apps", user_id=OWNER, groups=["user"],
                body=_create_body(secrets={"DB_PASSWORD": VALUE_A, "API_KEY": VALUE_B}),
            )
        )
    )
    assert res["status"] == 201
    app_id = res["data"]["appId"]
    assert res["data"]["secretKeys"] == ["API_KEY", "DB_PASSWORD"]
    assert "secretArns" not in res["data"]
    assert "version" not in res["data"]
    # Secrets Manager: CreateSecret 1회, 이름 규약, JSON 내용.
    creates = env["sm"].calls_for("create_secret")
    assert len(creates) == 1
    assert creates[0]["Name"] == f"apphub/{STAGE}/app/{app_id}"
    assert json.loads(creates[0]["SecretString"]) == {"DB_PASSWORD": VALUE_A, "API_KEY": VALUE_B}
    # DDB: ARN + KEY 목록 + version 0, 값 없음.
    stored = env["table"].get_item(Key={"PK": f"APP#{app_id}", "SK": "META"})["Item"]
    assert stored["secretArn"].endswith(f"apphub/{STAGE}/app/{app_id}-AbCdEf")
    assert sorted(stored["secretKeys"]) == ["API_KEY", "DB_PASSWORD"]
    assert stored["version"] == 0
    assert VALUE_A not in str(stored) and VALUE_B not in str(stored)
    assert VALUE_A not in json.dumps(res, ensure_ascii=False)


def test_create_app_without_secrets_no_secret(env) -> None:
    _seed_catalog(env["table"])
    res = parse_result(handler(make_event("POST", "/apps", user_id=OWNER, groups=["user"], body=_create_body())))
    assert res["status"] == 201
    assert res["data"]["secretKeys"] == []
    assert "secretArn" not in res["data"]
    assert env["sm"].calls == []


def test_create_app_invalid_secret_key(env) -> None:
    _seed_catalog(env["table"])
    res = parse_result(
        handler(make_event("POST", "/apps", user_id=OWNER, groups=["user"], body=_create_body(secrets={"1BAD": "x"})))
    )
    assert res["error"]["code"] == "VALIDATION_ERROR"
    assert env["sm"].calls == []


# ══════════════════════════════════════════════════════════════════════════════
# 수정 + 즉시 재배포
# ══════════════════════════════════════════════════════════════════════════════


def test_patch_upsert_merges_json_and_redeploys_last_succeeded_commit(env) -> None:
    _seed_app_with_secret(env["table"], ["A"], {"A": VALUE_A}, env["sm"])
    put_deployment(app_id=APP, trigger="auto", status="SUCCEEDED", commit_sha="sha-ok", commit_message="m")

    out = _patch({"secrets": {"A": VALUE_NEW, "B": VALUE_B}})
    assert out["status"] == 200
    assert out["data"]["secretKeys"] == ["A", "B"]
    assert env["sm"].json_of(SECRET_NAME) == {"A": VALUE_NEW, "B": VALUE_B}
    # version 은 조건부로 +1 되고 잠금은 해제됨.
    raw = _raw_item(env["table"])
    assert raw["version"] == 4
    assert "secretLockId" not in raw
    # 재배포: 마지막 SUCCEEDED 커밋으로 provisioner runtime 재배포.
    redeploy = out["data"]["redeploy"]
    assert redeploy["status"] == "PENDING"
    ov = _start_build_env(env["cb"])
    assert ov == {
        "APP_ID": APP,
        "STAGE": STAGE,
        "APP_STACK_KIND": "runtime",
        "IMAGE_TAG": "sha-ok",
        "DEPLOY_TRIGGER": "secret-change",
    }
    dep = next(d for d in list_deployments(APP, 20) if d["deploymentId"] == redeploy["deploymentId"])
    assert dep["trigger"] == "secret-change"
    assert dep["status"] == "PENDING"
    assert dep["commitSha"] == "sha-ok"
    assert dep["buildId"] == f"{PROVISIONER}:uuid-1"


def test_patch_remove_is_lazy_json_kept_secret_keys_excluded(env) -> None:
    """삭제 KEY 는 JSON 에서 지우지 않는다(실행 중 태스크 정의가 참조 — QA H4)."""
    _seed_app_with_secret(env["table"], ["A", "OLD"], {"A": VALUE_A, "OLD": VALUE_B}, env["sm"])
    put_deployment(app_id=APP, trigger="auto", status="SUCCEEDED", commit_sha="sha-ok")

    out = _patch({"secretsRemove": ["OLD"]})
    assert out["status"] == 200
    assert out["data"]["secretKeys"] == ["A"]
    assert env["sm"].json_of(SECRET_NAME) == {"A": VALUE_A, "OLD": VALUE_B}
    assert env["sm"].calls_for("put_secret_value") == []
    assert env["sm"].calls_for("delete_secret") == []
    assert out["data"]["redeploy"]["status"] == "PENDING"


def test_patch_remove_wins_over_upsert_same_key(env) -> None:
    _seed_app_with_secret(env["table"], ["A"], {"A": VALUE_A}, env["sm"])
    out = _patch({"secrets": {"A": VALUE_NEW}, "secretsRemove": ["A"]})
    assert out["data"]["secretKeys"] == []
    assert env["sm"].json_of(SECRET_NAME) == {"A": VALUE_A}  # 값 갱신 안 함, 지연 정리 대상


def test_patch_remove_unknown_key_is_noop(env) -> None:
    _seed_app_with_secret(env["table"], ["A"], {"A": VALUE_A}, env["sm"])
    put_deployment(app_id=APP, trigger="auto", status="SUCCEEDED", commit_sha="sha-ok")
    out = _patch({"secretsRemove": ["NOPE"]})
    assert out["status"] == 200
    assert "redeploy" not in out["data"]
    assert env["sm"].calls == []
    assert env["cb"].calls_for("start_build") == []
    assert _raw_item(env["table"])["version"] == 3


def test_patch_first_secret_creates_json_secret(env) -> None:
    seed_app(env["table"], APP, OWNER)
    out = _patch({"secrets": {"NEW_KEY": VALUE_NEW}})
    assert out["status"] == 200
    assert out["data"]["secretKeys"] == ["NEW_KEY"]
    assert env["sm"].json_of(SECRET_NAME) == {"NEW_KEY": VALUE_NEW}
    raw = _raw_item(env["table"])
    assert raw["secretArn"] == env["sm"].secrets[SECRET_NAME]["arn"]
    assert raw["version"] == 1  # 없으면 0 으로 간주 → +1


def test_patch_while_deploy_in_progress_409(env) -> None:
    _seed_app_with_secret(env["table"], ["A"], {"A": VALUE_A}, env["sm"])
    put_deployment(app_id=APP, trigger="manual", status="DEPLOYING", pipeline_execution_id="e1")
    out = _patch({"secrets": {"A": VALUE_NEW}})
    assert out["status"] == 409
    assert out["error"]["code"] == "INVALID_STATE"
    assert "배포가 끝난 뒤" in out["error"]["message"]
    assert env["sm"].json_of(SECRET_NAME) == {"A": VALUE_A}
    assert env["cb"].calls_for("start_build") == []
    assert _raw_item(env["table"])["version"] == 3


def test_patch_ignores_stale_in_progress_record(env) -> None:
    """이벤트 유실로 고착된 오래된 비종결 레코드는 시크릿 저장을 영구히 막지 않는다."""
    _seed_app_with_secret(env["table"], ["A"], {"A": VALUE_A}, env["sm"])
    old = (datetime.now(timezone.utc) - timedelta(hours=5)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    env["table"].put_item(
        Item={
            "PK": f"APP#{APP}", "SK": f"DEPLOY#{old}", "entityType": "Deployment",
            "appId": APP, "deploymentId": old, "trigger": "rollback", "status": "PENDING",
            "createdAt": old, "updatedAt": old,
        }
    )
    out = _patch({"secrets": {"A": VALUE_NEW}})
    assert out["status"] == 200


def test_patch_version_conflict_409(env) -> None:
    """다른 작성자가 먼저 잠금(version 조건부)을 잡았으면 409 CONFLICT, 시크릿 미변경."""
    _seed_app_with_secret(env["table"], ["A"], {"A": VALUE_A}, env["sm"])
    import time as _t

    claim_secret_lock(APP, 3, "other-writer", int(_t.time()))  # 동시 저장/정리가 진행 중
    out = _patch({"secrets": {"A": VALUE_NEW}})
    assert out["status"] == 409
    assert out["error"]["code"] == "CONFLICT"
    assert env["sm"].json_of(SECRET_NAME) == {"A": VALUE_A}


def test_apply_secret_changes_stale_version_conflict(env) -> None:
    """읽은 뒤 version 이 바뀌었으면(=다른 저장 완료) 조건부 claim 실패 → CONFLICT."""
    from app.domain.secrets import apply_secret_changes
    from app.http.errors import ApiError

    _seed_app_with_secret(env["table"], ["A"], {"A": VALUE_A}, env["sm"], version=5)
    stale = {**get_app(APP), "version": 4}
    with pytest.raises(ApiError) as exc:
        apply_secret_changes(STAGE, stale, {"A": VALUE_NEW}, [])
    assert exc.value.code == "CONFLICT"
    assert env["sm"].json_of(SECRET_NAME) == {"A": VALUE_A}


def test_patch_expired_lock_does_not_block(env) -> None:
    _seed_app_with_secret(
        env["table"], ["A"], {"A": VALUE_A}, env["sm"], secretLockId="dead", secretLockExpiresAt=1
    )
    out = _patch({"secrets": {"A": VALUE_NEW}})
    assert out["status"] == 200
    assert env["sm"].json_of(SECRET_NAME) == {"A": VALUE_NEW}


def test_patch_secret_write_failure_releases_lock(env) -> None:
    _seed_app_with_secret(env["table"], ["A"], {"A": VALUE_A}, env["sm"])
    env["sm"].fail["put_secret_value"] = ClientError({"Error": {"Code": "InternalServiceError"}}, "Put")
    out = _patch({"secrets": {"A": VALUE_NEW}})
    assert out["status"] == 500
    raw = _raw_item(env["table"])
    assert "secretLockId" not in raw
    assert list(raw["secretKeys"]) == ["A"]


def test_patch_not_deployed_skips_redeploy(env) -> None:
    """성공 배포 이력도, 실행 중 서비스도 없으면 SKIPPED/NOT_DEPLOYED(StartBuild 없음)."""
    _seed_app_with_secret(env["table"], ["A"], {"A": VALUE_A}, env["sm"])
    out = _patch({"secrets": {"B": VALUE_B}})
    assert out["status"] == 200
    assert out["data"]["redeploy"]["status"] == "SKIPPED"
    assert out["data"]["redeploy"]["reason"] == "NOT_DEPLOYED"
    assert env["cb"].calls_for("start_build") == []
    assert env["sm"].json_of(SECRET_NAME) == {"A": VALUE_A, "B": VALUE_B}


def test_patch_creating_app_skips_redeploy(env) -> None:
    _seed_app_with_secret(env["table"], ["A"], {"A": VALUE_A}, env["sm"], status="CREATING")
    out = _patch({"secrets": {"A": VALUE_NEW}})
    assert out["data"]["redeploy"] == {
        "status": "SKIPPED", "reason": "NOT_DEPLOYED", "note": out["data"]["redeploy"]["note"]
    }
    assert env["ecs"].calls == []


def test_patch_redeploy_falls_back_to_ecs_image_tag(env) -> None:
    _seed_app_with_secret(env["table"], ["A"], {"A": VALUE_A}, env["sm"])
    env["ecs"].primary = "td:7"
    env["ecs"].task_defs = {"td:7": {"image": _image("sha-running"), "keys": ["A"]}}
    out = _patch({"secrets": {"A": VALUE_NEW}})
    assert out["data"]["redeploy"]["status"] == "PENDING"
    assert _start_build_env(env["cb"])["IMAGE_TAG"] == "sha-running"


def test_patch_redeploy_start_failure_returns_skipped_saved(env) -> None:
    _seed_app_with_secret(env["table"], ["A"], {"A": VALUE_A}, env["sm"])
    put_deployment(app_id=APP, trigger="auto", status="SUCCEEDED", commit_sha="sha-ok")
    env["cb"].set_raise("start_build", RuntimeError("AccessDenied"))
    out = _patch({"secrets": {"A": VALUE_NEW}})
    assert out["status"] == 200
    assert out["data"]["redeploy"]["status"] == "SKIPPED"
    assert out["data"]["redeploy"]["reason"] == "START_FAILED"
    assert env["sm"].json_of(SECRET_NAME) == {"A": VALUE_NEW}


def test_patch_redeploy_image_missing_skipped(env) -> None:
    _seed_app_with_secret(env["table"], ["A"], {"A": VALUE_A}, env["sm"])
    put_deployment(app_id=APP, trigger="auto", status="SUCCEEDED", commit_sha="sha-gone")
    env["ecr"].set_raise(
        "describe_images", ClientError({"Error": {"Code": "ImageNotFoundException"}}, "DescribeImages")
    )
    out = _patch({"secrets": {"A": VALUE_NEW}})
    assert out["data"]["redeploy"]["reason"] == "IMAGE_NOT_FOUND"
    assert env["cb"].calls_for("start_build") == []


def test_patch_without_secret_fields_untouched(env) -> None:
    _seed_app_with_secret(env["table"], ["A"], {"A": VALUE_A}, env["sm"])
    out = _patch({"autoDeployEnabled": False})
    assert out["status"] == 200
    assert out["data"]["secretKeys"] == ["A"]
    assert "redeploy" not in out["data"]
    assert env["sm"].calls == []


def test_app_view_hides_internal_fields(env) -> None:
    _seed_app_with_secret(env["table"], ["A"], {"A": VALUE_A}, env["sm"], secretLockId="x", secretLockExpiresAt=1)
    out = parse_result(handler(make_event("GET", f"/apps/{APP}", user_id=OWNER, groups=["user"])))
    for hidden in ("version", "secretLockId", "secretLockExpiresAt"):
        assert hidden not in out["data"]
    assert out["data"]["secretKeys"] == ["A"]


# ══════════════════════════════════════════════════════════════════════════════
# QA M1 — rollback SSM 조회 실패
# ══════════════════════════════════════════════════════════════════════════════


def test_rollback_ssm_failure_is_friendly_409(env) -> None:
    seed_app(env["table"], APP, OWNER)
    dep = put_deployment(app_id=APP, trigger="auto", status="SUCCEEDED", commit_sha="sha-ok")
    env["ssm"].params.pop(f"/apphub/{STAGE}/platform/provisioner-project-name")  # 조회 실패(AccessDenied 등)
    out = parse_result(
        handler(
            make_event(
                "POST", f"/apps/{APP}/rollback", user_id=OWNER, groups=["user"],
                body={"deploymentId": dep["deploymentId"]},
            )
        )
    )
    assert out["status"] == 409
    assert out["error"]["code"] == "INVALID_STATE"
    assert "되돌리기" in out["error"]["message"]


# ══════════════════════════════════════════════════════════════════════════════
# deploy-notify — provisioner 런타임 재배포 이벤트 + 지연 정리 + H2
# ══════════════════════════════════════════════════════════════════════════════


def _build_event(status: str, build_uuid: str = "uuid-1", kind: str = "runtime") -> dict[str, Any]:
    return {
        "detail-type": "CodeBuild Build State Change",
        "source": "aws.codebuild",
        "detail": {
            "build-status": status,
            "project-name": PROVISIONER,
            "build-id": f"arn:aws:codebuild:ap-northeast-2:111122223333:build/{PROVISIONER}:{build_uuid}",
            "additional-information": {
                "environment": {
                    "environment-variables": [
                        {"name": "APP_ID", "value": APP, "type": "PLAINTEXT"},
                        {"name": "APP_STACK_KIND", "value": kind, "type": "PLAINTEXT"},
                        {"name": "IMAGE_TAG", "value": "sha-ok", "type": "PLAINTEXT"},
                    ]
                }
            },
        },
    }


@pytest.fixture
def notify_ready(env, monkeypatch):
    monkeypatch.setenv("STAGE", STAGE)
    # 앱: secretKeys=[A], JSON 에는 삭제된 OLD(구 태스크 정의 참조)와 GONE(아무도 참조 안 함)이 남아 있음.
    _seed_app_with_secret(
        env["table"], ["A"], {"A": VALUE_A, "OLD": VALUE_B, "GONE": "v-gone"}, env["sm"]
    )
    put_deployment(app_id=APP, trigger="secret-change", commit_sha="sha-ok", build_id=f"{PROVISIONER}:uuid-1")
    # 새 PRIMARY(A만) + 아직 draining 중인 구 배포(OLD 참조).
    env["ecs"].primary = "td:2"
    env["ecs"].extra = ["td:1"]
    env["ecs"].task_defs = {
        "td:2": {"image": _image("sha-ok"), "keys": ["A"]},
        "td:1": {"image": _image("sha-ok"), "keys": ["A", "OLD"]},
    }
    return env


def test_notify_build_succeeded_prunes_unreferenced_keys(notify_ready) -> None:
    res = dn.handle(_build_event("SUCCEEDED"))
    dep = list_deployments(APP, 20)[0]
    assert dep["status"] == "SUCCEEDED"
    # GONE 만 제거, OLD 는 활성 태스크 정의가 참조하므로 보존.
    assert notify_ready["sm"].json_of(SECRET_NAME) == {"A": VALUE_A, "OLD": VALUE_B}
    assert res["afterSuccess"]["secrets"] == {"pruned": ["GONE"]}
    raw = _raw_item(notify_ready["table"])
    assert list(raw["secretKeys"]) == ["A"]
    assert "secretLockId" not in raw


def test_notify_build_failed_prunes_nothing(notify_ready) -> None:
    dn.handle(_build_event("FAILED"))
    dep = list_deployments(APP, 20)[0]
    assert dep["status"] == "FAILED"
    assert dep["failureCategory"] == "DEPLOY_FAILED"
    assert notify_ready["sm"].calls_for("put_secret_value") == []
    assert notify_ready["sm"].json_of(SECRET_NAME) == {"A": VALUE_A, "OLD": VALUE_B, "GONE": "v-gone"}


def test_notify_build_in_progress_sets_deploying(notify_ready) -> None:
    dn.handle(_build_event("IN_PROGRESS"))
    assert list_deployments(APP, 20)[0]["status"] == "DEPLOYING"
    assert notify_ready["sm"].calls_for("put_secret_value") == []


def test_notify_build_pipeline_kind_or_unknown_build_skipped(notify_ready) -> None:
    assert dn.handle(_build_event("SUCCEEDED", kind="pipeline"))["reason"] == "not-runtime-build"
    assert dn.handle(_build_event("SUCCEEDED", build_uuid="other"))["reason"] == "no-record-skipped"
    assert list_deployments(APP, 20)[0]["status"] == "PENDING"


def test_secret_change_race_build_event_first_single_record(env, monkeypatch) -> None:
    """시크릿 변경 재배포: StartBuild 직후 빌드 FAILED 이벤트가 접수 기록보다 먼저 → 1건 secret-change FAILED."""
    from app.domain import redeploy as redeploy_mod

    monkeypatch.setenv("STAGE", STAGE)
    _seed_app_with_secret(env["table"], ["A"], {"A": VALUE_A}, env["sm"])
    put_deployment(app_id=APP, trigger="auto", status="SUCCEEDED", commit_sha="sha-ok", commit_message="m")
    real_start = redeploy_mod.start_provisioner_build

    def start_then_event(project: str, build_env: dict[str, str]) -> str:
        build_id = real_start(project, build_env)
        event = _build_event("FAILED")
        event["detail"]["additional-information"]["environment"]["environment-variables"].append(
            {"name": "DEPLOY_TRIGGER", "value": build_env["DEPLOY_TRIGGER"]}
        )
        assert dn.handle(event)["created"] is True
        return build_id

    monkeypatch.setattr(redeploy_mod, "start_provisioner_build", start_then_event)
    out = _patch({"secrets": {"A": VALUE_NEW}})
    assert out["status"] == 200
    redeploy = out["data"]["redeploy"]
    redeploys = [d for d in list_deployments(APP, 20) if d.get("buildId") == f"{PROVISIONER}:uuid-1"]
    assert len(redeploys) == 1
    dep = redeploys[0]
    assert dep["deploymentId"] == redeploy["deploymentId"]
    assert dep["trigger"] == "secret-change"
    assert dep["status"] == "FAILED"
    assert dep["commitSha"] == "sha-ok"
    assert dep["commitMessage"] == "m"


def test_notify_prune_skips_when_service_unknown(notify_ready) -> None:
    notify_ready["ecs"].primary = None
    dn.handle(_build_event("SUCCEEDED"))
    assert notify_ready["sm"].calls_for("put_secret_value") == []


def test_notify_pipeline_succeeded_also_prunes(notify_ready) -> None:
    put_deployment(app_id=APP, trigger="auto", pipeline_execution_id="exec-1")
    dn.handle(
        {
            "detail-type": "CodePipeline Pipeline Execution State Change",
            "detail": {"pipeline": f"apphub-{STAGE}-app-{APP}", "state": "SUCCEEDED", "execution-id": "exec-1"},
        }
    )
    assert notify_ready["sm"].json_of(SECRET_NAME) == {"A": VALUE_A, "OLD": VALUE_B}


def test_notify_prune_skips_when_locked(notify_ready) -> None:
    import time as _t

    claim_secret_lock(APP, 3, "patch-in-flight", int(_t.time()))
    res = dn.handle(_build_event("SUCCEEDED"))
    assert res["afterSuccess"]["secrets"]["reason"] == "locked-or-changed-skip"
    assert notify_ready["sm"].calls_for("put_secret_value") == []


def _rule(target: str) -> dict[str, Any]:
    return {
        "RuleArn": "arn:rule:1",
        "Conditions": [{"Field": "host-header", "HostHeaderConfig": {"Values": ["a-app.apps.example.com"]}}],
        "Actions": [
            {"Type": "authenticate-cognito", "Order": 1, "AuthenticateCognitoConfig": {}},
            {"Type": "forward", "Order": 2, "TargetGroupArn": target},
        ],
    }


def test_h2_sleeping_app_resleeps_after_deploy(notify_ready) -> None:
    """잠든 앱 배포 성공 후: 규칙이 앱 TG 로 돌아가 있어도 Waker TG 로 재전환 + desiredCount=0."""
    notify_ready["table"].update_item(
        Key={"PK": f"APP#{APP}", "SK": "META"},
        UpdateExpression="SET runtimeState = :s",
        ExpressionAttributeValues={":s": "SLEEPING"},
    )
    notify_ready["ecs"].desired = 0
    elb = notify_ready["elb"]
    elb.set_response("describe_target_groups", {"TargetGroups": [{"TargetGroupArn": "arn:tg:app"}]})
    elb.set_response("describe_rules", {"Rules": [_rule("arn:tg:app")]})

    res = dn.handle(_build_event("SUCCEEDED"))
    mods = elb.calls_for("modify_rule")
    assert len(mods) == 1
    actions = mods[0]["Actions"]
    assert actions[0]["Type"] == "authenticate-cognito"  # 인증 액션 보존
    assert actions[1]["TargetGroupArn"] == "arn:tg:waker"
    assert res["afterSuccess"]["sleep"]["ruleSwitched"] is True
    assert get_app(APP)["runtimeState"] == "SLEEPING"


def test_h2_sleeping_app_with_tasks_scaled_back_to_zero(notify_ready) -> None:
    notify_ready["table"].update_item(
        Key={"PK": f"APP#{APP}", "SK": "META"},
        UpdateExpression="SET runtimeState = :s",
        ExpressionAttributeValues={":s": "SLEEPING"},
    )
    notify_ready["ecs"].desired = 1
    notify_ready["elb"].set_response("describe_target_groups", {"TargetGroups": [{"TargetGroupArn": "arn:tg:app"}]})
    notify_ready["elb"].set_response("describe_rules", {"Rules": [_rule("arn:tg:waker")]})
    dn.handle(_build_event("SUCCEEDED"))
    ups = notify_ready["ecs"].calls_for("update_service")
    assert ups and ups[-1]["desiredCount"] == 0
    assert notify_ready["elb"].calls_for("modify_rule") == []  # 이미 Waker — 멱등


def test_h2_running_app_untouched(notify_ready) -> None:
    dn.handle(_build_event("SUCCEEDED"))
    assert notify_ready["elb"].calls_for("modify_rule") == []
    assert notify_ready["ecs"].calls_for("update_service") == []


# ══════════════════════════════════════════════════════════════════════════════
# 값 미노출(로그/응답/DDB) 종합
# ══════════════════════════════════════════════════════════════════════════════


def test_secret_values_never_in_logs_responses_or_ddb(notify_ready, capsys) -> None:
    put_deployment(app_id=APP, trigger="auto", status="SUCCEEDED", commit_sha="sha-ok")
    # 진행 중 레코드(fixture 의 secret-change PENDING)를 끝내야 PATCH 가 가능.
    dn.handle(_build_event("SUCCEEDED"))
    out = _patch({"secrets": {"A": VALUE_NEW, "Z": "zz-secret-zz"}, "secretsRemove": ["OLD"]})
    assert out["status"] == 200
    dn.handle(_build_event("SUCCEEDED", build_uuid="uuid-1"))
    captured = capsys.readouterr()
    blob = captured.out + captured.err + json.dumps(out, ensure_ascii=False)
    blob += str(notify_ready["table"].scan()["Items"])
    for value in (VALUE_A, VALUE_B, VALUE_NEW, "zz-secret-zz", "v-gone"):
        assert value not in blob


# ── QA N2(2026-10-08): 런타임 재배포 실패에도 재수면 ─────────────────────────────


def test_n2_sleeping_app_resleeps_after_failed_runtime_build(notify_ready) -> None:
    """롤백/시크릿 변경 빌드 FAILED: 배포 전 규칙 복귀로 앱 TG 에 남은 forward 를 Waker TG 로 되돌린다.

    시크릿 지연 정리는 실패 배포에서 하지 않는다(D8).
    """
    notify_ready["table"].update_item(
        Key={"PK": f"APP#{APP}", "SK": "META"},
        UpdateExpression="SET runtimeState = :s",
        ExpressionAttributeValues={":s": "SLEEPING"},
    )
    notify_ready["ecs"].desired = 0
    elb = notify_ready["elb"]
    elb.set_response("describe_target_groups", {"TargetGroups": [{"TargetGroupArn": "arn:tg:app"}]})
    elb.set_response("describe_rules", {"Rules": [_rule("arn:tg:app")]})

    res = dn.handle(_build_event("FAILED"))
    assert res["status"] == "FAILED"
    assert res["failureCategory"] == "DEPLOY_FAILED"
    mods = elb.calls_for("modify_rule")
    assert len(mods) == 1
    assert mods[0]["Actions"][0]["Type"] == "authenticate-cognito"  # 인증 액션 보존
    assert mods[0]["Actions"][1]["TargetGroupArn"] == "arn:tg:waker"
    assert res["afterFailure"]["sleep"]["ruleSwitched"] is True
    assert "afterSuccess" not in res
    # 실패 배포 → 시크릿 JSON 그대로(정리 안 함).
    assert notify_ready["sm"].json_of(SECRET_NAME) == {"A": VALUE_A, "OLD": VALUE_B, "GONE": "v-gone"}


def test_n2_running_app_untouched_after_failed_runtime_build(notify_ready) -> None:
    res = dn.handle(_build_event("FAILED"))
    assert res["afterFailure"]["sleep"] == {"reason": "runtime-RUNNING"}
    assert notify_ready["elb"].calls_for("modify_rule") == []
    assert notify_ready["ecs"].calls_for("update_service") == []
