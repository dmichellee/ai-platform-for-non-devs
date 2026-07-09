"""런타임 환경변수 접근 (platform-stack이 apphub-{stage}-api 함수에 주입 — stack-outputs.md §3.3).

테스트에서는 os.environ으로 주입해 검증한다. 요청 처리 시점에 읽는다(콜드 스타트 후 재사용).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


@dataclass(frozen=True)
class AppConfig:
    table_name: str
    user_pool_id: str
    user_pool_client_id: str
    stage: str
    apps_domain: str
    provision_sm_arn: str
    delete_sm_arn: str
    # CORS 허용 origin 목록(콤마 구분 ALLOWED_ORIGINS 를 파싱). 선택적 — 미주입 시 빈 목록.
    # 실제 CORS 헤더 주입은 app/http/cors.py 가 env 를 직접 읽어 수행하며, 여기 값은 참조/문서용.
    allowed_origins: list[str] = field(default_factory=list)


def _req(name: str) -> str:
    value = os.environ.get(name)
    if value is None or value == "":
        raise RuntimeError(f"필수 환경변수 누락: {name}")
    return value


def _opt_list(name: str) -> list[str]:
    """콤마 구분 env 를 정규화 목록으로. 미설정이면 빈 목록(선택적 env)."""
    raw = os.environ.get(name)
    if not raw:
        return []
    return [item for item in (segment.strip().rstrip("/") for segment in raw.split(",")) if item]


def load_config() -> AppConfig:
    return AppConfig(
        table_name=_req("TABLE_NAME"),
        user_pool_id=_req("USER_POOL_ID"),
        user_pool_client_id=_req("USER_POOL_CLIENT_ID"),
        stage=_req("STAGE"),
        apps_domain=_req("APPS_DOMAIN"),
        provision_sm_arn=_req("PROVISION_SM_ARN"),
        delete_sm_arn=_req("DELETE_SM_ARN"),
        allowed_origins=_opt_list("ALLOWED_ORIGINS"),
    )
