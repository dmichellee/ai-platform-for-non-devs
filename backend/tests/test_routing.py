"""L1 — 라우팅: 405/404/401 + 목록 형식."""

from __future__ import annotations

from app.handler import handler

from .conftest import make_event, parse_result


def test_method_not_allowed(ddb_table, stub_clients):
    # /connections 는 GET/POST/DELETE만 → PUT은 405
    res = handler(make_event("PUT", "/connections", user_id="u1", groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 405
    assert out["error"]["code"] == "METHOD_NOT_ALLOWED"


def test_route_not_found(ddb_table, stub_clients):
    res = handler(make_event("GET", "/nope/here", user_id="u1", groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 404
    assert out["error"]["code"] == "ROUTE_NOT_FOUND"


def test_unauthenticated_no_sub(ddb_table, stub_clients):
    res = handler(make_event("GET", "/apps"))
    out = parse_result(res)
    assert out["status"] == 401
    assert out["error"]["code"] == "UNAUTHENTICATED"


def test_get_apps_list_shape(ddb_table, stub_clients):
    res = handler(make_event("GET", "/apps", user_id="u1", groups=["user"]))
    out = parse_result(res)
    assert out["status"] == 200
    assert out["data"]["items"] == []
