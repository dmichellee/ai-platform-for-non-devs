"""wake-on-request — Waker / 복원 / 잠자기 (DESIGN.md 3.5, D-M5-02/03, D-M4-04).

잠자는 앱: 리스너 규칙 forward 대상을 공유 Waker TG 로 돌려 두고 ECS desiredCount=0.
요청이 오면 Waker Lambda 가 앱을 깨우고(desiredCount=min) 대기 페이지를 응답,
ECS 태스크가 RUNNING+healthy 가 되면 복원 Lambda 가 규칙 forward 를 앱 TG 로 되돌린다.

규칙 전환은 forward 대상만 교체(authenticate-cognito order1 유지) — 멱등(이미 목표 TG면 no-op).
"""

from __future__ import annotations

import os


def stage() -> str:
    """실행 stage. wake Lambda env 에 STAGE 주입(stack-outputs §I). 미주입 시 dev 폴백."""
    return os.environ.get("STAGE") or "dev"


def apps_domain() -> str | None:
    """앱 도메인. wake Lambda env 에 APPS_DOMAIN 주입(stack-outputs §I). Host 파싱 폴백에 쓰임."""
    return os.environ.get("APPS_DOMAIN")
