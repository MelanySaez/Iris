"""Typed environment configuration tests."""

from __future__ import annotations

from app.core.config import APP_DIR, DATA_DIR, SERVER_DIR, Settings


def test_runtime_data_lives_in_the_server_directory():
    # apps/server/data is git-ignored; a data dir under app/ would leak cache into git.
    assert (SERVER_DIR / "pyproject.toml").is_file()
    assert APP_DIR == SERVER_DIR / "app"
    assert DATA_DIR == SERVER_DIR / "data"


def test_settings_parse_comma_separated_cors_origins(monkeypatch):
    monkeypatch.setenv("CORS_ORIGINS", "https://one.example, https://two.example")

    settings = Settings(_env_file=None)

    assert settings.CORS_ORIGINS == ["https://one.example", "https://two.example"]


def test_settings_ignore_empty_environment_values(monkeypatch):
    monkeypatch.setenv("SIMBAD_SCRIPT_URL", "")

    settings = Settings(_env_file=None)

    assert settings.SIMBAD_SCRIPT_URL == (
        "https://simbad.cfa.harvard.edu/simbad/sim-script"
    )


def test_process_environment_overrides_env_file(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("NED_LOOKUP_URL=https://file.example/lookup\n")
    monkeypatch.setenv("NED_LOOKUP_URL", "https://process.example/lookup")

    settings = Settings(_env_file=env_file)

    assert settings.NED_LOOKUP_URL == "https://process.example/lookup"
