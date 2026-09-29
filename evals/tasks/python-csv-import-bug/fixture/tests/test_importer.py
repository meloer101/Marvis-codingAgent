import os
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

from inventory.importer import InvalidRow, load_items
from inventory.models import Item

SAMPLES = Path(__file__).resolve().parent.parent / "samples"


class LoadItemsTest(unittest.TestCase):
    def test_june_export(self):
        items = load_items(SAMPLES / "supplier_2026-06.csv")
        self.assertEqual(len(items), 7)
        self.assertEqual(items[0], Item("B-1001", "Hex bolt M8", 250, Decimal("0.18"), "A1"))
        self.assertEqual(items[-1].name, "Rubber gasket 40mm")
        self.assertEqual(sum(item.qty for item in items), 970)

    def test_skips_blank_lines(self):
        path = self._write("sku,name,qty,unit_price,bin\nA-1,Anchor,3,1.00,D1\n\nA-2,Anchor XL,1,2.50,D1\n\n")
        self.assertEqual([item.sku for item in load_items(path)], ["A-1", "A-2"])

    def test_bad_qty_reports_the_line(self):
        path = self._write("sku,name,qty,unit_price,bin\nA-1,Anchor,3,1.00,D1\nA-2,Anchor XL,two,2.50,D1\n")
        with self.assertRaisesRegex(InvalidRow, "line 3"):
            load_items(path)

    def test_empty_file(self):
        self.assertEqual(load_items(self._write("")), [])

    def _write(self, text):
        fd, path = tempfile.mkstemp(suffix=".csv")
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        self.addCleanup(os.remove, path)
        return path


if __name__ == "__main__":
    unittest.main()
