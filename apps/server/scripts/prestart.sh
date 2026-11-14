#!/usr/bin/env bash

# TODO!: Configure this scripts before compile Dockerfile

set -e
set -x

# Initialize DB
uv run python -m app.sql_prestart

# Run migrations
uv run python -m alembic upgrade head

# Add initial information to DB
uv run python -m app.initial_data
