"""Load a supplier stock export into Item records."""

from decimal import Decimal, InvalidOperation

from .models import Item


class InvalidRow(ValueError):
    """A data row that cannot be turned into an Item."""


def load_items(path):
    with open(path, encoding="utf-8") as f:
        lines = f.read().splitlines()
    if not lines:
        return []

    header = [col.strip().lower() for col in lines[0].split(",")]
    items = []
    for lineno, line in enumerate(lines[1:], start=2):
        if not line.strip():
            continue
        values = [value.strip() for value in line.split(",")]
        items.append(_parse_row(dict(zip(header, values)), lineno))
    return items


def _parse_row(row, lineno):
    sku = row["sku"]
    if not sku:
        raise InvalidRow(f"line {lineno}: sku is empty")
    try:
        qty = int(row["qty"])
    except ValueError:
        raise InvalidRow(f"line {lineno}: qty must be a whole number, got {row['qty']!r}") from None
    try:
        unit_price = Decimal(row["unit_price"])
    except InvalidOperation:
        raise InvalidRow(f"line {lineno}: unit_price is not a number, got {row['unit_price']!r}") from None
    return Item(sku=sku, name=row["name"], qty=qty, unit_price=unit_price, bin=row.get("bin", ""))
