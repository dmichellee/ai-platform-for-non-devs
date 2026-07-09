"""리스너 규칙 전환 테스트 (D-M4-04/D-M5-02) — forward 대상만 교체, cognitoProtect 인증유지, 멱등."""

from __future__ import annotations

from app.wake import listener_rule as lr
from app.wake.listener_rule import (
    current_forward_target,
    replace_forward_target,
    transition_listener_rule,
)

APP_TG = "arn:aws:elasticloadbalancing:...:targetgroup/app-tg/1"
WAKER_TG = "arn:aws:elasticloadbalancing:...:targetgroup/waker-tg/2"
LISTENER = "arn:aws:elasticloadbalancing:...:listener/app/internal/x/y"
HOST = "myapp.apps.example.com"
RULE_ARN = "arn:aws:elasticloadbalancing:...:listener-rule/app/internal/x/y/rule1"


def _forward_only_rule(target: str) -> dict:
    return {
        "RuleArn": RULE_ARN,
        "Conditions": [{"Field": "host-header", "HostHeaderConfig": {"Values": [HOST]}}],
        "Actions": [{"Type": "forward", "Order": 1, "TargetGroupArn": target}],
    }


def _cognito_protected_rule(forward_target: str) -> dict:
    """D-M4-04: authenticate-cognito(order1) → forward(order2) 체인."""
    return {
        "RuleArn": RULE_ARN,
        "Conditions": [{"Field": "host-header", "HostHeaderConfig": {"Values": [HOST]}}],
        "Actions": [
            {
                "Type": "authenticate-cognito",
                "Order": 1,
                "AuthenticateCognitoConfig": {
                    "UserPoolArn": "arn:...:userpool/x",
                    "UserPoolClientId": "cid",
                    "UserPoolDomain": "apphub-dev.auth",
                },
            },
            {"Type": "forward", "Order": 2, "TargetGroupArn": forward_target},
        ],
    }


# ── 순수 함수 단위 ────────────────────────────────────────────────────────────


def test_current_forward_target_single() -> None:
    actions = [{"Type": "forward", "TargetGroupArn": APP_TG}]
    assert current_forward_target(actions) == APP_TG


def test_current_forward_target_from_forward_config() -> None:
    actions = [{"Type": "forward", "ForwardConfig": {"TargetGroups": [{"TargetGroupArn": APP_TG}]}}]
    assert current_forward_target(actions) == APP_TG


def test_replace_forward_target_preserves_cognito_action_and_order() -> None:
    actions = _cognito_protected_rule(APP_TG)["Actions"]
    new_actions = replace_forward_target(actions, WAKER_TG)
    # authenticate-cognito 액션은 그대로(order1 유지).
    auth = next(a for a in new_actions if a["Type"] == "authenticate-cognito")
    assert auth["Order"] == 1
    assert "AuthenticateCognitoConfig" in auth
    # forward 만 대상 교체(order2 보존).
    fwd = next(a for a in new_actions if a["Type"] == "forward")
    assert fwd["TargetGroupArn"] == WAKER_TG
    assert fwd["Order"] == 2


def test_replace_forward_target_synthesizes_when_no_forward() -> None:
    new_actions = replace_forward_target([], APP_TG)
    assert new_actions == [{"Type": "forward", "Order": 1, "TargetGroupArn": APP_TG}]


# ── transition_listener_rule (elbv2 stub) ─────────────────────────────────────


def test_transition_to_waker_forward_only(ddb_table, p2_clients) -> None:
    p2_clients["elbv2"].set_response("describe_rules", {"Rules": [_forward_only_rule(APP_TG)]})
    res = transition_listener_rule(
        listener_arn=LISTENER,
        host=HOST,
        app_target_group_arn=APP_TG,
        waker_target_group_arn=WAKER_TG,
        to="waker",
    )
    assert res["changed"] is True
    assert res["ruleArn"] == RULE_ARN
    call = p2_clients["elbv2"].calls_for("modify_rule")[0]
    assert call["RuleArn"] == RULE_ARN
    fwd = next(a for a in call["Actions"] if a["Type"] == "forward")
    assert fwd["TargetGroupArn"] == WAKER_TG


def test_transition_cognito_protected_keeps_auth(ddb_table, p2_clients) -> None:
    p2_clients["elbv2"].set_response(
        "describe_rules", {"Rules": [_cognito_protected_rule(WAKER_TG)]}
    )
    # 잠자기 상태(waker) → 복원(app) 전환: forward 만 앱 TG 로, authenticate-cognito 유지.
    res = transition_listener_rule(
        listener_arn=LISTENER,
        host=HOST,
        app_target_group_arn=APP_TG,
        waker_target_group_arn=WAKER_TG,
        to="app",
    )
    assert res["changed"] is True
    call = p2_clients["elbv2"].calls_for("modify_rule")[0]
    assert any(a["Type"] == "authenticate-cognito" and a["Order"] == 1 for a in call["Actions"])
    fwd = next(a for a in call["Actions"] if a["Type"] == "forward")
    assert fwd["TargetGroupArn"] == APP_TG


def test_transition_idempotent_when_already_target(ddb_table, p2_clients) -> None:
    # 이미 waker TG 로 forward 중 → to=waker 는 no-op(ModifyRule 미호출).
    p2_clients["elbv2"].set_response("describe_rules", {"Rules": [_forward_only_rule(WAKER_TG)]})
    res = transition_listener_rule(
        listener_arn=LISTENER,
        host=HOST,
        app_target_group_arn=APP_TG,
        waker_target_group_arn=WAKER_TG,
        to="waker",
    )
    assert res["changed"] is False
    assert res["ruleArn"] == RULE_ARN
    assert p2_clients["elbv2"].calls_for("modify_rule") == []


def test_transition_rule_not_found(ddb_table, p2_clients) -> None:
    p2_clients["elbv2"].set_response("describe_rules", {"Rules": []})
    res = transition_listener_rule(
        listener_arn=LISTENER,
        host=HOST,
        app_target_group_arn=APP_TG,
        waker_target_group_arn=WAKER_TG,
        to="waker",
    )
    assert res["ruleNotFound"] is True
    assert res["changed"] is False


def test_find_rule_by_host_matches_values_field(ddb_table, p2_clients) -> None:
    # 구형 스키마: Conditions[].Values (HostHeaderConfig 없음)도 매칭.
    rule = {
        "RuleArn": RULE_ARN,
        "Conditions": [{"Field": "host-header", "Values": [HOST]}],
        "Actions": [{"Type": "forward", "TargetGroupArn": APP_TG}],
    }
    p2_clients["elbv2"].set_response("describe_rules", {"Rules": [rule]})
    found = lr.find_rule_by_host(LISTENER, HOST)
    assert found is not None
    assert found["RuleArn"] == RULE_ARN
