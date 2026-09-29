"""Command line entry point: python3 -m inventory.cli import <file>"""

import argparse
import sys

from .importer import InvalidRow, load_items


def format_summary(path, items):
    lines = [f"{'SKU':<10}{'NAME':<30}{'QTY':>6}{'UNIT PRICE':>12}  BIN"]
    for item in items:
        lines.append(f"{item.sku:<10}{item.name:<30}{item.qty:>6}{item.unit_price:>12}  {item.bin}")
    units = sum(item.qty for item in items)
    value = sum((item.value for item in items), start=0)
    lines.append("")
    lines.append(f"{path}: {len(items)} items, {units} units, total value {value:.2f}")
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="inventory")
    commands = parser.add_subparsers(dest="command", required=True)
    import_cmd = commands.add_parser("import", help="load a supplier CSV export and print a summary")
    import_cmd.add_argument("file")
    args = parser.parse_args(argv)

    try:
        items = load_items(args.file)
    except InvalidRow as err:
        print(f"error: {args.file}: {err}", file=sys.stderr)
        return 1
    print(format_summary(args.file, items))
    return 0


if __name__ == "__main__":
    sys.exit(main())
