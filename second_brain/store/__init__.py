"""The service's durable state, and the only SQL in the tree.

``engine`` owns every statement; the migrations beside it own every DDL. A
business module that needs a new query adds a method here rather than a query
there, which is what keeps "this row belongs to this subject" a property of
one file instead of a rule twelve handlers are trusted to remember.
"""

from __future__ import annotations

from second_brain.store.engine import (
    MIGRATIONS_DIR,
    DeviceRow,
    DocumentRow,
    Store,
    StoreUnavailable,
)

__all__ = [
    "MIGRATIONS_DIR",
    "DeviceRow",
    "DocumentRow",
    "Store",
    "StoreUnavailable",
]
