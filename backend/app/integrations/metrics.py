"""앱 모니터링 메트릭 (앱 상세 "모니터링" 탭).

CloudWatch GetMetricData 배치 1회로 접속량(requests)·CPU·메모리 시계열을 수집한다.
무거운 처리를 하지 않는다("메인 서버 무부하") — 단일 GetMetricData 호출로 3지표를 함께 받는다.

지표/차원 (app-runtime construct 의 유휴 알람·요청 스케일링과 동일 조합):
 - requests: ALB `RequestCountPerTarget`(Sum)
     차원 TargetGroup=<TG full-name>, LoadBalancer=<ALB full-name>
     (유휴 알람 idleMetric 과 완전히 동일한 dimensionsMap — app-runtime.ts IdleAlarm)
 - cpu:      ECS/ContainerInsights 아님, `AWS/ECS` `CPUUtilization`(Average)
     차원 ClusterName=`apphub-{stage}-cluster`(공유, D18), ServiceName=`apphub-{stage}-app-{appId}`
 - memory:   `AWS/ECS` `MemoryUtilization`(Average) — 동일 차원

full-name 조립:
 - TG full-name(`targetgroup/name/id`)은 App 레코드에 저장하지 않으므로 이름 규약
   (`apphub-{stage}-app-{appId}`, 32자 절단 — app-runtime.ts Tg 와 동일)으로 DescribeTargetGroups
   조회 후 반환 ARN 의 리소스 부분에서 유도한다(runtime 스택 조회 불필요).
 - ALB full-name(`app/name/id`)은 network SSM `internet-alb-full-name`/`internal-alb-full-name`.
   scheme(internet-facing/internal)으로 선택한다.

앱이 잠자는 중(태스크 0)이면 데이터 포인트가 없어 빈 시계열이 정상 — 프론트가 "잠자는 중" 안내.
IAM: cloudwatch:GetMetricData(리소스 레벨 미지원 → `*`), elasticloadbalancing:DescribeTargetGroups.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from ..config import load_config
from ..integrations.ssm import network_param
from ..wake.target_group import app_target_group_name
from .clients import client

# range → (조회 구간, period 초). period 는 데이터 포인트 밀도(range 커질수록 성기게).
_RANGE_SPEC: dict[str, tuple[timedelta, int]] = {
    "1h": (timedelta(hours=1), 60),
    "6h": (timedelta(hours=6), 300),
    "24h": (timedelta(hours=24), 900),
    "7d": (timedelta(days=7), 3600),
}
DEFAULT_RANGE = "6h"
VALID_RANGES = tuple(_RANGE_SPEC.keys())


def normalize_range(raw: str | None) -> str:
    """유효 range 만 허용. 미지정/미지원 값은 기본(6h). (핸들러에서 명시적 검증도 수행)"""
    if raw in _RANGE_SPEC:
        return raw  # type: ignore[return-value]
    return DEFAULT_RANGE


def _tg_full_name(stage: str, app_id: str) -> str | None:
    """앱 TG full-name(`targetgroup/name/id`) 조회.

    이름 규약으로 DescribeTargetGroups 한 뒤 ARN 리소스 부분을 반환한다.
    TG 미생성/삭제(잠자기 전 초기·삭제 중) 시 None → requests 지표 조회를 건너뛴다.
    """
    name = app_target_group_name(stage, app_id)
    try:
        res = client("elbv2").describe_target_groups(Names=[name])
    except Exception:  # noqa: BLE001 - TargetGroupNotFound 등은 None 으로 흡수(빈 시계열)
        return None
    tgs = res.get("TargetGroups") or []
    if not tgs:
        return None
    arn = tgs[0].get("TargetGroupArn")
    return _full_name_from_arn(arn)


def _full_name_from_arn(arn: str | None) -> str | None:
    """ELBv2 TG ARN → CloudWatch `TargetGroupFullName`(리소스 부분 `targetgroup/name/id`).

    arn:aws:elasticloadbalancing:region:acct:targetgroup/name/id → targetgroup/name/id
    """
    if not arn or ":targetgroup/" not in arn:
        return None
    return arn.split(":", 5)[5]


def _alb_full_name(stage: str, scheme: str) -> str:
    """scheme 별 ALB full-name(`app/name/id`) — network SSM(유휴 알람과 동일 소스)."""
    key = "internal-alb-full-name" if scheme == "internal" else "internet-alb-full-name"
    return network_param(stage, key)


def _points(result: dict[str, Any]) -> list[dict[str, Any]]:
    """GetMetricData 결과 1건 → [{t: ISO8601, v: number}] (시간 오름차순)."""
    timestamps = result.get("Timestamps") or []
    values = result.get("Values") or []
    # CloudWatch 는 기본 내림차순(TimestampDescending) → 오름차순으로 뒤집어 프론트 차트 친화.
    pairs = sorted(zip(timestamps, values), key=lambda pv: pv[0])
    out: list[dict[str, Any]] = []
    for ts, val in pairs:
        iso = ts.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        out.append({"t": iso, "v": val})
    return out


def get_app_metrics(app: dict[str, Any], range_key: str) -> dict[str, Any]:
    """앱 모니터링 시계열 배치 수집.

    app: App 레코드(appId/scheme 사용). range_key: 정규화된 range(1h|6h|24h|7d).
    반환: {range, series:{requests, cpu, memory}} — 각 series 는 [{t,v}] (t=ISO8601, v=숫자).
    """
    cfg = load_config()
    stage = cfg.stage
    app_id = app["appId"]
    scheme = app.get("scheme", "internal")

    duration, period = _RANGE_SPEC[range_key]
    end = datetime.now(timezone.utc)
    start = end - duration

    # ECS 지표 차원(D18): stage 당 공유 클러스터 1개 위에 앱 서비스만 존재.
    # ClusterName 은 공유 클러스터, ServiceName 은 앱 서비스로 분리(더 이상 동일하지 않음).
    cluster_dim = f"apphub-{stage}-cluster"
    service_dim = f"apphub-{stage}-app-{app_id}"

    queries: list[dict[str, Any]] = []

    # requests: TG full-name 이 있을 때만(잠자기 전/삭제 중이면 TG 없음 → 빈 시계열).
    tg_full = _tg_full_name(stage, app_id)
    if tg_full is not None:
        alb_full = _alb_full_name(stage, scheme)
        queries.append(
            {
                "Id": "requests",
                "MetricStat": {
                    "Metric": {
                        "Namespace": "AWS/ApplicationELB",
                        "MetricName": "RequestCountPerTarget",
                        "Dimensions": [
                            {"Name": "TargetGroup", "Value": tg_full},
                            {"Name": "LoadBalancer", "Value": alb_full},
                        ],
                    },
                    "Period": period,
                    "Stat": "Sum",
                },
                "ReturnData": True,
            }
        )

    for metric_id, metric_name in (("cpu", "CPUUtilization"), ("memory", "MemoryUtilization")):
        queries.append(
            {
                "Id": metric_id,
                "MetricStat": {
                    "Metric": {
                        "Namespace": "AWS/ECS",
                        "MetricName": metric_name,
                        "Dimensions": [
                            {"Name": "ClusterName", "Value": cluster_dim},
                            {"Name": "ServiceName", "Value": service_dim},
                        ],
                    },
                    "Period": period,
                    "Stat": "Average",
                },
                "ReturnData": True,
            }
        )

    res = client("cloudwatch").get_metric_data(
        MetricDataQueries=queries,
        StartTime=start,
        EndTime=end,
        ScanBy="TimestampAscending",
    )

    by_id: dict[str, dict[str, Any]] = {
        r.get("Id"): r for r in (res.get("MetricDataResults") or [])
    }

    series = {
        "requests": _points(by_id.get("requests", {})),
        "cpu": _points(by_id.get("cpu", {})),
        "memory": _points(by_id.get("memory", {})),
    }
    return {"range": range_key, "series": series}
