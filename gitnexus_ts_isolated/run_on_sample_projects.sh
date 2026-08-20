#!/usr/bin/env bash
set -e

REPO_TARGET="${1:-sample_projects/samples-java/springboot}"

echo "================================================================"
echo " Running GitNexus Tree-sitter & Graph Analyzer"
echo " Target Project: $REPO_TARGET"
echo "================================================================"

node gitnexus/gitnexus/dist/cli/index.js analyze "$REPO_TARGET" --skip-git
