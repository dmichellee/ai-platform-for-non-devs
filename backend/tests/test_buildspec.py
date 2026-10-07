"""buildspec 회귀(2026-10-08) — 정적 검사 + 공용 헬퍼(Node) 동작 검사.

정적: deployId 전달(D-1), 실패 분류 파일 기록 → post_build 재export 패턴(export 후 exit 로 값 유실 금지),
      잠든 앱 규칙 복귀 단계(N2)가 cdk deploy 전에 존재, 컨텍스트 조립이 공용 헬퍼(M3 안전장치)를 쓴다.
동작: 가짜 `aws` CLI(PATH 주입)로 helpers/runtime-ctx.cjs · prepare-sleeping-app.cjs 를 실제 실행.
      node 가 없으면 동작 검사는 skip.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
BUILDSPEC = ROOT / "infra" / "buildspec"
HELPERS = BUILDSPEC / "helpers"
FC_FILE = ".apphub-failure-category"


def _load(name: str) -> dict[str, Any]:
    return yaml.safe_load((BUILDSPEC / name).read_text(encoding="utf-8"))


def _commands(spec: dict[str, Any], phase: str) -> list[str]:
    return [str(c) for c in (spec["phases"].get(phase) or {}).get("commands") or []]


def _all_commands(spec: dict[str, Any]) -> list[tuple[str, str]]:
    return [(phase, cmd) for phase in spec["phases"] for cmd in _commands(spec, phase)]


# ══════════════════════════════════════════════════════════════════════════════
# 정적 검사
# ══════════════════════════════════════════════════════════════════════════════

RUNTIME_SPECS = ("deploy.yml", "provisioner.yml")


@pytest.mark.parametrize("name", RUNTIME_SPECS)
def test_runtime_cdk_deploy_passes_deploy_id(name: str) -> None:
    """D-1: runtime cdk deploy 에 -c deployId=${CODEBUILD_BUILD_ID}."""
    spec = _load(name)
    runtime_deploys = [
        c for _, c in _all_commands(spec) if "cdk deploy" in c and "appStackKind=runtime" in c
    ]
    assert runtime_deploys, f"{name}: runtime cdk deploy 명령이 없다"
    for cmd in runtime_deploys:
        assert '-c deployId="${CODEBUILD_BUILD_ID}"' in cmd


@pytest.mark.parametrize("name", ("deploy.yml", "provisioner.yml", "validate-build.yml"))
def test_failure_category_written_to_file_and_reexported(name: str) -> None:
    """금지 패턴: FAILURE_CATEGORY 를 export 만 하고 exit(값 유실). 실패 블록은 파일 기록을 포함해야 한다."""
    spec = _load(name)
    assert "FAILURE_CATEGORY" in (spec.get("env") or {}).get("exported-variables", [])
    for phase, cmd in _all_commands(spec):
        if phase == "post_build":
            continue
        if "FAILURE_CATEGORY" in cmd or "DEPLOY_FAILED" in cmd:
            assert FC_FILE in cmd, f"{name}/{phase}: 실패 분류가 파일로 남지 않는 블록\n{cmd}"
            # export 직후 exit 만 하는 구식 패턴이 남아 있지 않은지.
            lines = [ln.strip() for ln in cmd.splitlines()]
            for i, ln in enumerate(lines):
                if ln.startswith("export FAILURE_CATEGORY="):
                    assert any(FC_FILE in nxt for nxt in lines[i + 1 : i + 3]), cmd
    post = _commands(spec, "post_build")
    assert any(
        c.startswith("export FAILURE_CATEGORY=") and FC_FILE in c for c in post
    ), f"{name}: post_build 재export 없음"


@pytest.mark.parametrize("name", RUNTIME_SPECS)
def test_failable_runtime_steps_are_in_build_phase(name: str) -> None:
    """pre_build 실패는 post_build 를 거치지 않아 분류가 유실된다 → 실패 가능 단계는 build 에."""
    spec = _load(name)
    pre = "\n".join(_commands(spec, "pre_build"))
    build = "\n".join(_commands(spec, "build"))
    for helper in ("helpers/runtime-ctx.cjs", "helpers/prepare-sleeping-app.cjs"):
        assert helper not in pre
        assert helper in build


@pytest.mark.parametrize("name", RUNTIME_SPECS)
def test_sleeping_app_rule_restore_before_cdk_deploy(name: str) -> None:
    """N2: 규칙 복귀 단계가 runtime cdk deploy 보다 먼저 실행된다(두 buildspec 모두 같은 헬퍼)."""
    cmds = _commands(_load(name), "build")
    prep = next(i for i, c in enumerate(cmds) if "prepare-sleeping-app.cjs" in c)
    ctx = next(i for i, c in enumerate(cmds) if "runtime-ctx.cjs" in c)
    deploy = next(i for i, c in enumerate(cmds) if "cdk deploy" in c and "appStackKind=runtime" in c)
    assert ctx < prep < deploy


@pytest.mark.parametrize("name", RUNTIME_SPECS)
def test_no_inline_ctx_duplicate(name: str) -> None:
    """컨텍스트 조립은 공용 헬퍼 1곳(드리프트 방지) — 인라인 언마샬 스크립트가 남아 있지 않다."""
    text = (BUILDSPEC / name).read_text(encoding="utf-8")
    assert "PRESET#" not in text
    assert "/tmp/app-ctx.js" not in text


@pytest.mark.parametrize("name", RUNTIME_SPECS)
def test_no_shared_app_auth_client_reference(name: str) -> None:
    """N1: 공유 app-auth-client-id SSM 은 제거됐다(앱별 클라이언트는 runtime 스택 소유)."""
    assert "app-auth-client-id" not in (BUILDSPEC / name).read_text(encoding="utf-8")


def test_helpers_are_inside_cdk_source_tarball_paths() -> None:
    """헬퍼는 infra/ 아래(scripts/deploy.sh 가 tarball 에 infra 를 통째로 넣음)이고 buildspec 은 cdk-src 경로로 부른다."""
    deploy_sh = (ROOT / "scripts" / "deploy.sh").read_text(encoding="utf-8")
    tar_line = next(ln for ln in deploy_sh.splitlines() if "pnpm-workspace.yaml" in ln and "infra" in ln)
    assert tar_line.strip().startswith("infra ")
    for f in ("aws-cli.cjs", "runtime-ctx.cjs", "prepare-sleeping-app.cjs"):
        assert (HELPERS / f).is_file()
    for name in RUNTIME_SPECS:
        text = (BUILDSPEC / name).read_text(encoding="utf-8")
        assert "node cdk-src/infra/buildspec/helpers/runtime-ctx.cjs" in text
        assert "node cdk-src/infra/buildspec/helpers/prepare-sleeping-app.cjs" in text


# ══════════════════════════════════════════════════════════════════════════════
# 헬퍼 동작 — 가짜 aws CLI
# ══════════════════════════════════════════════════════════════════════════════

NODE = shutil.which("node")
needs_node = pytest.mark.skipif(NODE is None, reason="node 미설치")

FAKE_AWS = r'''#!{python}
"""가짜 aws CLI: FAKE_AWS_RULES(json) 의 첫 매칭 규칙으로 응답. 호출을 FAKE_AWS_LOG 에 jsonl 로 기록."""
import json, os, sys
args = sys.argv[1:]
with open(os.environ["FAKE_AWS_LOG"], "a") as f:
    f.write(json.dumps(args) + "\n")
joined = " ".join(args)
for rule in json.load(open(os.environ["FAKE_AWS_RULES"])):
    if all(m in joined for m in rule["match"]):
        if rule.get("stderr"):
            sys.stderr.write(rule["stderr"])
        if "out" in rule:
            sys.stdout.write(json.dumps(rule["out"]))
        sys.exit(rule.get("exit", 0))
sys.stderr.write("fake aws: no rule for " + joined)
sys.exit(255)
'''


def _av(value: Any) -> dict[str, Any]:
    """파이썬 값 → DDB AttributeValue."""
    if isinstance(value, bool):
        return {"BOOL": value}
    if isinstance(value, (int, float)):
        return {"N": str(value)}
    if isinstance(value, dict):
        return {"M": {k: _av(v) for k, v in value.items()}}
    if isinstance(value, list):
        return {"L": [_av(v) for v in value]}
    return {"S": str(value)}


def _item(d: dict[str, Any]) -> dict[str, Any]:
    return {"Item": {k: _av(v) for k, v in d.items()}}


class FakeAws:
    def __init__(self, tmp: Path) -> None:
        self.dir = tmp
        self.rules_path = tmp / "rules.json"
        self.log_path = tmp / "calls.jsonl"
        self.rules: list[dict[str, Any]] = []
        exe = tmp / "aws"
        exe.write_text(FAKE_AWS.replace("{python}", sys.executable), encoding="utf-8")
        exe.chmod(0o755)

    def on(self, *match: str, out: Any = None, exit: int = 0, stderr: str = "") -> None:
        rule: dict[str, Any] = {"match": list(match), "exit": exit}
        if out is not None:
            rule["out"] = out
        if stderr:
            rule["stderr"] = stderr
        self.rules.append(rule)

    def calls(self) -> list[list[str]]:
        if not self.log_path.exists():
            return []
        return [json.loads(ln) for ln in self.log_path.read_text().splitlines() if ln]

    def run(self, script: str, **env: str) -> subprocess.CompletedProcess[str]:
        self.rules_path.write_text(json.dumps(self.rules), encoding="utf-8")
        full_env = {
            "PATH": f"{self.dir}{os.pathsep}{os.environ.get('PATH', '')}",
            "FAKE_AWS_RULES": str(self.rules_path),
            "FAKE_AWS_LOG": str(self.log_path),
            "AWS_DEFAULT_REGION": "ap-northeast-2",
            "TABLE_NAME": "apphub-test-main",
            "STAGE": "test",
            "APP_ID": "app00001",
            **env,
        }
        return subprocess.run(
            [NODE or "node", str(HELPERS / script)],
            env=full_env,
            capture_output=True,
            text=True,
            timeout=30,
        )


@pytest.fixture
def fake_aws(tmp_path: Path) -> FakeAws:
    return FakeAws(tmp_path)


APP = {
    "appId": "app00001",
    "subdomain": "my-app",
    "scheme": "internet-facing",
    "albIndex": 1,
    "rulePriority": 120,
    "presetId": "small",
    "permissionTemplateId": "basic",
    "sleepMode": "on-demand",
    "cognitoProtect": True,
    "runtimeState": "SLEEPING",
    "status": "ACTIVE",
}
PRESET = {"presetId": "small", "cpu": 256, "memory": 512, "minCount": 1, "maxCount": 2,
          "scaleMetric": "cpu", "scaleThreshold": 70}
PERM = {"permId": "basic", "policyDocument": {"Version": "2012-10-17", "Statement": []}}


def _seed_ddb(fake: FakeAws, app: dict | None = APP, preset: dict | None = PRESET, perm: dict | None = PERM) -> None:
    fake.on("dynamodb", "get-item", "PRESET#", out=_item(preset) if preset else {})
    fake.on("dynamodb", "get-item", "PERM#", out=_item(perm) if perm else {})
    fake.on("dynamodb", "get-item", "APP#", out=_item(app) if app else {})


def _env_lines(stdout: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for ln in stdout.splitlines():
        assert ln.startswith("export CTX_"), ln
        k, v = ln[len("export CTX_"):].split("=", 1)
        out[k] = v
    return out


# ── runtime-ctx.cjs (M3 이중 안전장치) ───────────────────────────────────────


@needs_node
def test_ctx_ok_emits_expected_keys(fake_aws: FakeAws) -> None:
    _seed_ddb(fake_aws)
    res = fake_aws.run("runtime-ctx.cjs", IMAGE_TAG="sha1", IS_INITIAL="false")
    assert res.returncode == 0, res.stderr
    env = _env_lines(res.stdout)
    assert env["cpu"] == '"256"' and env["memory"] == '"512"'
    assert env["albIndex"] == '"1"' and env["scheme"] == '"internet-facing"'
    assert env["imageTag"] == '"sha1"' and env["isInitialDeploy"] == '"false"'
    assert env["cognitoProtect"] == '"true"'
    assert "permissionPolicyB64" in env


@needs_node
def test_ctx_missing_preset_fails_with_message(fake_aws: FakeAws) -> None:
    _seed_ddb(fake_aws, preset=None)
    res = fake_aws.run("runtime-ctx.cjs", IMAGE_TAG="sha1", IS_INITIAL="false")
    assert res.returncode == 1
    assert "PRESET#small" in res.stderr
    assert res.stdout == ""  # cpu=0 컨텍스트가 새지 않음


@needs_node
def test_ctx_missing_perm_fails_with_message(fake_aws: FakeAws) -> None:
    _seed_ddb(fake_aws, perm=None)
    res = fake_aws.run("runtime-ctx.cjs", IMAGE_TAG="sha1", IS_INITIAL="false")
    assert res.returncode == 1
    assert "PERM#basic" in res.stderr


@needs_node
def test_ctx_missing_app_fails(fake_aws: FakeAws) -> None:
    _seed_ddb(fake_aws, app=None)
    res = fake_aws.run("runtime-ctx.cjs", IMAGE_TAG="sha1", IS_INITIAL="false")
    assert res.returncode == 1
    assert "APP#app00001" in res.stderr


@needs_node
def test_ctx_ddb_error_fails(fake_aws: FakeAws) -> None:
    fake_aws.on("dynamodb", exit=254, stderr="AccessDeniedException")
    res = fake_aws.run("runtime-ctx.cjs", IMAGE_TAG="sha1", IS_INITIAL="false")
    assert res.returncode == 1
    assert "AccessDenied" in res.stderr


# ── prepare-sleeping-app.cjs (N2) ────────────────────────────────────────────

LISTENER = "arn:listener/internet-1"
APP_TG = "arn:tg/app"
WAKER_TG = "arn:tg/waker"


def _rule(target: str, host: str = "my-app.apps.example.com") -> dict[str, Any]:
    return {
        "RuleArn": "arn:rule/1",
        "Conditions": [{"Field": "host-header", "HostHeaderConfig": {"Values": [host]}}],
        "Actions": [
            {"Type": "authenticate-cognito", "Order": 1,
             "AuthenticateCognitoConfig": {"UserPoolArn": "arn:pool", "UserPoolClientId": "c1",
                                           "UserPoolDomain": "d"}},
            {"Type": "forward", "Order": 2, "TargetGroupArn": target,
             "ForwardConfig": {"TargetGroups": [{"TargetGroupArn": target, "Weight": 1}]}},
        ],
    }


def _seed_network(fake: FakeAws, rules: list[dict[str, Any]] | None = None) -> None:
    fake.on("ssm", "get-parameter", "/apphub/test/network/apps-domain",
            out={"Parameter": {"Value": "apps.example.com"}})
    fake.on("ssm", "get-parameter", "/apphub/test/network/alb/internet/1/https-listener-arn",
            out={"Parameter": {"Value": LISTENER}})
    fake.on("elbv2", "describe-target-groups", "apphub-test-app-app00001",
            out={"TargetGroups": [{"TargetGroupArn": APP_TG}]})
    fake.on("elbv2", "describe-rules", LISTENER,
            out={"Rules": rules if rules is not None else [_rule(WAKER_TG)]})
    fake.on("elbv2", "modify-rule", out={"Rules": []})


def _modify_calls(fake: FakeAws) -> list[list[str]]:
    return [c for c in fake.calls() if c[:2] == ["elbv2", "modify-rule"]]


@needs_node
def test_prepare_sleeping_app_restores_forward_keeps_cognito(fake_aws: FakeAws) -> None:
    _seed_ddb(fake_aws)
    _seed_network(fake_aws)
    res = fake_aws.run("prepare-sleeping-app.cjs", IS_INITIAL="false")
    assert res.returncode == 0, res.stderr
    mods = _modify_calls(fake_aws)
    assert len(mods) == 1
    args = mods[0]
    assert args[args.index("--rule-arn") + 1] == "arn:rule/1"
    actions = json.loads(args[args.index("--actions") + 1])
    assert actions[0]["Type"] == "authenticate-cognito"
    assert actions[0]["AuthenticateCognitoConfig"]["UserPoolClientId"] == "c1"
    assert actions[1] == {"Type": "forward", "TargetGroupArn": APP_TG, "Order": 2}
    # ECS 는 건드리지 않는다(desiredCount 0 유지).
    assert not any(c[0] == "ecs" for c in fake_aws.calls())


@needs_node
def test_prepare_idempotent_when_already_app_tg(fake_aws: FakeAws) -> None:
    _seed_ddb(fake_aws)
    _seed_network(fake_aws, rules=[_rule(APP_TG)])
    res = fake_aws.run("prepare-sleeping-app.cjs", IS_INITIAL="false")
    assert res.returncode == 0
    assert _modify_calls(fake_aws) == []


@needs_node
def test_prepare_skips_running_app(fake_aws: FakeAws) -> None:
    _seed_ddb(fake_aws, app={**APP, "runtimeState": "RUNNING"})
    _seed_network(fake_aws)
    res = fake_aws.run("prepare-sleeping-app.cjs", IS_INITIAL="false")
    assert res.returncode == 0
    assert not any(c[0] == "elbv2" for c in fake_aws.calls())


@needs_node
def test_prepare_skips_initial_deploy_without_aws_calls(fake_aws: FakeAws) -> None:
    res = fake_aws.run("prepare-sleeping-app.cjs", IS_INITIAL="true")
    assert res.returncode == 0
    assert fake_aws.calls() == []


@needs_node
def test_prepare_rule_missing_warns_and_continues(fake_aws: FakeAws) -> None:
    _seed_ddb(fake_aws)
    _seed_network(fake_aws, rules=[_rule(WAKER_TG, host="other.apps.example.com")])
    res = fake_aws.run("prepare-sleeping-app.cjs", IS_INITIAL="false")
    assert res.returncode == 0
    assert "규칙 없음" in res.stdout
    assert _modify_calls(fake_aws) == []


@needs_node
def test_prepare_modify_error_fails_build(fake_aws: FakeAws) -> None:
    _seed_ddb(fake_aws)
    fake_aws.on("elbv2", "modify-rule", exit=254, stderr="AccessDenied: elasticloadbalancing:ModifyRule")
    _seed_network(fake_aws)
    res = fake_aws.run("prepare-sleeping-app.cjs", IS_INITIAL="false")
    assert res.returncode == 1
    assert "ModifyRule" in res.stderr


@needs_node
def test_prepare_n0_legacy_listener_fallback(fake_aws: FakeAws) -> None:
    _seed_ddb(fake_aws, app={**APP, "albIndex": 0, "scheme": "internal"})
    fake_aws.on("ssm", "get-parameter", "/network/alb/internal/0/https-listener-arn",
                exit=254, stderr="An error occurred (ParameterNotFound)")
    fake_aws.on("ssm", "get-parameter", "/apphub/test/network/internal-https-listener-arn",
                out={"Parameter": {"Value": LISTENER}})
    _seed_network(fake_aws)
    res = fake_aws.run("prepare-sleeping-app.cjs", IS_INITIAL="false")
    assert res.returncode == 0, res.stderr
    assert len(_modify_calls(fake_aws)) == 1


@needs_node
def test_prepare_follows_describe_rules_marker(fake_aws: FakeAws) -> None:
    _seed_ddb(fake_aws)
    fake_aws.on("elbv2", "describe-rules", "--marker m2", out={"Rules": [_rule(WAKER_TG)]})
    fake_aws.on("elbv2", "describe-rules", LISTENER,
                out={"Rules": [_rule(WAKER_TG, host="x.apps.example.com")], "NextMarker": "m2"})
    _seed_network(fake_aws)
    res = fake_aws.run("prepare-sleeping-app.cjs", IS_INITIAL="false")
    assert res.returncode == 0, res.stderr
    assert len(_modify_calls(fake_aws)) == 1
