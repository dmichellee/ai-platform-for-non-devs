"""boto3 클라이언트 지연 생성·캐시.

모듈 임포트 시점이 아니라 최초 호출 시 생성한다 — 테스트에서 stubber/moto 컨텍스트 진입 후
생성되도록. 서비스별 단일 캐시. reset_clients()로 테스트 간 초기화.
"""

from __future__ import annotations

from typing import Any

import boto3

_clients: dict[str, Any] = {}


def client(service: str) -> Any:
    cached = _clients.get(service)
    if cached is None:
        cached = boto3.client(service)
        _clients[service] = cached
    return cached


def set_client(service: str, value: Any) -> None:
    """테스트에서 stub 클라이언트를 주입한다."""
    _clients[service] = value


def reset_clients() -> None:
    _clients.clear()
