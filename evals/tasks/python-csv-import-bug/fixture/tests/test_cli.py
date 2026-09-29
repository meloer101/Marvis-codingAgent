import io
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from inventory.cli import main

SAMPLES = Path(__file__).resolve().parent.parent / "samples"


class CliTest(unittest.TestCase):
    def test_import_prints_a_summary(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = main(["import", str(SAMPLES / "supplier_2026-06.csv")])
        self.assertEqual(code, 0)
        self.assertIn("7 items, 970 units, total value 869.50", out.getvalue())
        self.assertIn("Teflon tape", out.getvalue())


if __name__ == "__main__":
    unittest.main()
