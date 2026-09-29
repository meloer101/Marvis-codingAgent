from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True)
class Item:
    sku: str
    name: str
    qty: int
    unit_price: Decimal
    bin: str

    @property
    def value(self) -> Decimal:
        return self.unit_price * self.qty
