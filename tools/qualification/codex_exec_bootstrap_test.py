"""Deterministic and opt-in native checks for the Codex exec bootstrap."""

from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).parent))

import codex_exec_bootstrap as bootstrap  # noqa: E402


class FakeResult:
    def __init__(self, code: int, out: str = "", err: str = "") -> None:
        self.returncode = code
        self.stdout = out
        self.stderr = err


GLOBAL_HELP = "usage: codex [OPTIONS] [COMMAND]\n  --ask-for-approval <POLICY>"
EXEC_HELP = "usage: codex exec [OPTIONS]\n  --cd <DIR>\n  --sandbox <MODE>\n  --output-last-message <FILE>"


class ContractTests(unittest.TestCase):
    def test_full_cli_option_order_is_exact(self) -> None:
        repo = Path("C:/EveOS")
        final = Path("C:/EveOS/results/final.txt")
        self.assertEqual(
            bootstrap.build_argv("codex.cmd", repo, final),
            [
                "codex.cmd", "--ask-for-approval", "never", "exec",
                "--cd", str(repo), "--sandbox", "workspace-write",
                "--output-last-message", str(final), "-",
            ],
        )

    def test_version_probe_uses_safe_global_order_without_inference(self) -> None:
        self.assertEqual(
            bootstrap.version_probe_argv("codex.cmd"),
            ["codex.cmd", "--ask-for-approval", "never", "exec", "--version"],
        )

    def test_parser_error_is_known_pre_dispatch_failure(self) -> None:
        error = "error: unexpected argument '--ask-for-approval' found\nUsage: codex exec [OPTIONS]"
        self.assertEqual(bootstrap.classify_cli_error(error), "CLI_PARSER_REJECTED")

    def test_non_parser_failure_remains_unknown(self) -> None:
        self.assertEqual(
            bootstrap.classify_cli_error("error: transport closed after dispatch"),
            "UNKNOWN_EXECUTION_OUTCOME",
        )

    def test_supported_flags_survive_cli_version_drift(self) -> None:
        calls: list[list[str]] = []

        def fake_run(argv: list[str], **_kwargs: object) -> FakeResult:
            calls.append(argv)
            results = [
                FakeResult(0, GLOBAL_HELP),
                FakeResult(0, EXEC_HELP),
                FakeResult(0, "codex-cli-exec 9.7.3"),
            ]
            return results[len(calls) - 1]

        with patch.object(bootstrap.subprocess, "run", side_effect=fake_run):
            version, policy = bootstrap.check_contract("codex.cmd")

        self.assertEqual(version, "codex-cli-exec 9.7.3")
        self.assertEqual(calls[-1], bootstrap.version_probe_argv("codex.cmd"))
        self.assertEqual(
            policy,
            {
                "approvalMode": "never",
                "sandboxMode": "workspace-write",
                "noUnsafeFallback": True,
            },
        )

    def test_global_flag_drift_fails_closed_before_probe(self) -> None:
        with patch.object(
            bootstrap.subprocess,
            "run",
            return_value=FakeResult(0, "usage: codex [OPTIONS]"),
        ) as run:
            with self.assertRaisesRegex(bootstrap.BootstrapBlocked, "global flag") as caught:
                bootstrap.check_contract("codex.cmd")

        self.assertEqual(caught.exception.failure_class, "SUPPORTED_FLAG_DRIFT")
        self.assertEqual(run.call_count, 1)

    def test_similar_global_flag_name_does_not_satisfy_contract(self) -> None:
        with patch.object(
            bootstrap.subprocess,
            "run",
            return_value=FakeResult(0, "usage: codex\n  --ask-for-approval-mode <POLICY>"),
        ):
            with self.assertRaises(bootstrap.BootstrapBlocked) as caught:
                bootstrap.check_contract("codex.cmd")

        self.assertEqual(caught.exception.failure_class, "SUPPORTED_FLAG_DRIFT")

    def test_exec_flag_drift_never_downgrades_permissions(self) -> None:
        with patch.object(
            bootstrap.subprocess,
            "run",
            side_effect=[FakeResult(0, GLOBAL_HELP), FakeResult(0, "--cd --output-last-message")],
        ) as run:
            with self.assertRaisesRegex(bootstrap.BootstrapBlocked, "--sandbox") as caught:
                bootstrap.check_contract("codex.cmd")

        self.assertEqual(caught.exception.failure_class, "SUPPORTED_FLAG_DRIFT")
        flattened = " ".join(" ".join(call.args[0]) for call in run.call_args_list)
        self.assertNotIn("danger-full-access", flattened)
        self.assertNotIn("on-request", flattened)
        self.assertEqual(run.call_count, 2)

    def test_version_probe_parser_rejection_is_classified(self) -> None:
        with patch.object(
            bootstrap.subprocess,
            "run",
            side_effect=[
                FakeResult(0, GLOBAL_HELP), FakeResult(0, EXEC_HELP),
                FakeResult(2, err="error: unexpected argument '--ask-for-approval' found\nUsage: codex exec"),
            ],
        ):
            with self.assertRaises(bootstrap.BootstrapBlocked) as caught:
                bootstrap.check_contract("codex.cmd")

        self.assertEqual(caught.exception.failure_class, "CLI_PARSER_REJECTED")

    def test_preflight_error_filter_redacts_secrets_and_discards_noise(self) -> None:
        safe = bootstrap._safe_cli_lines(
            "Authorization: Bearer abcdef\napi_key=SUPERSECRET\n"
            "unexpected argument --ask-for-approval\nPRIVATE_PROVIDER_MESSAGE\n"
        )
        self.assertNotIn("abcdef", safe)
        self.assertNotIn("SUPERSECRET", safe)
        self.assertNotIn("PRIVATE_PROVIDER_MESSAGE", safe)
        self.assertIn("unexpected argument", safe)


class TloTriageTests(unittest.TestCase):
    def test_offline_tlo_is_blocked_without_request(self) -> None:
        request = Mock(side_effect=AssertionError("offline TLO must not be called"))

        def unavailable() -> None:
            raise RuntimeError("EveOS unavailable: HTTP 503")

        result = bootstrap.triage_with_tlo(
            "error: unexpected argument", validate=unavailable, request=request,
        )
        self.assertEqual(result["status"], "LIVE_TLO_BLOCKED")
        self.assertEqual(result["mode"], "READ_ONLY")
        request.assert_not_called()

    def test_tlo_result_is_advisory_read_only_and_field_bounded(self) -> None:
        captured: list[str] = []

        def request(prompt: str) -> tuple[dict, str, list[dict]]:
            captured.append(prompt)
            return (
                {
                    "classification": "PREFLIGHT_PARSER_REJECTED",
                    "firstCausalFailure": "Global option followed exec.",
                    "confidence": "high",
                    "nextCheck": "Inspect the installed CLI help.",
                    "reason": "The parser rejected the option before dispatch.",
                    "shellCommand": "codex exec --dangerously-bypass-approvals-and-sandbox",
                    "retry": True,
                },
                "raw",
                [],
            )

        result = bootstrap.triage_with_tlo(
            "error: unexpected argument", validate=lambda: None, request=request,
        )
        self.assertEqual(result["status"], "TRIAGED_READ_ONLY")
        self.assertEqual(result["mode"], "READ_ONLY")
        self.assertFalse(result["executionAuthorized"])
        self.assertNotIn("shellCommand", result["analysis"])
        self.assertNotIn("retry", result["analysis"])
        self.assertIn("No shell commands", captured[0])
        self.assertIn("No retries", captured[0])


class RunSafetyTests(unittest.TestCase):
    def _fixture(self, directory: str) -> tuple[Path, Path, Path]:
        root = Path(directory)
        repo = root / "repo"
        repo.mkdir()
        mission = root / "mission.txt"
        mission.write_text("synthetic mission", encoding="utf-8")
        return repo, mission, root / "results"

    def _args(self, repo: Path, mission: Path, result: Path) -> list[str]:
        return [
            "--repo", str(repo), "--mission", str(mission),
            "--result-dir", str(result),
            "--expected-branch", "eve/nexus-machine-spaces",
            "--expected-head", "a" * 40, "--preflight-only",
        ]

    def test_unexpected_branch_blocks_before_cli_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo, mission, result = self._fixture(directory)
            with patch.object(
                bootstrap, "read_git_state",
                return_value={"branch": "main", "head": "a" * 40},
            ), patch.object(bootstrap, "check_contract") as contract:
                code = bootstrap.run(self._args(repo, mission, result))
            report = json.loads(
                (result / "codex-cli-bootstrap.json").read_text(encoding="utf-8")
            )

        self.assertEqual(code, 2)
        self.assertEqual(report["status"], "PREFLIGHT_BLOCKED_NO_EXECUTION")
        self.assertEqual(report["failureClass"], "UNEXPECTED_BRANCH")
        self.assertEqual(report["observedBranch"], "main")
        contract.assert_not_called()

    def test_unexpected_head_blocks_before_cli_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo, mission, result = self._fixture(directory)
            with patch.object(
                bootstrap, "read_git_state",
                return_value={"branch": "eve/nexus-machine-spaces", "head": "b" * 40},
            ), patch.object(bootstrap, "check_contract") as contract:
                code = bootstrap.run(self._args(repo, mission, result))
            report = json.loads(
                (result / "codex-cli-bootstrap.json").read_text(encoding="utf-8")
            )

        self.assertEqual(code, 2)
        self.assertEqual(report["failureClass"], "UNEXPECTED_HEAD")
        self.assertEqual(report["observedHead"], "b" * 40)
        contract.assert_not_called()

    def test_preflight_only_never_dispatches_mission(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo, mission, result = self._fixture(directory)
            with patch.object(
                bootstrap, "read_git_state",
                return_value={"branch": "eve/nexus-machine-spaces", "head": "a" * 40},
            ), patch.object(bootstrap, "find_codex_executable", return_value="codex.cmd"), patch.object(
                bootstrap, "check_contract",
                return_value=("codex-cli-exec 1.0", {
                    "approvalMode": "never", "sandboxMode": "workspace-write",
                    "noUnsafeFallback": True,
                }),
            ), patch.object(bootstrap.subprocess, "run") as execute:
                code = bootstrap.run(self._args(repo, mission, result))

        self.assertEqual(code, 0)
        execute.assert_not_called()

    def test_unknown_execution_outcome_is_not_retried(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo, mission, result = self._fixture(directory)
            args = self._args(repo, mission, result)
            args.remove("--preflight-only")

            def failed_execution(_argv: list[str], **kwargs: object) -> FakeResult:
                kwargs["stdout"].write(b"error: transport closed after dispatch\n")
                return FakeResult(73)

            with patch.object(
                bootstrap, "read_git_state",
                return_value={"branch": "eve/nexus-machine-spaces", "head": "a" * 40},
            ), patch.object(bootstrap, "find_codex_executable", return_value="codex.cmd"), patch.object(
                bootstrap, "check_contract",
                return_value=("codex-cli-exec 1.0", {
                    "approvalMode": "never", "sandboxMode": "workspace-write",
                    "noUnsafeFallback": True,
                }),
            ), patch.object(bootstrap.subprocess, "run", side_effect=failed_execution) as execute, patch.object(
                bootstrap, "triage_with_tlo",
                return_value={"status": "LIVE_TLO_BLOCKED", "mode": "READ_ONLY"},
            ):
                code = bootstrap.run(args)
            report = json.loads(
                (result / "codex-cli-bootstrap.json").read_text(encoding="utf-8")
            )

        self.assertEqual(code, 73)
        self.assertEqual(execute.call_count, 1)
        self.assertEqual(report["status"], "EXECUTION_FAILED_OR_UNCERTAIN")
        self.assertEqual(report["failureClass"], "UNKNOWN_EXECUTION_OUTCOME")
        self.assertEqual(report["automaticRetry"], "FORBIDDEN")

    def test_parser_like_post_dispatch_output_stays_uncertain_and_private(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo, mission, result = self._fixture(directory)
            args = self._args(repo, mission, result)
            args.remove("--preflight-only")

            def parser_failure(_argv: list[str], **kwargs: object) -> FakeResult:
                kwargs["stdout"].write(
                    b"error: unexpected argument PRIVATE_MODEL_CANARY found\nUsage: codex exec\n"
                )
                return FakeResult(2)

            with patch.object(
                bootstrap, "read_git_state",
                return_value={"branch": "eve/nexus-machine-spaces", "head": "a" * 40},
            ), patch.object(bootstrap, "find_codex_executable", return_value="codex.cmd"), patch.object(
                bootstrap, "check_contract",
                return_value=("codex-cli-exec 1.0", {
                    "approvalMode": "never", "sandboxMode": "workspace-write",
                    "noUnsafeFallback": True,
                }),
            ), patch.object(bootstrap.subprocess, "run", side_effect=parser_failure) as execute, patch.object(
                bootstrap, "triage_with_tlo",
                return_value={"status": "LIVE_TLO_BLOCKED", "mode": "READ_ONLY"},
            ) as triage:
                code = bootstrap.run(args)
            report = json.loads(
                (result / "codex-cli-bootstrap.json").read_text(encoding="utf-8")
            )

        self.assertEqual(code, 2)
        self.assertEqual(execute.call_count, 1)
        self.assertEqual(report["status"], "EXECUTION_FAILED_OR_UNCERTAIN")
        self.assertEqual(report["failureClass"], "UNKNOWN_EXECUTION_OUTCOME")
        self.assertEqual(report["automaticRetry"], "FORBIDDEN")
        self.assertTrue(report["localLogReviewRequired"])
        self.assertNotIn("PRIVATE_MODEL_CANARY", json.dumps(report))
        self.assertNotIn("PRIVATE_MODEL_CANARY", triage.call_args.args[0])


class NativeInstallationTests(unittest.TestCase):
    def test_installed_codex_contract_without_model_inference(self) -> None:
        executable = bootstrap.find_codex_executable()
        if not executable:
            self.fail("Codex CLI is not installed")
        version, policy = bootstrap.check_contract(executable)
        self.assertTrue(version)
        self.assertEqual(policy["approvalMode"], "never")
        self.assertEqual(policy["sandboxMode"], "workspace-write")


def main() -> int:
    native = "--native" in sys.argv
    verbose = "--verbose" in sys.argv
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ContractTests)
    suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(TloTriageTests))
    suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(RunSafetyTests))
    if native:
        suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(NativeInstallationTests))

    output = io.StringIO()
    child_stdout = io.StringIO()
    with redirect_stdout(child_stdout):
        result = unittest.TextTestRunner(
            stream=output, verbosity=2 if verbose else 0,
        ).run(suite)
    if result.wasSuccessful():
        print(
            "CODEX_EXEC_BOOTSTRAP_TEST_OK "
            f"({result.testsRun - len(result.skipped)}/{result.testsRun}, "
            f"native={str(native).lower()})"
        )
        return 0

    artifact = ROOT / "data" / "runtime" / "smoke-results" / "codex-exec-bootstrap-test.log"
    artifact.parent.mkdir(parents=True, exist_ok=True)
    diagnostics = output.getvalue() + child_stdout.getvalue()
    artifact.write_text(diagnostics, encoding="utf-8")
    lines = [line for line in diagnostics.splitlines() if line.strip()][-38:]
    print("CODEX_EXEC_BOOTSTRAP_TEST_FAIL", file=sys.stderr)
    print("\n".join(line[:700] for line in lines), file=sys.stderr)
    print(f"DIAGNOSTIC {artifact.relative_to(ROOT).as_posix()}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
