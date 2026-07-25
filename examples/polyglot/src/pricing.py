"""Order pricing. Pure functions over plain data — no printing, no I/O."""

from dataclasses import dataclass


@dataclass(frozen=True)
class LineItem:
    """A quantity of one SKU at a fixed unit price, in cents."""

    sku: str
    quantity: int
    unit_cents: int


def subtotal_cents(items: list[LineItem]) -> int:
    """Subtotal for a cart, in cents."""
    return sum(item.quantity * item.unit_cents for item in items)


def with_tax_cents(subtotal: int, rate: float) -> int:
    """Apply a tax rate, rounding to the nearest cent."""
    return subtotal + round(subtotal * rate)
