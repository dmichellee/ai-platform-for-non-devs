"""Secrets Manager — 앱 시크릿 저장/정리 (DESIGN.md 3.6, D8).

앱 생성/수정 시 시크릿 값을 Secrets Manager 에 저장하고 **ARN 만** App.secretArns 에 기록한다.
값은 여기서만 다루고 **DDB·로그·CloudFormation 파라미터에 절대 남기지 않는다**(반환도 ARN 만).
삭제는 ForceDeleteWithoutRecovery(즉시 삭제, 앱 정리 흐름). 없는 시크릿은 멱등 통과.

시크릿 이름 규약: `apphub/{stage}/app/{appId}/{KEY}`.
"""

from __future__ import annotations

from collections.abc import Iterable

from botocore.exceptions import ClientError

from .clients import client


def secret_name(stage: str, app_id: str, key: str) -> str:
    """앱 시크릿 이름(경로형). API 역할 IAM 은 `apphub/{stage}/app/*` 로 이 접두어를 커버한다."""
    return f"apphub/{stage}/app/{app_id}/{key}"


def put_app_secret(stage: str, app_id: str, key: str, value: str) -> str:
    """시크릿 값을 저장(신규 생성 또는 기존 값 갱신)하고 ARN 을 반환한다.

    값은 이 함수 밖으로 절대 반환/로그하지 않는다(ARN 만). 이미 있으면 put_secret_value 로
    새 버전을 올린다(create_secret 은 ResourceExistsException → 갱신 경로로 폴백, 멱등).
    """
    sm = client("secretsmanager")
    name = secret_name(stage, app_id, key)
    try:
        res = sm.create_secret(Name=name, SecretString=value)
        return res["ARN"]
    except ClientError as err:
        if err.response.get("Error", {}).get("Code") != "ResourceExistsException":
            raise
        # 이미 존재 — 값만 갱신(put_secret_value)하고 ARN 을 확보한다.
        sm.put_secret_value(SecretId=name, SecretString=value)
        desc = sm.describe_secret(SecretId=name)
        return desc["ARN"]


def delete_secret(secret_arn: str) -> None:
    """시크릿 즉시 삭제. ResourceNotFoundException 은 멱등 통과."""
    try:
        client("secretsmanager").delete_secret(
            SecretId=secret_arn,
            ForceDeleteWithoutRecovery=True,
        )
    except ClientError as err:
        if err.response.get("Error", {}).get("Code") == "ResourceNotFoundException":
            return
        raise


def delete_secrets(secret_arns: Iterable[str]) -> None:
    for arn in secret_arns:
        delete_secret(arn)
