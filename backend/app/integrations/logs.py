"""로그 프록시 (앱 상세 "로그 뷰어", QA M6/A5 2026-10-08).

두 종류:
  1) 앱 실행 로그 — runtime 스택이 만드는 로그 그룹 `/apphub/{stage}/app/{appId}`(태스크별 스트림 여러 개).
     FilterLogEvents 는 시간 **오름차순**으로만 읽으므로, 조회 창(기본 최근 1시간)의 **끝(지금)부터** 거꾸로
     구간을 넓혀 가며(밀하면 좁혀서) 끝까지 빠짐없이 읽힌 연속 구간 [lo, 지금] 만 모은다(_scan_latest, QA F1).
     그중 **가장 최근 limit 건**을 **시간 내림차순**으로 돌려준다 — 호출 상한에 걸려도 "창 앞부분"을 최신으로
     착각하지 않는다.
     더 오래된 페이지는 서버가 만드는 불투명 nextToken(창 [start, 반환한 가장 오래된 시각] + 중복 제외 개수)으로
     이어 읽는다 — 클라이언트는 받은 nextToken 을 그대로 다시 보내기만 한다.
  2) 배포(CodeBuild) 로그 — 빌드 1건 = 스트림 1개. GetLogEvents(startFromHead=False)로 최신 limit 건을 읽고
     nextBackwardToken 을 그대로 nextToken 으로 전달(더 오래된 페이지). 응답은 시간 내림차순.

예외 매핑: 로그 그룹/스트림 없음(ResourceNotFoundException) → events:[] (호출부 200).
          잘못된 토큰·파라미터(InvalidParameterException) → LogQueryInvalid(호출부 400 VALIDATION_ERROR).
          호출 한도 초과(ThrottlingException) → LogQueryThrottled(호출부 429 RATE_LIMITED, QA F2).
IAM: logs:FilterLogEvents/GetLogEvents on `/apphub/{stage}/app/*`(빌드 로그 `/apphub/{stage}/app/{appId}/build` 포함),
     `/apphub/{stage}/provisioner`(provisioner 빌드) — platform-stack AppLogsFilter / ProvisionerLogsRead.
"""

from __future__ import annotations

import base64
import binascii
import json
import time
from typing import Any

from ..config import load_config
from .clients import client

# 앱 로그 기본 조회 창(startTime 미지정 시) — 최근 1시간.
DEFAULT_WINDOW_MS = 60 * 60 * 1000
# 앱 로그 창 스캔 시 FilterLogEvents 호출 상한(호출당 최대 10,000건/1MB). 무거운 스캔 방지.
_MAX_FILTER_CALLS = 10
_FILTER_PAGE_LIMIT = 10_000
# probe(끝에서부터의 한 구간) 하나에 허용하는 페이지 수 — 넘으면 구간을 줄여 다시.
_PROBE_PAGES = 2
# 스캔 시간 상한(초) — API Lambda 29s 안에서 응답 직렬화 여유를 남긴다.
_SCAN_SECONDS = 15.0
_THROTTLE_CODES = frozenset({"ThrottlingException", "TooManyRequestsException", "Throttling"})


class LogQueryInvalid(Exception):
    """잘못된 nextToken/파라미터(사용자 입력 문제) — 핸들러가 400 VALIDATION_ERROR 로 변환."""


class LogQueryThrottled(Exception):
    """CloudWatch Logs 호출 한도 초과(ThrottlingException) — 핸들러가 429 RATE_LIMITED 로 변환."""


def app_log_group_name(stage: str, app_id: str) -> str:
    return f"/apphub/{stage}/app/{app_id}"


def _error_code(err: BaseException) -> str:
    response = getattr(err, "response", None) or {}
    return str((response.get("Error") or {}).get("Code") or type(err).__name__)


def _event(e: dict[str, Any]) -> dict[str, Any]:
    return {"timestamp": int(e.get("timestamp") or 0), "message": e.get("message", "")}


# ── 앱 실행 로그 ──────────────────────────────────────────────────────────────


def _encode_cursor(start: int, end: int, skip: int) -> str:
    raw = json.dumps({"s": start, "e": end, "k": skip}, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(token: str) -> tuple[int, int, int]:
    try:
        padded = token + "=" * (-len(token) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
        start, end, skip = data["s"], data["e"], data["k"]
    except (ValueError, KeyError, TypeError, binascii.Error, UnicodeDecodeError) as err:
        raise LogQueryInvalid("bad-token") from err
    if not all(isinstance(v, int) and not isinstance(v, bool) for v in (start, end, skip)):
        raise LogQueryInvalid("bad-token")
    if start < 0 or end < start or skip < 0:
        raise LogQueryInvalid("bad-token")
    return start, end, skip


class _ProbeResult:
    """FilterLogEvents 로 [lo, hi] 를 읽은 결과. complete=False 면 페이지 상한에 걸려 앞부분만 읽음."""

    __slots__ = ("calls", "complete", "events")

    def __init__(self, events: list[dict[str, Any]], complete: bool, calls: int) -> None:
        self.events = events
        self.complete = complete
        self.calls = calls


def _probe(group: str, lo: int, hi: int, max_calls: int) -> _ProbeResult:
    """[lo, hi](양끝 포함)를 오름차순으로 최대 max_calls 페이지 읽는다."""
    events: list[dict[str, Any]] = []
    token: str | None = None
    calls = 0
    while calls < max_calls:
        call: dict[str, Any] = {
            "logGroupName": group,
            "startTime": lo,
            "endTime": hi,
            "limit": _FILTER_PAGE_LIMIT,
        }
        if token:
            call["nextToken"] = token
        res = client("logs").filter_log_events(**call)
        calls += 1
        events.extend(_event(e) for e in res.get("events") or [])
        new_token = res.get("nextToken")
        if not new_token or new_token == token:
            return _ProbeResult(events, True, calls)
        token = new_token
    return _ProbeResult(events, False, calls)


def _shrink(width: int, probe_lo: int, hi: int, read: list[dict[str, Any]]) -> int:
    """capped probe 다음 너비. 최소 ½, 최대 1/16 로 줄인다.

    - 밀도 추정: 읽은 부분(probe_lo ~ 마지막 읽은 시각)이 페이지 상한만큼이었으므로 그 폭의 ½ 이면
      다음 probe 가 상한 안에 들 가능성이 높다(고르게 많은 로그 → 빠르게 수렴).
    - 단 1/16 아래로는 한 번에 줄이지 않는다 — 창 앞쪽에만 몰린 폭주(burst)로 밀도를 과대 추정해
      끝쪽(최신) 구간을 지나치게 잘게 쪼개지 않도록.
    - 읽지 못한 꼬리(마지막 읽은 시각 이후 ~ hi)보다 넓을 필요는 없다.
    """
    if not read:
        return max(1, width // 2)
    t_last = max(e["timestamp"] for e in read)
    density_guess = (t_last - probe_lo + 1) // 2
    return max(1, min(width // 2, hi - t_last, max(density_guess, width // 16)))


def _scan_latest(
    group: str, start: int, end: int, need: int, deadline: float
) -> tuple[list[dict[str, Any]], int, bool]:
    """창 [start, end] 의 **끝(최신)부터** 연속 구간 [lo, end] 를 빠짐없이 읽어 need 건 이상 모은다.

    반환 (events 오름차순, lo, exact). exact=True 면 events 는 [lo, end] 의 전부(정확).
    FilterLogEvents 는 startTime 부터 오름차순으로만 주므로, 끝에서부터 너비 w 인 구간을 probe 한다:
      - probe 가 끝까지 읽히면(complete) 그 구간은 확정 → 모은 건수가 모자라면 더 과거 구간(너비 2배)으로.
      - 페이지 상한에 걸리면(capped) 그 구간은 버리고 너비를 줄여 같은 끝에서 다시(_shrink).
    호출 수 상한(_MAX_FILTER_CALLS)·시간 상한(deadline) 안에서 끝낸다.
    """
    collected: list[dict[str, Any]] = []  # 오름차순, 항상 [lo, end] 전부
    hi = end
    lo = end + 1  # 아직 확정 구간 없음
    width = end - start + 1  # 첫 probe = 창 전체(보통 1회로 끝남 — startTime 을 준 폴링 포함)
    calls = 0
    last_capped: list[dict[str, Any]] = []
    while calls < _MAX_FILTER_CALLS and time.monotonic() < deadline:
        probe_lo = max(start, hi - width + 1)
        res = _probe(group, probe_lo, hi, min(_PROBE_PAGES, _MAX_FILTER_CALLS - calls))
        calls += res.calls
        if res.complete:
            collected = sorted(res.events, key=lambda e: e["timestamp"]) + collected
            lo = probe_lo
            if len(collected) >= need or lo <= start:
                return collected, lo, True
            hi = lo - 1
            width *= 2
            continue
        last_capped = res.events
        if width <= 1:
            break  # 1ms 에 페이지 상한 이상 — 더 줄일 수 없음
        width = _shrink(width, probe_lo, hi, res.events)
    if lo <= end:
        # 확정 구간 [lo, end] 만 돌려준다(정확 — 비어 있을 수도). 더 과거는 nextToken 으로 이어 읽는다.
        return collected, lo, True
    # 확정 구간이 하나도 없음(극단적 밀도·시간 상한) — 마지막 capped probe 의 읽은 부분(최신 근처 좁은 구간).
    print("[logs] filter scan capped", {"group": group, "start": start, "end": end})
    return sorted(last_capped, key=lambda e: e["timestamp"]), lo, False


def fetch_app_logs(
    app_id: str,
    limit: int = 100,
    next_token: str | None = None,
    start_time: int | None = None,
    now_ms: int | None = None,
) -> dict[str, Any]:
    """앱 실행 로그 최신 limit 건(시간 내림차순). 반환 {events, nextToken?}.

    창: nextToken 이 있으면 그 커서의 [s, e](e 시각 이벤트 중 이미 돌려준 k 건 제외),
        없으면 [startTime 또는 now-1h, now]. startTime 은 그 시각 **이상**만 읽는다(같은 ms 줄은 다시 올 수 있음
        — 프론트가 timestamp|message 로 중복 제거). 폴링이 마지막 수신 ts 를 주면 창이 좁아 보통 호출 1회.
    ThrottlingException → LogQueryThrottled(호출부 429 RATE_LIMITED).
    """
    cfg = load_config()
    group = app_log_group_name(cfg.stage, app_id)
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    skip = 0
    if next_token:
        start, end, skip = _decode_cursor(next_token)
    else:
        start = start_time if start_time is not None else now - DEFAULT_WINDOW_MS
        end = now
        if start > end:
            raise LogQueryInvalid("startTime-in-future")

    try:
        scanned, lo, exact = _scan_latest(
            group, start, end, need=limit + skip + 1, deadline=time.monotonic() + _SCAN_SECONDS
        )
    except Exception as err:  # noqa: BLE001 - AWS 예외 분류(없음=빈 결과, 잘못된 입력=400, 스로틀=429)
        code = _error_code(err)
        if code == "ResourceNotFoundException":
            return {"events": []}
        if code == "InvalidParameterException":
            raise LogQueryInvalid(code) from err
        if code in _THROTTLE_CODES:
            raise LogQueryThrottled(code) from err
        raise

    if skip and exact:
        # 이전 페이지가 돌려준 e 시각 이벤트(오름차순 끝쪽 skip 건)를 제외.
        tail_same = 0
        for e in reversed(scanned):
            if e["timestamp"] != end or tail_same >= skip:
                break
            tail_same += 1
        scanned = scanned[: len(scanned) - tail_same]

    page = scanned[-limit:] if limit > 0 else []
    result: dict[str, Any] = {"events": list(reversed(page))}
    if len(scanned) > len(page) and page:
        oldest = page[0]["timestamp"]
        same = sum(1 for e in page if e["timestamp"] == oldest)
        # 다음(더 오래된) 페이지: 창 끝을 oldest 로 당기고, oldest 시각 중 이번에 준 건수를 제외.
        carried = skip if oldest == end else 0
        result["nextToken"] = _encode_cursor(start, oldest, same + carried)
    elif exact and start < lo <= end:
        # 확정 구간을 다 줬지만 그보다 과거([start, lo-1])는 아직 안 읽음 → 거기서 이어 읽기.
        result["nextToken"] = _encode_cursor(start, lo - 1, 0)
    return result


# ── 배포(CodeBuild) 로그 ──────────────────────────────────────────────────────


def fetch_stream_logs(
    group: str, stream: str, limit: int = 200, next_token: str | None = None
) -> dict[str, Any]:
    """빌드 로그 스트림 1개의 최신 limit 건(시간 내림차순). nextToken = nextBackwardToken(더 오래된 쪽)."""
    params: dict[str, Any] = {
        "logGroupName": group,
        "logStreamName": stream,
        "limit": limit,
        "startFromHead": False,
    }
    if next_token:
        params["nextToken"] = next_token
    try:
        res = client("logs").get_log_events(**params)
    except Exception as err:  # noqa: BLE001
        code = _error_code(err)
        if code == "ResourceNotFoundException":
            return {"events": []}
        if code == "InvalidParameterException":
            raise LogQueryInvalid(code) from err
        if code in _THROTTLE_CODES:
            raise LogQueryThrottled(code) from err
        raise
    events = [_event(e) for e in res.get("events") or []]
    events.sort(key=lambda e: e["timestamp"], reverse=True)
    result: dict[str, Any] = {"events": events}
    backward = res.get("nextBackwardToken")
    # 끝에 도달하면 GetLogEvents 는 받은 토큰을 그대로 돌려준다 → 더 없음.
    if events and backward and backward != next_token:
        result["nextToken"] = backward
    return result
