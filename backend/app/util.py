"""공유 유틸 (프레임워크 없음, 순수 표준 라이브러리)."""

from __future__ import annotations

from datetime import datetime, timezone


def now_iso() -> str:
    """TS Date().toISOString() 과 동형: 밀리초 3자리 + 'Z' (예: 2026-01-02T03:04:05.678Z)."""
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
