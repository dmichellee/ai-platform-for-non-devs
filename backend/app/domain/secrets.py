"""앱 시크릿 도메인 로직 (D8 — 앱당 시크릿 1개 JSON, 2026-10-05 갱신).

저장 모델:
  - Secrets Manager `apphub/{stage}/app/{appId}` 1개, SecretString = JSON `{KEY: value}`.
  - DDB App: `secretArn`(없으면 부재), `secretKeys`(현재 주입 대상 KEY), `version`(없으면 0).

규칙:
  - 생성(POST /apps): secrets 가 있으면 CreateSecret 1회 → secretArn + secretKeys 기록.
  - 수정(PATCH /apps, 프론트 계약 api-requests.md 항목 9):
      · secrets(upsert): JSON 에 병합 저장(없으면 CreateSecret) + secretKeys 에 추가.
      · secretsRemove: **JSON 에서 지우지 않고 secretKeys 에서만 제외**(지연 정리). 실행 중 태스크 정의가
        `<arn>:KEY::` 로 참조하는 키를 즉시 지우면 재시작·확장·깨우기 시 태스크 기동이 실패한다(QA H4).
      · 같은 KEY 가 둘 다에 있으면 삭제 우선.
      · JSON 갱신은 App.version 조건부 잠금으로 직렬화(data.apps.claim/commit) — 충돌 시 409 CONFLICT.
  - 정리(deploy-notify 배포 성공 시): JSON 키 − (secretKeys ∪ 활성 태스크 정의가 참조하는 KEY) 를 JSON 에서 제거.
    실패 배포에서는 호출하지 않는다. JSON 이 비어도 시크릿 자체는 유지(앱 삭제 시에만 삭제).

**값은 DDB·로그·응답에 절대 남기지 않는다.** 이 모듈의 반환·로그 대상은 KEY 이름과 ARN 뿐이다.
"""

from __future__ import annotations

import time
import uuid
from typing import Any

from ..data.apps import (
    SecretVersionConflict,
    abort_secret_lock,
    claim_secret_lock,
    commit_secret_lock,
    get_app,
)
from ..http.errors import errors
from ..integrations.secrets import get_secret_json, put_secret_json, upsert_app_secret


def current_secret_keys(app: dict[str, Any]) -> list[str]:
    keys = app.get("secretKeys") or []
    return [str(k) for k in keys]


def create_initial_secret(
    stage: str, app_id: str, secrets: dict[str, str]
) -> tuple[str | None, list[str]]:
    """생성 시: 시크릿 JSON 1개를 만들고 (secretArn, secretKeys) 반환. 비었으면 (None, [])."""
    if not secrets:
        return None, []
    arn = upsert_app_secret(stage, app_id, None, dict(secrets))
    return arn, sorted(secrets.keys())


def apply_secret_changes(
    stage: str,
    app: dict[str, Any],
    upsert: dict[str, str],
    remove: list[str],
) -> tuple[dict[str, Any], bool]:
    """수정 시: 시크릿 JSON upsert + secretKeys 재계산을 버전 조건부로 반영한다.

    반환: (갱신된 App, 실제 변경 여부). 변경이 없으면(삭제 대상이 이미 없음 등) DDB/SM 미호출.
    충돌(다른 저장/정리와 경합) → errors.conflict()(409 CONFLICT).
    """
    app_id = app["appId"]
    remove_set = set(remove)
    effective_upsert = {k: v for k, v in upsert.items() if k not in remove_set}
    before = set(current_secret_keys(app))
    after = (before | set(effective_upsert)) - remove_set
    if not effective_upsert and after == before:
        return app, False

    token = uuid.uuid4().hex
    try:
        claim_secret_lock(app_id, int(app.get("version") or 0), token, int(time.time()))
    except SecretVersionConflict as err:
        raise errors.conflict() from err

    try:
        arn = app.get("secretArn")
        if effective_upsert:
            arn = upsert_app_secret(stage, app_id, arn, effective_upsert)
        updated = commit_secret_lock(app_id, token, sorted(after), arn)
    except SecretVersionConflict as err:
        raise errors.conflict() from err
    except Exception:
        abort_secret_lock(app_id, token)
        raise
    return updated, True


def prune_unreferenced_keys(app_id: str, referenced_keys: set[str]) -> dict[str, Any]:
    """배포 성공 후 지연 정리: JSON 키 − (secretKeys ∪ referenced_keys) 를 JSON 에서 제거.

    referenced_keys: 지금 ECS 서비스의 활성 태스크 정의들이 `<arn>:KEY::` 로 참조하는 KEY.
    잠금 충돌이면 이번에는 건너뛴다(다음 배포 성공 때 다시 정리 — 지연 정리라 안전).
    반환 값에는 KEY 이름만 담는다(값 미포함).
    """
    app = get_app(app_id)
    if not app:
        return {"reason": "app-record-missing"}
    arn = app.get("secretArn")
    if not arn:
        return {"reason": "no-secret"}
    keep = set(current_secret_keys(app)) | set(referenced_keys)

    # 잠금 전 사전 확인 — 지울 게 없으면 version 을 올리지 않는다(동시 PATCH 의 불필요한 409 방지).
    if all(k in keep for k in get_secret_json(arn)):
        return {"pruned": []}

    token = uuid.uuid4().hex
    try:
        claim_secret_lock(app_id, int(app.get("version") or 0), token, int(time.time()))
    except SecretVersionConflict:
        return {"reason": "locked-or-changed-skip"}
    try:
        current = get_secret_json(arn)  # 잠금 후 재조회(사전 확인 이후 변경 반영)
        dropped = sorted(k for k in current if k not in keep)
        if dropped:
            put_secret_json(arn, {k: v for k, v in current.items() if k in keep})
        commit_secret_lock(app_id, token, current_secret_keys(app), None)
    except SecretVersionConflict:
        return {"reason": "lock-lost-skip"}
    except Exception:
        abort_secret_lock(app_id, token)
        raise
    return {"pruned": dropped}
