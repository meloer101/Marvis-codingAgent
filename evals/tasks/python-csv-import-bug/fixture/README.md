# inventory

Small tools for the stockroom. The main one imports a supplier's stock export
(CSV) and prints a summary before we load it into the shelf database.

```sh
python3 -m inventory.cli import samples/supplier_2026-06.csv
```

Export columns: `sku`, `name`, `qty`, `unit_price`, `bin`.

Standard library only (Python 3.10+). Run the tests with:

```sh
python3 -m unittest
```
