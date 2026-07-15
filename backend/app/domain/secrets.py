"""앱 시크릿 재조정 (마법사 "비밀 값" 토글의 실제 처리 — DESIGN.md D8).

계약: 앱 생성/수정 body 의 `secrets: {KEY: value}` (평문 값)를 받아 Secrets Manager 에 저장하고
App.secretArns 에 **{KEY: ARN} 만** 기록한다. **값은 DDB·로그·응답에 절대 남기지 않는다.**

- 생성: 각 KEY 값을 저장 → {KEY: ARN} 반환(핸들러가 App.secretArns 로 기록).
- 수정(프론트 계약 api-requests.md 항목 9 — 부분 갱신 + 명시 삭제):
    · secrets(upsert): 보낸 KEY 만 put_app_secret(생성 또는 값 갱신) → ARN 확보. 빠진 KEY 는 건드리지 않음.
    · secretsRemove(명시 삭제): 목록의 KEY 만 삭제(ForceDelete) → secretArns 에서 제외.
  결과 {KEY: ARN} 을 반환(핸들러가 App.secretArns 를 이 맵으로 교체).

시크릿 이름 규약: `apphub/{stage}/app/{appId}/{KEY}` (integrations.secrets.secret_name).
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from ..integrations.secrets import delete_secret, put_app_secret


def store_secrets(stage: str, app_id: str, secrets: dict[str, str]) -> dict[str, str]:
    """생성 시: 시크릿 값을 저장하고 {KEY: ARN} 을 반환한다(값 미노출)."""
    arns: dict[str, str] = {}
    for key, value in secrets.items():
        arns[key] = put_app_secret(stage, app_id, key, value)
    return arns


def apply_secret_changes(
    stage: str,
    app_id: str,
    upsert: dict[str, str],
    remove: Iterable[str],
    current_arns: dict[str, Any] | None,
) -> dict[str, str]:
    """수정 시(부분 갱신 + 명시 삭제): 새 {KEY: ARN} 맵을 반환한다(프론트 계약 항목 9).

    - upsert 의 KEY: put_app_secret(생성 또는 값 갱신) → ARN 갱신.
    - remove 의 KEY: 기존 ARN 으로 시크릿 삭제(멱등) → 맵에서 제외.
    - 그 외 기존 KEY: 그대로 유지(자동 삭제하지 않음).
    값은 다루기만 하고 반환/로그하지 않는다(ARN 만). upsert 와 remove 에 같은 KEY 가
    있으면 삭제를 우선한다(명시 삭제 의도 존중).
    """
    remove_set = set(remove)
    next_arns: dict[str, str] = dict(current_arns or {})
    # 먼저 upsert(값 저장/갱신).
    for key, value in upsert.items():
        if key in remove_set:
            continue  # 같은 KEY 를 삭제 대상으로도 보냈으면 저장하지 않음(삭제 우선).
        next_arns[key] = put_app_secret(stage, app_id, key, value)
    # 명시 삭제 KEY 는 기존 ARN 으로 삭제하고 맵에서 제외.
    for key in remove_set:
        arn = next_arns.pop(key, None)
        if isinstance(arn, str) and arn:
            delete_secret(arn)
    return next_arns
