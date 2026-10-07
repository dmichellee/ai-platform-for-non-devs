"""잠자기 Lambda — 유휴 알람 / 스케줄 EventBridge 트리거 (DESIGN.md 3.5, D-M5-03).

앱이 유휴하면: ECS desiredCount=0(멱등) + 리스너 규칙 forward 를 해당 ALB(App.albIndex)의
  Waker TG 로 전환(멱등, D20 — ALB마다 Waker TG 1개)
  + runtimeState=SLEEPING. always-on 앱은 잠자지 않는다.
appId 는 event.appId(직접 호출) 또는 알람명(`apphub-{stage}-app-{appId}-idle`)에서 파싱.

유휴 알람 고착 보정(2026-10-08, QA N5): 알람은 상태 *전이*에만 이벤트를 낸다. 앱이 CREATING 일 때 ALARM 으로
바뀌면 위 경로가 건너뛰고(status≠ACTIVE) 이후 재발화가 없어 영영 안 잠든다. 15분 스케줄이
`{"sweep": true}` 로 호출하면 ACTIVE·RUNNING·sleepMode≠always-on 앱의 유휴 알람 상태를 조회해
ALARM 인 앱만 일반 경로와 같은 sleep_app 으로 재운다.

스케줄 창 보호(2026-10-08, QA W-1 — DESIGN 3.5 "[재중지] 스케줄 밖 시간대에 한해"): 유휴 알람은
treatMissingData=BREACHING 이라 잠든 밤 동안 ALARM 에 고착된다. 그래서 sleepMode=schedule 앱이 지금
가동 시간대 안이면 유휴 경로(알람·스윕)는 재우지 않는다(reason "in-schedule-window").
ACTIVE 후 유예(2026-10-08, QA W-3 — DESIGN 3.5 "유휴 15분"): 유휴 알람은 CREATING 중(트래픽이 들어올 수
없는 구간)에 데이터 부재로 ALARM 이 되므로, ALARM 이 곧 "ACTIVE 후 15분 유휴"를 뜻하지 않는다(실측: ACTIVE
39초 뒤 스윕이 재움). 그래서 앱이 ACTIVE/RUNNING(또는 WAKING)이 된 시각부터 15분이 지나지 않았으면 유휴 경로
(알람·스윕)는 재우지 않는다(reason "grace-after-active"). 기준 시각 = App.runtimeStateUpdatedAt
(set_runtime_state·→ACTIVE 전이가 기록), 필드가 없는 기존 앱은 updatedAt 폴백. force·schedule_stop 은 무시.
트리거 구분(event 형식):
  - `{"sweep": true}`                      → 스윕(창 안 schedule 앱 제외)
  - `detail.alarmName` / `alarmData`        → 유휴 알람(창 판정 적용)
  - `{"appId": ...}` (알람 정보 없음)       → 스케줄 종료 시각 StopSchedule(app-runtime.ts) — 창 판정 생략.
    종료 시각 == now 경계에서 스킵되지 않도록 창 판정 자체를 건너뛴다. 명시 플래그
    `{"appId":..., "trigger": "schedule-stop"}` 도 같은 의미로 받는다(현행 Scheduler input 은 appId 만).
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from typing import Any

from ..data.apps import get_app, list_all_apps, set_runtime_state
from ..domain.schedule import is_within_schedule_window
from ..integrations.clients import client
from ..integrations.ssm import network_param
from . import stage
from .ecs_service import ensure_stopped
from .listener_rule import app_alb_routing, transition_listener_rule
from .target_group import find_app_target_group_arn


def app_id_from_sleep_event(event: dict[str, Any], stage_value: str) -> str | None:
    """event.appId(직접 호출) 우선, 없으면 CloudWatch 알람명에서 appId 파싱."""
    if event.get("appId"):
        return event["appId"]
    detail = event.get("detail") or {}
    alarm_data = event.get("alarmData") or {}
    alarm_name = detail.get("alarmName") or alarm_data.get("alarmName")
    if not alarm_name:
        return None
    match = re.match(rf"^apphub-{re.escape(stage_value)}-app-(.+)-idle$", alarm_name)
    return match.group(1) if match else None


def _now() -> datetime:
    """현재 시각(UTC, tz-aware). 테스트에서 monkeypatch 한다."""
    return datetime.now(UTC)


# 유휴 알람 판정 창(5분×3)과 같은 길이 — ACTIVE/RUNNING 직후 이 시간 동안은 유휴로 보지 않는다(QA W-3).
GRACE_AFTER_ACTIVE = timedelta(minutes=15)


def _parse_iso(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def in_grace_after_active(app: dict[str, Any], now: datetime) -> bool:
    """ACTIVE/RUNNING(WAKING) 이 된 지 15분 미만이면 True — 유휴 경로는 재우지 않는다(QA W-3).

    기준: runtimeStateUpdatedAt(없으면 updatedAt — 필드 도입 전 앱). SLEEPING 앱은 유예 없음(재수면 멱등 보정).
    기준 시각을 읽을 수 없으면 유예 없음(기존 동작).
    """
    if app.get("runtimeState") == "SLEEPING":
        return False
    since = _parse_iso(app.get("runtimeStateUpdatedAt")) or _parse_iso(app.get("updatedAt"))
    if since is None:
        return False
    return now - since < GRACE_AFTER_ACTIVE


def sleep_app(app_id: str, force: bool = False, schedule_stop: bool = False) -> dict[str, Any]:
    """앱을 잠재운다(멱등). ECS 정지 + 규칙 to=waker + SLEEPING.

    force=False(유휴/스케줄 트리거): always-on 앱은 잠들지 않는다(스킵).
      유휴 트리거(schedule_stop=False)는 sleepMode=schedule 앱이 가동 시간대 안이면 스킵(QA W-1).
      유휴 트리거는 ACTIVE/RUNNING 후 15분 미만이면 스킵(QA W-3, reason "grace-after-active").
    schedule_stop=True(스케줄 종료 시각 StopSchedule): 창·유예 판정 없이 재운다(always-on 은 여전히 스킵).
    force=True(관리자 강제 중지·배포 후 재수면, DESIGN 3.5): sleepMode·창·유예와 무관하게 재운다.
      (관리자가 명시적으로 멈추는 것이므로 always-on 도 대상.)
    """
    st = stage()
    app = get_app(app_id)
    if not app:
        return {"appId": app_id, "reason": "app-record-missing"}
    if app.get("status") != "ACTIVE":
        return {"appId": app_id, "reason": f"status-{app.get('status')}"}
    if not force and app.get("sleepMode") == "always-on":
        return {"appId": app_id, "reason": "always-on"}
    if not force and not schedule_stop:
        now = _now()
        if is_within_schedule_window(app, now):
            return {"appId": app_id, "reason": "in-schedule-window"}
        if in_grace_after_active(app, now):
            return {"appId": app_id, "reason": "grace-after-active"}
    stop = ensure_stopped(st, app_id)
    app_tg_arn = find_app_target_group_arn(st, app_id)
    # App.albIndex 기준 ALB(D20) — listener·waker TG 는 `/network/alb/{slug}/{n}/*`.
    routing = app_alb_routing(st, app)
    domain = network_param(st, "apps-domain")
    host = f"{app['subdomain']}.{domain}"
    rule_switched = False
    if app_tg_arn:
        res = transition_listener_rule(
            listener_arn=routing["listenerArn"],
            host=host,
            app_target_group_arn=app_tg_arn,
            waker_target_group_arn=routing["wakerTgArn"],
            to="waker",
            waker_target_group_aliases=routing["wakerAliases"],
        )
        rule_switched = res.get("changed", False)
    if app.get("runtimeState") != "SLEEPING":
        try:
            set_runtime_state(app_id, "SLEEPING")
        except Exception:  # noqa: BLE001
            pass
    return {"appId": app_id, "stopped": stop.get("changed", False), "ruleSwitched": rule_switched}


# DescribeAlarms AlarmNames 최대 100개(API 한도).
_ALARM_BATCH = 100


def idle_alarm_name(stage_value: str, app_id: str) -> str:
    """앱 유휴 알람명(app-runtime 소유, 규약 `apphub-{stage}-app-{appId}-idle`)."""
    return f"apphub-{stage_value}-app-{app_id}-idle"


def _alarm_states(names: list[str]) -> dict[str, str]:
    """알람명 → StateValue. 100개씩 나눠 조회하고 NextToken 을 끝까지 따른다. 없는 알람은 결과에 없음."""
    cw = client("cloudwatch")
    states: dict[str, str] = {}
    for start in range(0, len(names), _ALARM_BATCH):
        batch = names[start : start + _ALARM_BATCH]
        params: dict[str, Any] = {"AlarmNames": batch, "MaxRecords": _ALARM_BATCH}
        while True:
            res = cw.describe_alarms(**params)
            for alarm in res.get("MetricAlarms") or []:
                if alarm.get("AlarmName"):
                    states[alarm["AlarmName"]] = str(alarm.get("StateValue") or "")
            token = res.get("NextToken")
            if not token:
                break
            params = {**params, "NextToken": token}
    return states


def sweep(stage_value: str) -> dict[str, Any]:
    """유휴 알람이 ALARM 에 고착된 RUNNING 앱을 재운다(QA N5). 판정은 일반 경로와 동일(sleep_app).

    가동 시간대 안의 schedule 앱(QA W-1)과 ACTIVE/RUNNING 후 15분 미만 앱(QA W-3)은 후보에서 제외 —
    알람 조회 대상에도 넣지 않는다.
    """
    now = _now()
    candidates = [
        app
        for app in list_all_apps("ACTIVE")
        if app.get("sleepMode") != "always-on"
        and app.get("runtimeState") == "RUNNING"
        and not is_within_schedule_window(app, now)
        and not in_grace_after_active(app, now)
    ]
    by_alarm = {idle_alarm_name(stage_value, app["appId"]): app["appId"] for app in candidates}
    states = _alarm_states(list(by_alarm)) if by_alarm else {}
    slept: list[str] = []
    failed: list[str] = []
    for alarm_name, app_id in by_alarm.items():
        if states.get(alarm_name) != "ALARM":
            continue  # 알람 없음 / OK / INSUFFICIENT_DATA → 스킵
        try:
            res = sleep_app(app_id)
        except Exception as err:  # noqa: BLE001 - 한 앱 실패가 나머지 보정을 막지 않게
            print(
                "[sleep-transition] sweep sleep failed:", app_id, type(err).__name__, str(err)[:200]
            )
            failed.append(app_id)
            continue
        if "reason" not in res:
            slept.append(app_id)
    return {
        "sweep": True,
        "checked": len(candidates),
        "alarming": sum(1 for n in by_alarm if states.get(n) == "ALARM"),
        "slept": slept,
        "failed": failed,
    }


def handle(event: dict[str, Any], _context: Any = None) -> dict[str, Any]:
    st = stage()
    if event.get("sweep") is True:
        result = sweep(st)
        print("[sleep-transition] sweep", result)
        return result
    app_id = app_id_from_sleep_event(event, st)
    if not app_id:
        print("[sleep-transition] appId 없음:", event)
        return {"reason": "no-appId"}
    is_alarm = bool(event.get("detail") or event.get("alarmData"))
    schedule_stop = event.get("trigger") == "schedule-stop" or (
        bool(event.get("appId")) and not is_alarm
    )
    result = sleep_app(app_id, schedule_stop=schedule_stop)
    print(
        "[sleep-transition]",
        {**result, "trigger": "schedule-stop" if schedule_stop else "idle-alarm"},
    )
    return result
