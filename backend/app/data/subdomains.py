"""서브도메인 전역 유일성 (DESIGN.md 3.2).

App 아이템과 별개로 예약 아이템을 둔다: PK = SUBDOMAIN#{subdomain}, SK = RESERVATION.
조건부 쓰기(attribute_not_exists)로 원자적 유일성 보장. 앱 삭제 시 함께 해제.
GSI 스캔으로 유일성을 검사하면 경쟁 조건에 취약하므로 예약 아이템 방식을 쓴다.
"""

from __future__ import annotations

from botocore.exceptions import ClientError

from ..http.errors import errors
from ..util import now_iso
from .client import is_conditional_check_failed, table

_RESERVATION_SK = "RESERVATION"


def _subdomain_pk(subdomain: str) -> str:
    return f"SUBDOMAIN#{subdomain}"


def reserve_subdomain(subdomain: str, app_id: str) -> None:
    """서브도메인 예약. 이미 사용 중이면 SUBDOMAIN_TAKEN."""
    try:
        table().put_item(
            Item={
                "PK": _subdomain_pk(subdomain),
                "SK": _RESERVATION_SK,
                "entityType": "SubdomainReservation",
                "subdomain": subdomain,
                "appId": app_id,
                "createdAt": now_iso(),
            },
            ConditionExpression="attribute_not_exists(PK)",
        )
    except ClientError as err:
        if is_conditional_check_failed(err):
            raise errors.subdomain_taken() from err
        raise


def app_id_for_subdomain(subdomain: str) -> str | None:
    """서브도메인 예약 아이템에서 appId 조회 (wake-on-request: Host → 앱 식별)."""
    res = table().get_item(Key={"PK": _subdomain_pk(subdomain), "SK": _RESERVATION_SK})
    app_id = (res.get("Item") or {}).get("appId")
    return app_id if isinstance(app_id, str) else None


def release_subdomain(subdomain: str) -> None:
    """예약 해제(앱 삭제 시). 멱등 — 없어도 성공."""
    table().delete_item(Key={"PK": _subdomain_pk(subdomain), "SK": _RESERVATION_SK})
