"""Secrets Manager — 앱당 시크릿 1개(JSON) 저장/조회/정리 (DESIGN.md D8, 3.6).

규약(D8, 2026-10-05 갱신):
  - 앱당 시크릿 **1개**, 이름 `apphub/{stage}/app/{appId}`, SecretString = JSON `{KEY: value}`.
  - ECS 는 `valueFrom: <arn>:KEY::` 로 키별 주입한다(app-runtime construct).
  - DDB App 에는 `secretArn`(완전 ARN) + `secretKeys`(주입 대상 KEY 목록)만 저장한다.

값(JSON 내용)은 이 모듈과 domain.secrets 안에서만 다룬다. **DDB·로그·응답·예외 메시지에 값을 남기지
않는다** — 반환은 ARN 또는 dict(호출부가 즉시 소비), 예외는 AWS 에러 코드만 담긴 ClientError 그대로.
삭제는 ForceDeleteWithoutRecovery(즉시 삭제, 앱 정리 흐름). 없는 시크릿은 멱등 통과.
"""

from __future__ import annotations

import json
from collections.abc import Iterable

from botocore.exceptions import ClientError

from .clients import client


def app_secret_name(stage: str, app_id: str) -> str:
    """앱 시크릿 이름(경로형, 앱당 1개). IAM 은 `secret:apphub/{stage}/app/*` 로 커버한다."""
    return f"apphub/{stage}/app/{app_id}"


def _error_code(err: ClientError) -> str:
    return err.response.get("Error", {}).get("Code", "")


def _parse_json(secret_string: str | None) -> dict[str, str]:
    """SecretString → {KEY: value}. 형식이 깨졌으면 빈 dict 로 취급하지 않고 예외(덮어쓰기 방지)."""
    if not secret_string:
        return {}
    parsed = json.loads(secret_string)
    if not isinstance(parsed, dict):
        raise ValueError("앱 시크릿 형식이 JSON 객체가 아닙니다.")
    return {str(k): str(v) for k, v in parsed.items()}


def _dump(mapping: dict[str, str]) -> str:
    return json.dumps(mapping, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def get_secret_json(secret_id: str) -> dict[str, str]:
    """시크릿 JSON 을 읽는다. 시크릿이 없으면 {}."""
    try:
        res = client("secretsmanager").get_secret_value(SecretId=secret_id)
    except ClientError as err:
        if _error_code(err) == "ResourceNotFoundException":
            return {}
        raise
    return _parse_json(res.get("SecretString"))


def put_secret_json(secret_id: str, mapping: dict[str, str]) -> None:
    """시크릿 JSON 을 통째로 교체(새 버전 AWSCURRENT)."""
    client("secretsmanager").put_secret_value(SecretId=secret_id, SecretString=_dump(mapping))


def upsert_app_secret(
    stage: str, app_id: str, secret_arn: str | None, upsert: dict[str, str]
) -> str:
    """앱 시크릿 JSON 에 upsert 를 병합 저장하고 완전 ARN 을 반환한다.

    - secret_arn 이 있으면: GetSecretValue → 병합 → PutSecretValue.
    - 없으면: CreateSecret(JSON). 이미 같은 이름이 있으면(이전 시도의 고아 등)
      ResourceExistsException → 기존 JSON 을 읽어 병합 후 Put + DescribeSecret 로 ARN 확보(멱등).
    값은 반환/로그하지 않는다.
    """
    sm = client("secretsmanager")
    if secret_arn:
        current = get_secret_json(secret_arn)
        put_secret_json(secret_arn, {**current, **upsert})
        return secret_arn
    name = app_secret_name(stage, app_id)
    try:
        res = sm.create_secret(Name=name, SecretString=_dump(dict(upsert)))
        return res["ARN"]
    except ClientError as err:
        if _error_code(err) != "ResourceExistsException":
            raise
    current = get_secret_json(name)
    put_secret_json(name, {**current, **upsert})
    return sm.describe_secret(SecretId=name)["ARN"]


def delete_secret(secret_id: str) -> None:
    """시크릿 즉시 삭제(ARN 또는 이름). ResourceNotFoundException 은 멱등 통과."""
    try:
        client("secretsmanager").delete_secret(
            SecretId=secret_id,
            ForceDeleteWithoutRecovery=True,
        )
    except ClientError as err:
        if _error_code(err) == "ResourceNotFoundException":
            return
        raise


def delete_secrets(secret_ids: Iterable[str]) -> None:
    for secret_id in secret_ids:
        delete_secret(secret_id)
