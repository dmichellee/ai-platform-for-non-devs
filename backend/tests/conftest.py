"""pytest 공유 픽스처 — 테스트 env, moto DynamoDB 테이블, API GW proxy 이벤트 빌더, stub 클라이언트.

- DynamoDB: moto(@mock_aws)로 실제 단일 테이블(GSI1/GSI2)을 만들어 data 계층을 통합 검증.
- SFN/Cognito/CloudWatch Logs/CodeConnections: 결정적 검증을 위해 stub 클라이언트를 주입
  (integrations.clients.set_client). 호출 기록을 캡처해 인가/상태전이/멱등을 단언한다.
"""

from __future__ import annotations

import json
from typing import Any

import boto3
import pytest
from moto import mock_aws

TABLE_NAME = "apphub-test-main"
ALLOWED_ORIGINS = "https://d111111abcdef8.cloudfront.net,http://localhost:5173"


@pytest.fixture(autouse=True)
def _test_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """loadConfig 가 요구하는 env + moto 안전용 AWS 자격/리전."""
    monkeypatch.setenv("TABLE_NAME", TABLE_NAME)
    monkeypatch.setenv("USER_POOL_ID", "ap-northeast-2_TEST")
    monkeypatch.setenv("USER_POOL_CLIENT_ID", "testclient")
    monkeypatch.setenv("STAGE", "test")
    monkeypatch.setenv("APPS_DOMAIN", "apps.example.com")
    monkeypatch.setenv(
        "PROVISION_SM_ARN",
        "arn:aws:states:ap-northeast-2:111122223333:stateMachine:apphub-test-provision-app",
    )
    monkeypatch.setenv(
        "DELETE_SM_ARN",
        "arn:aws:states:ap-northeast-2:111122223333:stateMachine:apphub-test-delete-app",
    )
    monkeypatch.setenv("ALLOWED_ORIGINS", ALLOWED_ORIGINS)
    monkeypatch.setenv("AWS_DEFAULT_REGION", "ap-northeast-2")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "testing")


@pytest.fixture
def ddb_table():
    """moto 로 단일 테이블 생성(PK/SK + GSI1 ownerId/SK + GSI2 status/SK). 매 테스트 격리."""
    from app.data import client as data_client
    from app.integrations import clients as integ_clients
    from app.integrations import ssm as ssm_module

    with mock_aws():
        resource = boto3.resource("dynamodb", region_name="ap-northeast-2")
        table = resource.create_table(
            TableName=TABLE_NAME,
            KeySchema=[
                {"AttributeName": "PK", "KeyType": "HASH"},
                {"AttributeName": "SK", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "PK", "AttributeType": "S"},
                {"AttributeName": "SK", "AttributeType": "S"},
                {"AttributeName": "ownerId", "AttributeType": "S"},
                {"AttributeName": "status", "AttributeType": "S"},
            ],
            GlobalSecondaryIndexes=[
                {
                    "IndexName": "GSI1",
                    "KeySchema": [
                        {"AttributeName": "ownerId", "KeyType": "HASH"},
                        {"AttributeName": "SK", "KeyType": "RANGE"},
                    ],
                    "Projection": {"ProjectionType": "ALL"},
                },
                {
                    "IndexName": "GSI2",
                    "KeySchema": [
                        {"AttributeName": "status", "KeyType": "HASH"},
                        {"AttributeName": "SK", "KeyType": "RANGE"},
                    ],
                    "Projection": {"ProjectionType": "ALL"},
                },
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        table.wait_until_exists()
        # 모듈 캐시 초기화 — 새 moto 리소스를 쓰도록.
        data_client.reset_client_cache()
        integ_clients.reset_clients()
        ssm_module.reset_cache()
        yield table
        data_client.reset_client_cache()
        integ_clients.reset_clients()
        ssm_module.reset_cache()


class StubClient:
    """호출을 기록하는 stub boto3 클라이언트. 지정 메서드는 준비된 응답을 반환하고 나머지는 {}."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self._responses: dict[str, Any] = {}
        self._raisers: dict[str, Exception] = {}

    def set_response(self, method: str, response: Any) -> None:
        self._responses[method] = response

    def set_raise(self, method: str, err: Exception) -> None:
        self._raisers[method] = err

    def calls_for(self, method: str) -> list[dict[str, Any]]:
        return [params for name, params in self.calls if name == method]

    def __getattr__(self, method: str):
        def _call(**kwargs: Any) -> Any:
            self.calls.append((method, kwargs))
            if method in self._raisers:
                raise self._raisers[method]
            return self._responses.get(method, {})

        return _call


@pytest.fixture
def stub_clients():
    """SFN/Cognito/Logs/CodeConnections stub 클라이언트를 주입하고 핸들에 접근하게 한다."""
    from app.integrations import clients as integ_clients

    stubs: dict[str, StubClient] = {}
    for service in ("stepfunctions", "cognito-idp", "logs", "codeconnections"):
        stub = StubClient()
        stubs[service] = stub
        integ_clients.set_client(service, stub)
    # SFN start_execution 기본 성공 응답.
    stubs["stepfunctions"].set_response("start_execution", {"executionArn": "arn:exec"})
    yield stubs


class SsmStub:
    """파라미터명 → 값 맵으로 get_parameter 를 흉내내는 SSM stub(호출 기록 포함)."""

    def __init__(self, params: dict[str, str] | None = None) -> None:
        self.params: dict[str, str] = dict(params or {})
        self.calls: list[dict[str, Any]] = []

    def set_param(self, name: str, value: str) -> None:
        self.params[name] = value

    def get_parameter(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        name = kwargs["Name"]
        if name not in self.params:
            raise KeyError(f"SsmStub: 미설정 파라미터 {name}")
        return {"Parameter": {"Name": name, "Value": self.params[name]}}


@pytest.fixture
def p2_clients():
    """P2(SFN task + Waker) stub 클라이언트. AWS 제어면(CodeBuild/CodePipeline/CFN/SM/SSM/ECS/ELBv2)."""
    from app.integrations import clients as integ_clients
    from app.integrations import ssm as ssm_module

    ssm_module.reset_cache()
    stubs: dict[str, StubClient] = {}
    for service in (
        "codebuild",
        "codepipeline",
        "cloudformation",
        "secretsmanager",
        "ssm",
        "ecs",
        "elbv2",
    ):
        stub = StubClient()
        stubs[service] = stub
        integ_clients.set_client(service, stub)
    yield stubs
    ssm_module.reset_cache()


# ── API GW proxy 이벤트 빌더 ──────────────────────────────────────────────────


def make_event(
    method: str,
    path: str,
    user_id: str | None = None,
    groups: list[str] | None = None,
    body: Any = None,
    query: dict[str, str] | None = None,
    origin: str | None = None,
    email: str | None = None,
) -> dict[str, Any]:
    """`/{proxy+}` 통합 이벤트. pathParameters.proxy 에 경로를 넣는다(라우터 우선 사용)."""
    claims: dict[str, Any] = {}
    if user_id is not None:
        claims["sub"] = user_id
    if groups is not None:
        claims["cognito:groups"] = groups
    if email is not None:
        claims["email"] = email

    headers: dict[str, str] = {}
    if origin is not None:
        headers["Origin"] = origin

    return {
        "httpMethod": method,
        "path": path,
        "pathParameters": {"proxy": path.lstrip("/")},
        "queryStringParameters": query,
        "body": None if body is None else json.dumps(body),
        "headers": headers,
        "requestContext": {"authorizer": {"claims": claims}},
    }


def parse_result(res: dict[str, Any]) -> dict[str, Any]:
    """프록시 응답을 status/headers/data/error 로 분해."""
    body = json.loads(res["body"]) if res.get("body") else {}
    out: dict[str, Any] = {
        "status": res["statusCode"],
        "headers": dict(res.get("headers") or {}),
    }
    if "data" in body:
        out["data"] = body["data"]
    if "error" in body:
        out["error"] = body["error"]
    return out


# 시드 헬퍼 — data 계층을 통해 직접 아이템을 넣는다(핸들러 밖 셋업).


def seed_settings(table, **overrides: Any) -> None:
    item = {
        "PK": "CONFIG",
        "SK": "SETTINGS",
        "entityType": "AdminSettings",
        "enabledProviders": ["codecommit", "github"],
        "registeredVpcs": [{"vpcId": "vpc-123", "label": "기본"}],
        "userAppQuota": 3,
        "allowInternetFacing": True,
        "allowedBaseImages": [],
        "logRetentionDays": 30,
        "updatedAt": "2026-01-01T00:00:00.000Z",
    }
    item.update(overrides)
    table.put_item(Item=item)


def seed_preset(table, preset_id: str = "small") -> None:
    table.put_item(
        Item={
            "PK": "CONFIG",
            "SK": f"PRESET#{preset_id}",
            "entityType": "ComputePreset",
            "presetId": preset_id,
            "displayName": "작게",
            "cpu": 256,
            "memory": 512,
            "minCount": 1,
            "maxCount": 2,
            "scaleMetric": "cpu",
            "scaleThreshold": 70,
        }
    )


def seed_perm(table, perm_id: str = "basic") -> None:
    table.put_item(
        Item={
            "PK": "CONFIG",
            "SK": f"PERM#{perm_id}",
            "entityType": "PermissionTemplate",
            "permId": perm_id,
            "displayName": "기본",
            "policyDocument": {"Version": "2012-10-17", "Statement": []},
        }
    )


def seed_app(table, app_id: str, owner_id: str, status: str = "ACTIVE", **overrides: Any) -> None:
    item = {
        "PK": f"APP#{app_id}",
        "SK": "META",
        "entityType": "App",
        "appId": app_id,
        "ownerId": owner_id,
        "name": "A",
        "subdomain": "a-app",
        "provider": "codecommit",
        "repoUrl": "r",
        "branch": "main",
        "presetId": "small",
        "permissionTemplateId": "basic",
        "scheme": "internal",
        "vpcId": "vpc-123",
        "autoDeployEnabled": True,
        "sleepMode": "on-demand",
        "envVars": {},
        "secretArns": {},
        "status": status,
        "runtimeState": "RUNNING",
        "cognitoProtect": False,
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:00.000Z",
    }
    item.update(overrides)
    table.put_item(Item=item)
