"""플랫폼 REST API Lambda 진입점 (apphub-{stage}-api, handler.handler).

API GW `/{proxy+}` ANY 프록시 통합 + Cognito authorizer(API GW 레벨).
 - 인증: authorizer가 검증한 클레임을 event.requestContext.authorizer.claims 로 수신 → get_identity.
 - 라우팅: routes.build_router()가 method + path로 분기.
 - 응답/에러: apphub-conventions 3장 형식({data} / {error:{code,message}}).
 - CORS: 프록시 통합이므로 본 요청 응답 헤더도 여기서 만든다. 모든 반환 경로(성공/에러/OPTIONS)를
   with_cors 로 감싸 Access-Control-* 를 주입한다.

무거운 작업(프로비저닝/배포/삭제)은 직접 하지 않고 Step Functions/CodeBuild로 위임한다.

주: 이 모듈이 Lambda 배포 자산의 진입점이 되도록, `handler(event, context)` 를 최상위에 노출한다.
    infra CDK는 PYTHON_3_13 / handler="handler.handler" 로 참조한다(자산 루트가 app/ 이므로).
"""

from __future__ import annotations

from typing import Any

from .auth.identity import get_identity
from .http.cors import preflight_response, with_cors
from .http.response import ProxyResult, to_error_response
from .routes import build_router

_router = build_router()


def handler(event: dict[str, Any], context: Any = None) -> ProxyResult:
    # OPTIONS preflight 방어: 인증 검사 이전에 처리(preflight 는 Authorization 을 동반하지 않음).
    if (event.get("httpMethod") or "").upper() == "OPTIONS":
        return preflight_response(event)
    try:
        identity = get_identity(event)
        return with_cors(event, _router.dispatch(event, identity))
    except Exception as err:  # noqa: BLE001 — 모든 예외를 계약 에러 형식으로 마스킹
        return with_cors(event, to_error_response(err))
