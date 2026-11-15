#!/usr/bin/env bash

set -e
set -x

# Initialize DB
uv run python -m app.sql_prestart

# Run migrations
uv run python -m alembic upgrade head
