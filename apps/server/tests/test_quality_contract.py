from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
SERVER_PYPROJECT = REPO_ROOT / "apps" / "server" / "pyproject.toml"
CI_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "ci.yml"


def test_canonical_server_ci_enforces_coverage_and_resource_hygiene() -> None:
    pyproject = SERVER_PYPROJECT.read_text(encoding="utf-8")
    workflow = CI_WORKFLOW.read_text(encoding="utf-8")
    runtime_config = pyproject.split("[project]", maxsplit=1)[1].split(
        "[project.optional-dependencies]", maxsplit=1
    )[0]
    dev_config = pyproject.split("[project.optional-dependencies]", maxsplit=1)[1].split(
        "[tool.setuptools.packages.find]", maxsplit=1
    )[0]
    server_job = workflow.split("  web:", maxsplit=1)[0]
    server_commands = {line.strip() for line in server_job.splitlines()}

    assert '"coverage[toml]>=7.0"' in dev_config
    assert "coverage" not in runtime_config
    assert "[tool.coverage.run]\nbranch = true\nsource = [\"app\"]" in pyproject
    assert "[tool.coverage.report]\nfail_under = 92.0" in pyproject
    assert '"error::ResourceWarning"' in pyproject
    assert '"error::pytest.PytestUnraisableExceptionWarning"' in pyproject

    assert 'PYTHONWARNINGS: "error::ResourceWarning"' in server_job
    assert "python -m coverage erase" in server_commands
    assert "python -m coverage run -m pytest" in server_commands
    assert "python -m coverage report" in server_commands
    assert "python -m pytest" not in server_commands
