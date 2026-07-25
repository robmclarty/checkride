"""Report formatting. Imports the names it uses, and returns strings rather than printing them."""

from pricing import LineItem, subtotal_cents


def order_summary(items: list[LineItem]) -> str:
    """One line describing a cart."""
    total = subtotal_cents(items)
    return f"{len(items)} item(s), {total} cents"
