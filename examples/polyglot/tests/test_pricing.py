"""Tests for the pricing module, run by the `py-test` custom check."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from pricing import LineItem, subtotal_cents, with_tax_cents


class TestPricing(unittest.TestCase):
    def test_subtotal_sums_quantity_times_price(self) -> None:
        items = [LineItem("A", 2, 500), LineItem("B", 1, 250)]
        self.assertEqual(subtotal_cents(items), 1250)

    def test_subtotal_of_empty_cart_is_zero(self) -> None:
        self.assertEqual(subtotal_cents([]), 0)

    def test_tax_rounds_to_nearest_cent(self) -> None:
        self.assertEqual(with_tax_cents(1000, 0.05), 1050)
        self.assertEqual(with_tax_cents(999, 0.05), 1049)


if __name__ == "__main__":
    unittest.main()
