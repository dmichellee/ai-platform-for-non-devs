"""Secrets Manager — 앱 삭제 시 시크릿 정리 (DESIGN.md 3.6, D8).

**ARN 만 다룬다** — 시크릿 평문을 읽거나 로그에 남기지 않는다.
삭제는 ForceDeleteWithoutRecovery(즉시 삭제, 앱 정리 흐름). 없는 시크릿은 멱등 통과.
"""

from __future__ import annotations

from collections.abc import Iterable

from botocore.exceptions import ClientError

from .clients import client


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
