"""프로비저닝/삭제 실패 사유 요약 (UX 갭 해소).

배포 이력(Deployment)에 잡히기 전 단계(슬롯 배정/빌드 환경 구성/첫 배포 트리거)의 실패는
지금까지 화면에 원인이 보이지 않았다. finalize(outcome=failure) 시점에 App 레코드로

  - failureReason : 사용자용 한국어 요약(비개발자 대상, user/admin 모두 노출)
  - failureDetail : 기술 상세(실패 단계 + 정제된 예외 메시지, admin 응답에만 노출)

를 남겨 앱 상세에서 곧바로 원인을 볼 수 있게 한다.

failureDetail 정제: 시크릿 값/내부 ARN 이 그대로 노출되지 않도록 마스킹한다
(예외 Cause 에 SecretsManager ARN 등이 섞여 들어올 수 있음).
"""

from __future__ import annotations

import re
from typing import Any

_COMMON_TAIL = "다시 시도하거나 관리자에게 문의해주세요."

# 실패 단계(step 이름) → 사용자 친화 요약. finalize failure 입력의 failedStep/step 으로 판정.
_STEP_REASON: dict[str, str] = {
    # ProvisionApp
    "allocate-slot": "앱 주소/자리 배정 중 문제가 발생했어요.",
    "deploy-pipeline": "배포 준비(빌드 환경 구성) 중 문제가 발생했어요.",
    "poll-build": "배포 준비(빌드 환경 구성) 중 문제가 발생했어요.",
    "first-deploy": "첫 배포를 시작하지 못했어요.",
    # DeleteApp (delete 계열 전부 동일 요약)
    "delete-runtime": "앱 정리 중 문제가 발생했어요.",
    "poll-runtime": "앱 정리 중 문제가 발생했어요.",
    "delete-pipeline": "앱 정리 중 문제가 발생했어요.",
    "poll-pipeline": "앱 정리 중 문제가 발생했어요.",
    "cleanup": "앱 정리 중 문제가 발생했어요.",
}

# finalize step 자체가 실패 단계로 넘어오면(경계 케이스) 흐름별 폴백에 쓴다.
_PROVISION_FALLBACK = "앱을 만드는 중 문제가 발생했어요."
_DELETE_FALLBACK = "앱 정리 중 문제가 발생했어요."

# 정제: 시크릿/내부 ARN 노출 방지. 예외 Cause 는 신뢰 불가 입력으로 취급.
_ARN_RE = re.compile(r"arn:aws[a-z0-9-]*:[^\s\"']+")
_SECRET_HINT_RE = re.compile(r"(secret|password|token|credential)[^\s]*", re.IGNORECASE)
_MAX_DETAIL_LEN = 500


def sanitize_detail(raw: Any) -> str:
    """예외 메시지/Cause 문자열에서 ARN·시크릿 힌트를 마스킹하고 길이를 제한한다."""
    text = "" if raw is None else str(raw)
    text = _ARN_RE.sub("[리소스]", text)
    text = _SECRET_HINT_RE.sub("[보안값]", text)
    text = text.strip()
    if len(text) > _MAX_DETAIL_LEN:
        text = text[:_MAX_DETAIL_LEN] + "…"
    return text


def resolve_failed_step(e: dict[str, Any]) -> str | None:
    """실패 단계 판정. ASL Catch 가 넣어준 failedStep 우선, 없으면 직전 성공 step.

    finalize 는 흐름의 마지막 단계라 event.step 이 'finalize' 이면 직전 단계 정보가 없는 것 —
    이때는 None 을 반환해 흐름별 폴백 요약을 쓰게 한다.
    """
    failed = e.get("failedStep")
    if isinstance(failed, str) and failed:
        return failed
    step = e.get("step")
    if isinstance(step, str) and step and step != "finalize":
        return step
    return None


def build_failure(e: dict[str, Any], flow: str) -> dict[str, str]:
    """finalize failure 입력에서 failureReason/failureDetail 를 만든다.

    flow: "provision" | "delete" (폴백 요약 선택용).
    반환 키는 그대로 App 레코드에 저장(camelCase).
    """
    step = resolve_failed_step(e)
    if step and step in _STEP_REASON:
        reason_head = _STEP_REASON[step]
    else:
        reason_head = _PROVISION_FALLBACK if flow == "provision" else _DELETE_FALLBACK
    reason = f"{reason_head} {_COMMON_TAIL}"

    # 기술 상세: 실패 단계 라벨 + 정제된 에러 Cause(있으면).
    error_cause = e.get("error") or e.get("cause") or e.get("Cause")
    detail_parts: list[str] = []
    detail_parts.append(f"단계: {step}" if step else "단계: 확인 불가")
    cleaned = sanitize_detail(error_cause) if error_cause is not None else ""
    if cleaned:
        detail_parts.append(cleaned)
    detail = " | ".join(detail_parts)

    return {"failureReason": reason, "failureDetail": detail}
