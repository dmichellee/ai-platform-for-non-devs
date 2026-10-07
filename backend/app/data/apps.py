"""App 아이템 데이터 액세스 (DESIGN.md 4장).

App 도메인 모델은 dict(camelCase 키). 저장 시 PK/SK/entityType 를 붙이고,
조회 시 이 키들을 제거해 계약 응답 shape 로 되돌린다(strip_item).
상태 전이는 상태 기계(apphub-conventions 5장)만 허용 — 조건부 쓰기로 강제.
"""

from __future__ import annotations

from typing import Any

from boto3.dynamodb.conditions import Key

from ..util import now_iso as _now_iso
from .client import clean_item, is_conditional_check_failed, strip_item, table
from .keys import APP_META_SK, app_pk

_APP_DROP = ("PK", "SK", "entityType")


def _to_app(item: dict[str, Any] | None) -> dict[str, Any] | None:
    return strip_item(item, _APP_DROP)


def put_app(app_input: dict[str, Any]) -> dict[str, Any]:
    """App 생성. 조건: 같은 appId 미존재. 서브도메인 유일성은 reserve_subdomain 이 별도 보장."""
    now = _now_iso()
    app = {**app_input, "createdAt": now, "updatedAt": now}
    item = clean_item(
        {
            "PK": app_pk(app["appId"]),
            "SK": APP_META_SK,
            "entityType": "App",
            **app,
        }
    )
    table().put_item(Item=item, ConditionExpression="attribute_not_exists(PK)")
    return app


def get_app(app_id: str) -> dict[str, Any] | None:
    res = table().get_item(Key={"PK": app_pk(app_id), "SK": APP_META_SK})
    return _to_app(res.get("Item"))


def list_apps_by_owner(owner_id: str) -> list[dict[str, Any]]:
    """사용자별 앱 목록(GSI1: ownerId). App 메타만(SK=META) 필터."""
    res = table().query(
        IndexName="GSI1",
        KeyConditionExpression=Key("ownerId").eq(owner_id) & Key("SK").eq(APP_META_SK),
    )
    return [_to_app(i) for i in res.get("Items", [])]  # type: ignore[misc]


def count_apps_by_owner(owner_id: str) -> int:
    """사용자 앱 개수(쿼터 검사용)."""
    res = table().query(
        IndexName="GSI1",
        KeyConditionExpression=Key("ownerId").eq(owner_id) & Key("SK").eq(APP_META_SK),
        Select="COUNT",
    )
    return res.get("Count", 0)


def _collect(op: Any, **params: Any) -> list[dict[str, Any]]:
    """query/scan 을 LastEvaluatedKey 끝까지 따라가며 아이템을 모은다(1MB 페이지 한도 대응)."""
    items: list[dict[str, Any]] = []
    while True:
        res = op(**params)
        items.extend(res.get("Items", []))
        last = res.get("LastEvaluatedKey")
        if not last:
            return items
        params = {**params, "ExclusiveStartKey": last}


def list_all_apps(status: str | None = None) -> list[dict[str, Any]]:
    """관리자 전체 현황(GSI2: status). status 미지정 시 App 메타 아이템 스캔. 전체 페이지를 모은다."""
    if status:
        items = _collect(
            table().query,
            IndexName="GSI2",
            KeyConditionExpression=Key("status").eq(status) & Key("SK").eq(APP_META_SK),
        )
        return [_to_app(i) for i in items]  # type: ignore[misc]
    items = _collect(
        table().scan,
        FilterExpression="entityType = :t AND SK = :sk",
        ExpressionAttributeValues={":t": "App", ":sk": APP_META_SK},
    )
    return [_to_app(i) for i in items]  # type: ignore[misc]


# 프리셋·권한 템플릿 참조 필드(App 레코드) — 사용 중 삭제 거부(QA M3)에서 쓴다.
APP_CONFIG_REF_FIELDS = ("presetId", "permissionTemplateId")


def count_apps_referencing(field: str, value: str) -> int:
    """App.{field}==value 이고 status≠DELETING 인 앱 수(관리자 CONFIG 삭제 전 검사, QA M3).

    관리자 저빈도 작업이라 App 메타 스캔(전체 페이지)으로 충분하다 — 전용 GSI 를 두지 않는다.
    DELETING 앱은 곧 사라지고 더 이상 배포되지 않으므로 사용 중으로 보지 않는다.
    """
    if field not in APP_CONFIG_REF_FIELDS:
        raise ValueError(f"count_apps_referencing: 지원하지 않는 필드 {field}")
    items = _collect(
        table().scan,
        FilterExpression="entityType = :t AND SK = :sk AND #f = :v AND #s <> :deleting",
        ExpressionAttributeNames={"#f": field, "#s": "status"},
        ExpressionAttributeValues={
            ":t": "App",
            ":sk": APP_META_SK,
            ":v": value,
            ":deleting": "DELETING",
        },
        ProjectionExpression="PK",
    )
    return len(items)


def update_app(app_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    """부분 업데이트(설정 변경). updatedAt 자동 갱신. 존재 조건 강제."""
    now = _now_iso()
    entries = {k: v for k, v in {**patch, "updatedAt": now}.items() if v is not None}
    names: dict[str, str] = {}
    values: dict[str, Any] = {}
    sets: list[str] = []
    for key, value in entries.items():
        names[f"#{key}"] = key
        values[f":{key}"] = value
        sets.append(f"#{key} = :{key}")
    res = table().update_item(
        Key={"PK": app_pk(app_id), "SK": APP_META_SK},
        UpdateExpression="SET " + ", ".join(sets),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=clean_item(values),
        ConditionExpression="attribute_exists(PK)",
        ReturnValues="ALL_NEW",
    )
    return _to_app(res.get("Attributes"))  # type: ignore[return-value]


def transition_status(app_id: str, next_status: str, allowed_from: list[str]) -> None:
    """상태 전이(상태 기계 준수). 허용 전이만 조건부로 수행.

    status: CREATING→ACTIVE|FAILED, ACTIVE→DELETING, FAILED→DELETING, DELETING→FAILED
    →ACTIVE 전이는 runtimeStateUpdatedAt 도 기록한다 — 잠자기 유예(ACTIVE 후 15분, QA W-3)의 기준 시각.
    """
    now = _now_iso()
    values: dict[str, Any] = {":next": next_status, ":now": now}
    update = "SET #s = :next, updatedAt = :now"
    if next_status == "ACTIVE":
        update += ", runtimeStateUpdatedAt = :now"
    for idx, source in enumerate(allowed_from):
        values[f":from{idx}"] = source
    condition = (
        "attribute_exists(PK) AND ("
        + " OR ".join(f"#s = :from{idx}" for idx in range(len(allowed_from)))
        + ")"
    )
    table().update_item(
        Key={"PK": app_pk(app_id), "SK": APP_META_SK},
        UpdateExpression=update,
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues=values,
        ConditionExpression=condition,
    )


def set_failure(app_id: str, failure_reason: str, failure_detail: str) -> None:
    """실패 사유 기록(finalize failure). status 전이와 별개로 App 레코드에 사유를 남긴다.

    존재 조건만 강제(전이 조건은 transition_status 가 담당) — 레코드가 없으면 조용히 무시(멱등).
    """
    now = _now_iso()
    try:
        table().update_item(
            Key={"PK": app_pk(app_id), "SK": APP_META_SK},
            UpdateExpression="SET failureReason = :r, failureDetail = :d, updatedAt = :now",
            ExpressionAttributeValues={
                ":r": failure_reason,
                ":d": failure_detail,
                ":now": now,
            },
            ConditionExpression="attribute_exists(PK)",
        )
    except Exception:  # noqa: BLE001 - 레코드 없음이면 무시(delete cleanup 이후 등)
        pass


def clear_failure(app_id: str) -> None:
    """실패 사유 제거(finalize success). 재시도 성공 후 잔재 방지.

    필드가 없어도 REMOVE 는 성공(멱등). 레코드가 없으면 조용히 무시.
    """
    now = _now_iso()
    try:
        table().update_item(
            Key={"PK": app_pk(app_id), "SK": APP_META_SK},
            UpdateExpression="REMOVE failureReason, failureDetail SET updatedAt = :now",
            ExpressionAttributeValues={":now": now},
            ConditionExpression="attribute_exists(PK)",
        )
    except Exception:  # noqa: BLE001 - 레코드 없음이면 무시
        pass


def set_runtime_state(app_id: str, state: str) -> None:
    """runtimeState 갱신(RUNNING|WAKING|SLEEPING). status=ACTIVE에서만 의미 있음(호출부 보장).

    runtimeStateUpdatedAt = 전이 시각 — 잠자기 유예(RUNNING/WAKING 후 15분, QA W-3)의 기준.
    """
    now = _now_iso()
    table().update_item(
        Key={"PK": app_pk(app_id), "SK": APP_META_SK},
        UpdateExpression="SET runtimeState = :r, runtimeStateUpdatedAt = :now, updatedAt = :now",
        ExpressionAttributeValues={":r": state, ":now": now},
        ConditionExpression="attribute_exists(PK)",
    )


def delete_app_record(app_id: str) -> None:
    table().delete_item(Key={"PK": app_pk(app_id), "SK": APP_META_SK})


# ── 시크릿 JSON 갱신 직렬화 (DESIGN.md D8 — 앱 레코드 버전 조건부 갱신) ─────────────
#
# 앱당 시크릿 1개(JSON)를 여러 경로(PATCH /apps, deploy-notify 정리)가 고친다. Secrets Manager 의
# PutSecretValue 는 조건부 쓰기를 지원하지 않으므로, App 레코드의 `version` 으로 직렬화한다:
#   1) claim : `version = :expected`(없으면 0 으로 간주) AND 잠금 없음(또는 만료) 조건으로
#              version+1 + 짧은 임대 잠금(secretLockId/secretLockExpiresAt)을 건다.
#   2) 시크릿 JSON 읽기·병합·쓰기(잠금 보유 중이라 다른 작성자는 1)에서 충돌로 거절됨 → lost update 없음).
#   3) commit: 잠금 토큰 일치 조건으로 secretKeys/secretArn 반영 + 잠금 해제.
# 실패 시 abort 로 잠금만 해제(최선). 임대 만료(기본 60초) 후에는 다른 작성자가 claim 가능 — Lambda
# 비정상 종료로 잠금이 남아도 영구 고착되지 않는다. 잠금 필드는 API 응답에서 제거한다(handlers._view_app).

SECRET_LOCK_TTL_SEC = 60


class SecretVersionConflict(Exception):
    """버전 불일치 또는 다른 작성자가 잠금 보유 — 호출부가 409(CONFLICT) 또는 스킵으로 변환."""


def claim_secret_lock(app_id: str, expected_version: int, token: str, now_epoch: int) -> int:
    """version 조건부로 시크릿 갱신 잠금을 건다. 성공 시 새 version 반환. 실패 시 SecretVersionConflict."""
    if expected_version == 0:
        version_cond = "(attribute_not_exists(#ver) OR #ver = :v)"
    else:
        version_cond = "#ver = :v"
    try:
        table().update_item(
            Key={"PK": app_pk(app_id), "SK": APP_META_SK},
            UpdateExpression="SET #ver = :v1, secretLockId = :tok, secretLockExpiresAt = :exp, updatedAt = :now",
            ConditionExpression=(
                "attribute_exists(PK) AND "
                + version_cond
                + " AND (attribute_not_exists(secretLockId) OR secretLockExpiresAt < :epoch)"
            ),
            ExpressionAttributeNames={"#ver": "version"},
            ExpressionAttributeValues={
                ":v": expected_version,
                ":v1": expected_version + 1,
                ":tok": token,
                ":exp": now_epoch + SECRET_LOCK_TTL_SEC,
                ":epoch": now_epoch,
                ":now": _now_iso(),
            },
        )
    except Exception as err:  # noqa: BLE001
        if is_conditional_check_failed(err):
            raise SecretVersionConflict(app_id) from err
        raise
    return expected_version + 1


def commit_secret_lock(
    app_id: str,
    token: str,
    secret_keys: list[str],
    secret_arn: str | None,
) -> dict[str, Any]:
    """잠금 토큰 일치 조건으로 secretKeys(+secretArn) 반영 + 잠금 해제. 갱신된 App 반환."""
    sets = ["secretKeys = :keys", "updatedAt = :now"]
    values: dict[str, Any] = {":keys": list(secret_keys), ":tok": token, ":now": _now_iso()}
    if secret_arn:
        sets.append("secretArn = :arn")
        values[":arn"] = secret_arn
    try:
        res = table().update_item(
            Key={"PK": app_pk(app_id), "SK": APP_META_SK},
            UpdateExpression="SET " + ", ".join(sets) + " REMOVE secretLockId, secretLockExpiresAt",
            ConditionExpression="secretLockId = :tok",
            ExpressionAttributeValues=values,
            ReturnValues="ALL_NEW",
        )
    except Exception as err:  # noqa: BLE001
        if is_conditional_check_failed(err):
            raise SecretVersionConflict(app_id) from err
        raise
    return _to_app(res.get("Attributes"))  # type: ignore[return-value]


def abort_secret_lock(app_id: str, token: str) -> None:
    """잠금만 해제(최선, 멱등). 토큰이 다르면(만료 후 타인이 claim) 건드리지 않는다."""
    try:
        table().update_item(
            Key={"PK": app_pk(app_id), "SK": APP_META_SK},
            UpdateExpression="REMOVE secretLockId, secretLockExpiresAt",
            ConditionExpression="secretLockId = :tok",
            ExpressionAttributeValues={":tok": token},
        )
    except Exception:  # noqa: BLE001 - 해제 실패는 임대 만료로 자연 해소
        pass
