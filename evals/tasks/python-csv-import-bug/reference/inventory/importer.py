"""Load a supplier stock export into Item records."""

import csv
from decimal import Decimal, InvalidOperation

from .models import Item


class InvalidRow(ValueError):
    """A data row that cannot be turned into an Item."""


def load_items(path):
    # utf-8-sig drops the byte-order mark newer exports start with; the csv
    # module handles CRLF and quoted fields ("Widget, large", "12"" pipe").
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        if header is None:
            return []
        header = [col.strip().lower() for col in header]
        items = []
        for values in reader:
            if not any(value.strip() for value in values):
                continue
            values = [value.strip() for value in values]
            items.append(_parse_row(dict(zip(header, values)), reader.line_num))
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
