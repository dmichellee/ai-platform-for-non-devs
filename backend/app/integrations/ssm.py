"""SSM Parameter 조회 + 캐시 (stack-outputs.md §I).

network/platform SSM 파라미터를 실행 시점에 읽는다. 값이 배포 후 불변이므로 프로세스 캐시(멱등).
경로 규약: `/apphub/{stage}/{network|platform}/{key}` (stack-outputs.md).
"""

from __future__ import annotations

from .clients import client

_cache: dict[str, str] = {}


def reset_cache() -> None:
    """테스트 간 캐시 초기화."""
    _cache.clear()


def get_param(name: str) -> str:
    cached = _cache.get(name)
    if cached is not None:
        return cached
    res = client("ssm").get_parameter(Name=name)
    value = (res.get("Parameter") or {}).get("Value")
    if value is None:
        raise RuntimeError(f"SSM 파라미터 값이 없습니다: {name}")
    _cache[name] = value
    return value


def network_param(stage: str, key: str) -> str:
    return get_param(f"/apphub/{stage}/network/{key}")


def platform_param(stage: str, key: str) -> str:
    return get_param(f"/apphub/{stage}/platform/{key}")


def alb_arn_for_scheme(stage: str, scheme: str) -> str:
    """scheme 에 따른 공유 ALB ARN (internal-alb-arn / internet-alb-arn)."""
    key = "internal-alb-arn" if scheme == "internal" else "internet-alb-arn"
    return network_param(stage, key)


def listener_arn_for_scheme(stage: str, scheme: str) -> str:
    """scheme 에 따른 HTTPS(443) 리스너 ARN (Waker/복원/잠자기 규칙 전환 대상)."""
    key = (
        "internal-https-listener-arn" if scheme == "internal" else "internet-https-listener-arn"
    )
    return network_param(stage, key)
