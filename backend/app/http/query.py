"""쿼리 문자열 정수 파라미터 검증 (QA A6/M6 — 범위 밖·형식 오류는 500 대신 400 VALIDATION_ERROR)."""

from __future__ import annotations

from .errors import errors


def int_param(
    query: dict[str, str],
    name: str,
    *,
    default: int | None,
    minimum: int | None = None,
    maximum: int | None = None,
    label: str | None = None,
) -> int | None:
    """query[name] 을 정수로. 없으면/빈 값이면 default. 정수가 아니거나 범위 밖이면 400."""
    raw = query.get(name)
    if raw is None or raw.strip() == "":
        return default
    shown = label or name
    try:
        value = int(raw.strip())
    except ValueError as err:
        raise errors.validation(f"{shown} 값은 숫자여야 해요.") from err
    if (minimum is not None and value < minimum) or (maximum is not None and value > maximum):
        if minimum is not None and maximum is not None:
            raise errors.validation(f"{shown} 값은 {minimum}~{maximum} 사이여야 해요.")
        if minimum is not None:
            raise errors.validation(f"{shown} 값은 {minimum} 이상이어야 해요.")
        raise errors.validation(f"{shown} 값은 {maximum} 이하여야 해요.")
    return value
