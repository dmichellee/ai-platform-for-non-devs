"""L1 — CORS 헤더 (프록시 통합 응답). 최근 이 CORS 수정으로 dev 가 고쳐졌으니 동작 동일해야 함."""

from __future__ import annotations

from app.handler import handler

from .conftest import make_event, parse_result

ALLOWED = "https://d111111abcdef8.cloudfront.net"
ALLOWED_LOCAL = "http://localhost:5173"
DISALLOWED = "https://evil.example.com"


def test_success_echoes_allowed_origin(ddb_table, stub_clients):
    res = handler(make_event("GET", "/apps", user_id="u1", groups=["user"], origin=ALLOWED))
    out = parse_result(res)
    assert out["status"] == 200
    assert out["headers"]["Access-Control-Allow-Origin"] == ALLOWED
    assert out["headers"]["Access-Control-Allow-Credentials"] == "true"
    assert "GET" in out["headers"]["Access-Control-Allow-Methods"]
    assert "Authorization" in out["headers"]["Access-Control-Allow-Headers"]
    assert out["headers"]["Vary"] == "Origin"
    assert out["headers"]["Access-Control-Allow-Origin"] != "*"


def test_localhost_origin_allowed(ddb_table, stub_clients):
    res = handler(make_event("GET", "/apps", user_id="u1", groups=["user"], origin=ALLOWED_LOCAL))
    out = parse_result(res)
    assert out["status"] == 200
    assert out["headers"]["Access-Control-Allow-Origin"] == ALLOWED_LOCAL


def test_error_404_has_cors(ddb_table, stub_clients):
    res = handler(make_event("GET", "/nope/here", user_id="u1", groups=["user"], origin=ALLOWED))
    out = parse_result(res)
    assert out["status"] == 404
    assert out["error"]["code"] == "ROUTE_NOT_FOUND"
    assert out["headers"]["Access-Control-Allow-Origin"] == ALLOWED
    assert out["headers"]["Access-Control-Allow-Credentials"] == "true"


def test_auth_401_has_cors(ddb_table, stub_clients):
    res = handler(make_event("GET", "/apps", origin=ALLOWED))
    out = parse_result(res)
    assert out["status"] == 401
    assert out["error"]["code"] == "UNAUTHENTICATED"
    assert out["headers"]["Access-Control-Allow-Origin"] == ALLOWED


def test_disallowed_origin_never_echoed(ddb_table, stub_clients):
    res = handler(make_event("GET", "/apps", user_id="u1", groups=["user"], origin=DISALLOWED))
    out = parse_result(res)
    assert out["status"] == 200
    assert "Access-Control-Allow-Origin" not in out["headers"]
    assert "Access-Control-Allow-Credentials" not in out["headers"]
    assert out["headers"]["Vary"] == "Origin"


def test_no_origin_no_acao(ddb_table, stub_clients):
    res = handler(make_event("GET", "/apps", user_id="u1", groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 200
    assert "Access-Control-Allow-Origin" not in out["headers"]


def test_options_preflight_no_auth(ddb_table, stub_clients):
    res = handler(make_event("OPTIONS", "/apps", origin=ALLOWED))
    out = parse_result(res)
    assert out["status"] == 204
    assert out["headers"]["Access-Control-Allow-Origin"] == ALLOWED
    assert "POST" in out["headers"]["Access-Control-Allow-Methods"]
    assert "Authorization" in out["headers"]["Access-Control-Allow-Headers"]


def test_options_preflight_disallowed_origin(ddb_table, stub_clients):
    res = handler(make_event("OPTIONS", "/apps", origin=DISALLOWED))
    out = parse_result(res)
    assert out["status"] == 204
    assert "Access-Control-Allow-Origin" not in out["headers"]


def test_content_type_and_cors_coexist(ddb_table, stub_clients):
    res = handler(make_event("GET", "/apps", user_id="u1", groups=["user"], origin=ALLOWED))
    out = parse_result(res)
    assert "application/json" in out["headers"]["Content-Type"]
    assert out["headers"]["Access-Control-Allow-Origin"] == ALLOWED
