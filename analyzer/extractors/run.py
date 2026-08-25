#!/usr/bin/env python3
"""CLI for semantic extraction from an LSP-native .lbug database."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

try:
    from analyzer.extractors.core import ExtractionPipeline, load_extractor
except ImportError:
    from core import ExtractionPipeline, load_extractor


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Extract framework semantics from LadybugDB evidence"
    )
    parser.add_argument("database", help="Direct .lbug path or an indexed project")
    parser.add_argument(
        "--extractor",
        default="temporal",
        help="Semantic extractor under analyzer/extractors",
    )
    parser.add_argument("--output", help="Write the JSON report to this path")
    parser.add_argument("--include-raw", action="store_true", help="Include every query row")
    args = parser.parse_args()

    report = ExtractionPipeline(args.database).run(load_extractor(args.extractor))
    payload = report.to_dict(include_raw=args.include_raw)
    rendered = json.dumps(payload, indent=2, default=str)
    if args.output:
        output = Path(args.output).expanduser().resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered + "\n", encoding="utf-8")
        print(f"Wrote {args.extractor} extraction report to {output}")
    else:
        print(rendered)


if __name__ == "__main__":
    main()
