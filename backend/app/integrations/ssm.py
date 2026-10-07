"""SSM Parameter 조회 + 캐시 (stack-outputs.md §I).

network/platform SSM 파라미터를 실행 시점에 읽는다. 값이 배포 후 불변이므로 프로세스 캐시(멱등).
경로 규약: `/apphub/{stage}/{network|platform}/{key}` (stack-outputs.md).
ALB별 키(D20, 계약 delta §1.1): `/apphub/{stage}/network/alb/{schemeSlug}/{n}/{key}`.
"""

from __future__ import annotations

from botocore.exceptions import ClientError

from ..domain.alb_scheme import scheme_slug
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


# n=0 ALB 키의 구(scheme 고정) 키 — network 스택 재배포 전(신규 키 미발행) 마이그레이션 폴백.
#  (schemeSlug, key) → legacy network 키. 값은 신규 키와 동일(계약 §1.1·§1.2).
_LEGACY_N0_KEYS: dict[tuple[str, str], str] = {
    ("internet", "alb-arn"): "internet-alb-arn",
    ("internal", "alb-arn"): "internal-alb-arn",
    ("internet", "https-listener-arn"): "internet-https-listener-arn",
    ("internal", "https-listener-arn"): "internal-https-listener-arn",
    ("internet", "waker-tg-arn"): "waker-tg-arn",
}


def _is_not_found(err: BaseException) -> bool:
    if isinstance(err, KeyError):  # 테스트 SsmStub 의 미설정 파라미터
        return True
    return (
        isinstance(err, ClientError)
        and err.response.get("Error", {}).get("Code") == "ParameterNotFound"
    )


def alb_param_name(stage: str, scheme: str, index: int, key: str) -> str:
    """ALB별 SSM 파라미터 경로. scheme 은 DDB 값(internet-facing)·slug(internet) 모두 허용."""
    return f"/apphub/{stage}/network/alb/{scheme_slug(scheme)}/{int(index)}/{key}"


def alb_param(stage: str, scheme: str, index: int, key: str) -> str:
    """ALB(scheme, index)별 SSM 값(`/network/alb/{slug}/{n}/{key}`).

    n=0 이고 신규 키가 아직 없으면(network 재배포 전) 같은 값의 legacy 키로 폴백한다.
    """
    slug = scheme_slug(scheme)
    try:
        return get_param(alb_param_name(stage, slug, index, key))
    except Exception as err:  # noqa: BLE001 - not-found 만 폴백, 그 외 재전파
        legacy = _LEGACY_N0_KEYS.get((slug, key)) if int(index) == 0 else None
        if legacy is None or not _is_not_found(err):
            raise
        return network_param(stage, legacy)


def legacy_waker_tg_arn(stage: str) -> str | None:
    """legacy 공유 Waker TG(`network/waker-tg-arn`). 없으면 None(waker 판정 보조용, 계약 §1.2)."""
    try:
        return network_param(stage, "waker-tg-arn")
    except Exception as err:  # noqa: BLE001
        if _is_not_found(err):
            return None
        raise


def alb_arn_for_scheme(stage: str, scheme: str) -> str:
    """[호환용] scheme 에 따른 n=0 공유 ALB ARN (internal-alb-arn / internet-alb-arn). 신규 코드는 alb_param."""
    key = "internal-alb-arn" if scheme == "internal" else "internet-alb-arn"
    return network_param(stage, key)


def listener_arn_for_scheme(stage: str, scheme: str) -> str:
    """[호환용] scheme 에 따른 n=0 HTTPS(443) 리스너 ARN. 신규 코드는 alb_param(..., "https-listener-arn")."""
    key = (
        "internal-https-listener-arn" if scheme == "internal" else "internet-https-listener-arn"
    )
    return network_param(stage, key)
