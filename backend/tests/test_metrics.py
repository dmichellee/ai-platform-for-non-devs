"""L1 — 모니터링 메트릭(GET /apps/{id}/metrics).

검증 축(우선순위): 인가 경계(타인 앱 403 / 없음 404 / admin 통과), range 검증(기본 6h·미지원 400),
GetMetricData 배치 조립(3지표 1회·period·차원=유휴 알람과 동일 조합), 응답 shape(t=ISO8601·v=숫자),
잠자기(TG 없음) 시 requests 빈 시계열.

CloudWatch/ELBv2 는 stubber 대신 conftest 의 호출기록 StubClient 로 목킹(결정적·차원 단언).
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from app.handler import handler
from app.integrations import clients as integ_clients
from app.integrations import ssm as ssm_module

from .conftest import SsmStub, StubClient, make_event, parse_result, seed_app

OWNER = "user-alice"
OTHER = "user-bob"
ADMIN = "user-admin"
APP_ID = "app00001"
STAGE = "test"

# ECS 지표 차원(D18): 공유 클러스터 == apphub-{stage}-cluster,
# 서비스 == apphub-{stage}-app-{appId} (더 이상 동일하지 않음).
CLUSTER_DIM = f"apphub-{STAGE}-cluster"
SERVICE_DIM = f"apphub-{STAGE}-app-{APP_ID}"
# TG 이름 규약(32자 절단) → describe-target-groups 로 ARN 조회 → full-name 유도.
TG_ARN = f"arn:aws:elasticloadbalancing:ap-northeast-2:111122223333:targetgroup/apphub-{STAGE}-app-{APP_ID}/abc123def456"  # noqa: E501
TG_FULL = f"targetgroup/apphub-{STAGE}-app-{APP_ID}/abc123def456"
INTERNET_ALB_FULL = "app/apphub-test-net/aabbccddeeff0011"
INTERNAL_ALB_FULL = "app/apphub-test-int/1100ffeeddccbbaa"


@pytest.fixture
def metrics_clients():
    """cloudwatch/elbv2 StubClient + SsmStub(ALB full-name) 주입. 호출기록으로 차원/배치 단언."""
    ssm_module.reset_cache()
    cw = StubClient()
    elbv2 = StubClient()
    ssm = SsmStub(
        {
            f"/apphub/{STAGE}/network/internet-alb-full-name": INTERNET_ALB_FULL,
            f"/apphub/{STAGE}/network/internal-alb-full-name": INTERNAL_ALB_FULL,
        }
    )
    integ_clients.set_client("cloudwatch", cw)
    integ_clients.set_client("elbv2", elbv2)
    integ_clients.set_client("ssm", ssm)
    # 기본: TG 존재 + 3지표 데이터 포인트.
    elbv2.set_response("describe_target_groups", {"TargetGroups": [{"TargetGroupArn": TG_ARN}]})
    cw.set_response("get_metric_data", _metric_data_response())
    yield {"cloudwatch": cw, "elbv2": elbv2, "ssm": ssm}
    ssm_module.reset_cache()


def _metric_data_response():
    """CloudWatch 는 내림차순(TimestampDescending) 반환 가정 → 핸들러가 오름차순으로 뒤집는다."""
    t1 = datetime(2026, 7, 15, 10, 0, tzinfo=timezone.utc)
    t2 = datetime(2026, 7, 15, 10, 5, tzinfo=timezone.utc)
    return {
        "MetricDataResults": [
            {"Id": "requests", "Timestamps": [t2, t1], "Values": [7.0, 3.0]},
            {"Id": "cpu", "Timestamps": [t2, t1], "Values": [42.5, 40.0]},
            {"Id": "memory", "Timestamps": [t2, t1], "Values": [55.0, 50.0]},
        ]
    }


def _get(user_id, groups, query=None):
    return handler(
        make_event(
            "GET",
            f"/apps/{APP_ID}/metrics",
            user_id=user_id,
            groups=groups,
            query=query,
        )
    )


# ── 인가 경계 ─────────────────────────────────────────────────────────────────


def test_metrics_owner_ok(ddb_table, metrics_clients):
    seed_app(ddb_table, APP_ID, OWNER, status="ACTIVE", scheme="internet-facing")
    out = parse_result(_get(OWNER, ["user"]))
    assert out["status"] == 200
    assert out["data"]["range"] == "6h"
    assert set(out["data"]["series"].keys()) == {"requests", "cpu", "memory"}


def test_metrics_other_forbidden(ddb_table, metrics_clients):
    seed_app(ddb_table, APP_ID, OWNER, status="ACTIVE")
    out = parse_result(_get(OTHER, ["user"]))
    assert out["status"] == 403
    assert out["error"]["code"] == "FORBIDDEN"


def test_metrics_admin_ok_on_others_app(ddb_table, metrics_clients):
    seed_app(ddb_table, APP_ID, OWNER, status="ACTIVE")
    out = parse_result(_get(ADMIN, ["admin"]))
    assert out["status"] == 200


def test_metrics_missing_app_404(ddb_table, metrics_clients):
    out = parse_result(_get(OWNER, ["user"]))
    assert out["status"] == 404
    assert out["error"]["code"] == "NOT_FOUND"


# ── range 검증 ────────────────────────────────────────────────────────────────


def test_metrics_default_range_6h(ddb_table, metrics_clients):
    seed_app(ddb_table, APP_ID, OWNER, status="ACTIVE")
    out = parse_result(_get(OWNER, ["user"]))
    assert out["data"]["range"] == "6h"


@pytest.mark.parametrize(
    "range_key,period",
    [("1h", 60), ("6h", 300), ("24h", 900), ("7d", 3600)],
)
def test_metrics_range_period_mapping(ddb_table, metrics_clients, range_key, period):
    seed_app(ddb_table, APP_ID, OWNER, status="ACTIVE")
    out = parse_result(_get(OWNER, ["user"], query={"range": range_key}))
    assert out["status"] == 200
    assert out["data"]["range"] == range_key
    call = metrics_clients["cloudwatch"].calls_for("get_metric_data")[0]
    # 모든 쿼리의 Period 가 range 에 맞아야 한다.
    for q in call["MetricDataQueries"]:
        assert q["MetricStat"]["Period"] == period


def test_metrics_invalid_range_400(ddb_table, metrics_clients):
    seed_app(ddb_table, APP_ID, OWNER, status="ACTIVE")
    out = parse_result(_get(OWNER, ["user"], query={"range": "30m"}))
    assert out["status"] == 400
    assert out["error"]["code"] == "VALIDATION_ERROR"


# ── GetMetricData 배치 조립(차원·단일 호출) ─────────────────────────────────


def test_metrics_single_batch_three_queries(ddb_table, metrics_clients):
    seed_app(ddb_table, APP_ID, OWNER, status="ACTIVE", scheme="internet-facing")
    parse_result(_get(OWNER, ["user"]))
    calls = metrics_clients["cloudwatch"].calls_for("get_metric_data")
    assert len(calls) == 1  # 배치 1회
    ids = {q["Id"] for q in calls[0]["MetricDataQueries"]}
    assert ids == {"requests", "cpu", "memory"}


def test_metrics_dimensions_match_idle_alarm(ddb_table, metrics_clients):
    """requests 차원 = 유휴 알람과 동일(TG full-name + ALB full-name), scheme=internet → internet ALB."""
    seed_app(ddb_table, APP_ID, OWNER, status="ACTIVE", scheme="internet-facing")
    parse_result(_get(OWNER, ["user"]))
    q = _query_by_id(metrics_clients, "requests")
    metric = q["MetricStat"]["Metric"]
    assert metric["Namespace"] == "AWS/ApplicationELB"
    assert metric["MetricName"] == "RequestCountPerTarget"
    assert q["MetricStat"]["Stat"] == "Sum"
    dims = {d["Name"]: d["Value"] for d in metric["Dimensions"]}
    assert dims == {"TargetGroup": TG_FULL, "LoadBalancer": INTERNET_ALB_FULL}


def test_metrics_internal_scheme_selects_internal_alb(ddb_table, metrics_clients):
    seed_app(ddb_table, APP_ID, OWNER, status="ACTIVE", scheme="internal")
    parse_result(_get(OWNER, ["user"]))
    q = _query_by_id(metrics_clients, "requests")
    dims = {d["Name"]: d["Value"] for d in q["MetricStat"]["Metric"]["Dimensions"]}
    assert dims["LoadBalancer"] == INTERNAL_ALB_FULL


def test_metrics_ecs_dimensions_cluster_service(ddb_table, metrics_clients):
    """공유 클러스터(D18): ClusterName=공유 클러스터, ServiceName=앱 서비스 로 분리된 차원."""
    seed_app(ddb_table, APP_ID, OWNER, status="ACTIVE")
    parse_result(_get(OWNER, ["user"]))
    for metric_id, name in (("cpu", "CPUUtilization"), ("memory", "MemoryUtilization")):
        q = _query_by_id(metrics_clients, metric_id)
        metric = q["MetricStat"]["Metric"]
        assert metric["Namespace"] == "AWS/ECS"
        assert metric["MetricName"] == name
        assert q["MetricStat"]["Stat"] == "Average"
        dims = {d["Name"]: d["Value"] for d in metric["Dimensions"]}
        assert dims == {"ClusterName": CLUSTER_DIM, "ServiceName": SERVICE_DIM}


def test_metrics_describe_target_groups_by_name(ddb_table, metrics_clients):
    seed_app(ddb_table, APP_ID, OWNER, status="ACTIVE")
    parse_result(_get(OWNER, ["user"]))
    call = metrics_clients["elbv2"].calls_for("describe_target_groups")[0]
    assert call["Names"] == [f"apphub-{STAGE}-app-{APP_ID}"[:32]]


# ── 응답 shape ────────────────────────────────────────────────────────────────


def test_metrics_series_shape_iso_and_ascending(ddb_table, metrics_clients):
    seed_app(ddb_table, APP_ID, OWNER, status="ACTIVE")
    out = parse_result(_get(OWNER, ["user"]))
    cpu = out["data"]["series"]["cpu"]
    assert len(cpu) == 2
    # 각 포인트 {t: ISO8601 Z, v: number}.
    assert cpu[0]["t"] == "2026-07-15T10:00:00Z"
    assert cpu[1]["t"] == "2026-07-15T10:05:00Z"
    assert cpu[0]["v"] == 40.0 and cpu[1]["v"] == 42.5  # 오름차순 정렬
    # requests 값도 오름차순.
    reqs = out["data"]["series"]["requests"]
    assert [p["v"] for p in reqs] == [3.0, 7.0]


# ── 잠자기(TG 미생성) ─────────────────────────────────────────────────────────


def test_metrics_sleeping_no_tg_empty_requests(ddb_table, metrics_clients):
    """TG 없음(잠자기 전/삭제 중) → requests 쿼리 자체를 보내지 않고 빈 시계열. CPU/메모리는 유지."""
    seed_app(ddb_table, APP_ID, OWNER, status="ACTIVE")
    metrics_clients["elbv2"].set_response("describe_target_groups", {"TargetGroups": []})
    # requests 결과가 없어도 무방하도록 cw 응답을 cpu/memory 만으로 둔다.
    metrics_clients["cloudwatch"].set_response(
        "get_metric_data",
        {"MetricDataResults": [{"Id": "cpu", "Timestamps": [], "Values": []}]},
    )
    out = parse_result(_get(OWNER, ["user"]))
    assert out["status"] == 200
    assert out["data"]["series"]["requests"] == []
    # requests 쿼리는 배치에서 빠졌다(TG 없으므로).
    call = metrics_clients["cloudwatch"].calls_for("get_metric_data")[0]
    ids = {q["Id"] for q in call["MetricDataQueries"]}
    assert ids == {"cpu", "memory"}


def _query_by_id(metrics_clients, metric_id):
    call = metrics_clients["cloudwatch"].calls_for("get_metric_data")[0]
    for q in call["MetricDataQueries"]:
        if q["Id"] == metric_id:
            return q
    raise AssertionError(f"query {metric_id} 없음")
