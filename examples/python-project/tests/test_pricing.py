"""Tests for the pricing module, run by pytest in the `test` slot."""

from pricing import LineItem, subtotal_cents, with_tax_cents


def test_subtotal_sums_quantity_times_price() -> None:
    items = [LineItem("A", 2, 500), LineItem("B", 1, 250)]
    assert subtotal_cents(items) == 1250


def test_subtotal_of_empty_cart_is_zero() -> None:
    assert subtotal_cents([]) == 0


def test_tax_rounds_to_nearest_cent() -> None:
    assert with_tax_cents(1000, 0.05) == 1050
    assert with_tax_cents(999, 0.05) == 1049
