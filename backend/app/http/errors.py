"""API 에러 코드 사전 (apphub-conventions 3장 / api-contract.md).

code는 대문자 스네이크, message는 사용자에게 그대로 보여줄 수 있는 한국어.
핸들러 밖으로 던지면 app.http.response.to_error_response 로 변환된다.
"""

from __future__ import annotations

# 에러 코드 리터럴(api-contract.md 에러 코드 사전).
ERROR_CODES = frozenset(
    {
        "UNAUTHENTICATED",
        "FORBIDDEN",
        "NOT_FOUND",
        "VALIDATION_ERROR",
        "SUBDOMAIN_INVALID",
        "SUBDOMAIN_TAKEN",
        "REPO_NAME_TAKEN",
        "REPO_IN_USE",
        "QUOTA_EXCEEDED",
        "PRESET_NOT_FOUND",
        "PERMISSION_TEMPLATE_NOT_FOUND",
        "PROVIDER_DISABLED",
        "INTERNET_FACING_NOT_ALLOWED",
        "INVALID_STATE",
        "CONNECTION_NOT_READY",
        "METHOD_NOT_ALLOWED",
        "ROUTE_NOT_FOUND",
        "INTERNAL_ERROR",
    }
)


class ApiError(Exception):
    """HTTP 상태 코드가 붙은 도메인 에러."""

    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


class _Errors:
    """도메인 에러 팩토리 (기존 TS `errors` 객체와 동형)."""

    @staticmethod
    def unauthenticated() -> ApiError:
        return ApiError(401, "UNAUTHENTICATED", "로그인이 필요해요.")

    @staticmethod
    def forbidden(msg: str = "이 작업을 수행할 권한이 없어요.") -> ApiError:
        return ApiError(403, "FORBIDDEN", msg)

    @staticmethod
    def not_found(msg: str = "요청하신 항목을 찾을 수 없어요.") -> ApiError:
        return ApiError(404, "NOT_FOUND", msg)

    @staticmethod
    def validation(msg: str) -> ApiError:
        return ApiError(400, "VALIDATION_ERROR", msg)

    @staticmethod
    def subdomain_invalid(msg: str) -> ApiError:
        return ApiError(400, "SUBDOMAIN_INVALID", msg)

    @staticmethod
    def subdomain_taken() -> ApiError:
        return ApiError(
            409, "SUBDOMAIN_TAKEN", "이미 사용 중인 주소예요. 다른 이름을 입력해주세요."
        )

    @staticmethod
    def repo_name_taken() -> ApiError:
        return ApiError(
            409,
            "REPO_NAME_TAKEN",
            "같은 이름의 저장소가 이미 있어요. 다른 이름을 입력해주세요.",
        )

    @staticmethod
    def repo_in_use(app_name: str | None = None) -> ApiError:
        """삭제하려는 CodeCommit 레포를 사용 중인 앱이 있음(먼저 앱 삭제 필요)."""
        if app_name:
            message = f"이 저장소를 사용 중인 앱('{app_name}')이 있어요. 앱을 먼저 삭제해주세요."
        else:
            message = "이 저장소를 사용 중인 앱이 있어요. 앱을 먼저 삭제해주세요."
        return ApiError(409, "REPO_IN_USE", message)

    @staticmethod
    def quota_exceeded(quota: int) -> ApiError:
        return ApiError(
            409,
            "QUOTA_EXCEEDED",
            f"만들 수 있는 앱 개수({quota}개)를 초과했어요. "
            "사용하지 않는 앱을 삭제하거나 관리자에게 문의해주세요.",
        )

    @staticmethod
    def preset_not_found() -> ApiError:
        return ApiError(400, "PRESET_NOT_FOUND", "선택한 크기를 찾을 수 없어요. 다시 선택해주세요.")

    @staticmethod
    def permission_template_not_found() -> ApiError:
        return ApiError(400, "PERMISSION_TEMPLATE_NOT_FOUND", "선택한 앱 유형을 찾을 수 없어요.")

    @staticmethod
    def provider_disabled() -> ApiError:
        return ApiError(
            400, "PROVIDER_DISABLED", "선택한 저장소 연결 방식이 현재 사용할 수 없어요."
        )

    @staticmethod
    def internet_facing_not_allowed() -> ApiError:
        return ApiError(
            400,
            "INTERNET_FACING_NOT_ALLOWED",
            "회사 밖 접속은 현재 허용되어 있지 않아요. 관리자에게 문의해주세요.",
        )

    @staticmethod
    def invalid_state(msg: str) -> ApiError:
        return ApiError(409, "INVALID_STATE", msg)

    @staticmethod
    def connection_not_ready() -> ApiError:
        return ApiError(
            409,
            "CONNECTION_NOT_READY",
            "저장소 연결이 아직 승인되지 않았어요. '저장소 연결' 메뉴에서 승인을 완료해주세요.",
        )

    @staticmethod
    def method_not_allowed() -> ApiError:
        return ApiError(405, "METHOD_NOT_ALLOWED", "지원하지 않는 요청 방식이에요.")

    @staticmethod
    def route_not_found() -> ApiError:
        return ApiError(404, "ROUTE_NOT_FOUND", "요청하신 경로를 찾을 수 없어요.")

    @staticmethod
    def internal(
        msg: str = "플랫폼 내부 문제예요. 관리자에게 문의해주세요.",
    ) -> ApiError:
        return ApiError(500, "INTERNAL_ERROR", msg)


errors = _Errors()
