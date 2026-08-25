#!/usr/bin/env python3
"""CLI for running a framework rule pack over an LSP-native .lbug database."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

try:
    from analyzer.rules.core import RuleEngine, load_rule_pack
except ImportError:
    from core import RuleEngine, load_rule_pack


def main() -> None:
    parser = argparse.ArgumentParser(description="Run rule-based analysis over LadybugDB")
    parser.add_argument("database", help="Direct .lbug path or an indexed project")
    parser.add_argument("--pack", default="temporal", help="Rule pack under analyzer/rules/packs")
    parser.add_argument("--output", help="Write the JSON report to this path")
    parser.add_argument("--include-raw", action="store_true", help="Include every query row")
    args = parser.parse_args()

    report = RuleEngine(args.database).run(load_rule_pack(args.pack))
    payload = report.to_dict(include_raw=args.include_raw)
    rendered = json.dumps(payload, indent=2, default=str)
    if args.output:
        output = Path(args.output).expanduser().resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered + "\n", encoding="utf-8")
        print(f"Wrote {args.pack} rule report to {output}")
    else:
        print(rendered)


if __name__ == "__main__":
    main()
