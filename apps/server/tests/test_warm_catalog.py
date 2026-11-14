"""Tests for the catalog cache-warming script's object selection (no jobs run)."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "warm_catalog.py"
spec = importlib.util.spec_from_file_location("warm_catalog", SCRIPT)
warm_catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(warm_catalog)

OBJECTS = [{"id": "local-dr1-sample"}, {"id": "m101-field"}, {"id": "m81"}]


def test_no_ids_selects_every_object():
    assert warm_catalog.select_objects(OBJECTS, "") == OBJECTS


def test_known_ids_select_in_catalog_order():
    assert warm_catalog.select_objects(OBJECTS, " m81 , local-dr1-sample") == [
        OBJECTS[0],
        OBJECTS[2],
    ]


def test_renamed_id_is_refused_with_its_new_name():
    with pytest.raises(SystemExit) as exc:
        warm_catalog.select_objects(OBJECTS, "m81-field")
    assert str(exc.value) == (
        "Unknown catalog object id(s): m81-field. "
        "'m81-field' was renamed to 'm101-field' (the field is M101); "
        "use 'm81' for M81 itself."
    )


def test_unknown_id_is_refused_instead_of_warming_nothing():
    with pytest.raises(SystemExit) as exc:
        warm_catalog.select_objects(OBJECTS, "m81,nope")
    assert str(exc.value) == (
        "Unknown catalog object id(s): nope. "
        "Valid ids: local-dr1-sample, m101-field, m81."
    )
