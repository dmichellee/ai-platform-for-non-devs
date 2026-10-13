"""레포 연결 (D4, "레포 연결 관리").

- github/gitlab: CodeConnections OAuth 흐름. 생성 → PENDING(외부 승인 대기) → AVAILABLE.
- codecommit: 외부 연동 없이 즉시 사용 가능 → CodeConnections 미사용, 가상 식별자(핸들러 처리).

IAM(platform-stack, connection ARN 범위): CreateConnection, GetConnection, DeleteConnection, ListConnections.
"""

from __future__ import annotations

from typing import Any

from ..config import load_config
from .clients import client

_PROVIDER_TYPE = {"github": "GitHub", "gitlab": "GitLab"}


def _map_status(raw: str | None) -> str:
    if raw == "AVAILABLE":
        return "AVAILABLE"
    if raw == "ERROR":
        return "ERROR"
    return "PENDING"


def create_provider_connection(provider: str, display_name: str) -> dict[str, Any]:
    """github/gitlab CodeConnections 생성. codecommit은 호출부에서 별도 처리(여기 미사용)."""
    cfg = load_config()
    res = client("codeconnections").create_connection(
        ConnectionName=f"apphub-{cfg.stage}-{display_name}"[:32],
        ProviderType=_PROVIDER_TYPE[provider],
    )
    # 생성 직후 연결은 항상 PENDING(외부 OAuth 승인 대기).
    return {
        "connectionArn": res.get("ConnectionArn", ""),
        "status": "PENDING",
        "needsAuthorization": True,
    }


def refresh_connection_status(connection_arn: str) -> str:
    """연결 상태 최신화(PENDING → AVAILABLE 반영)."""
    res = client("codeconnections").get_connection(ConnectionArn=connection_arn)
    return _map_status((res.get("Connection") or {}).get("ConnectionStatus"))


def delete_provider_connection(connection_arn: str) -> None:
    client("codeconnections").delete_connection(ConnectionArn=connection_arn)
