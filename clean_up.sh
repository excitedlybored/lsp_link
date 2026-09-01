#!/usr/bin/env bash
set -euo pipefail

script_root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)

usage() {
  cat <<'EOF'
Usage:
  ./clean_up.sh REPOSITORY [options]

Default behavior removes abandoned indexing residue while preserving the
published graph and reusable caches.

Options:
  --dry-run     Show what would be removed without changing anything.
  --caches      Also remove crawl checkpoints, JDT source caches, and retained
                JVM artifacts. The next index will repeat this work.
  --shared-jdt-cache
                Also remove the shared external-JAR index used by every JDT
                run. This can be several GiB and will be rebuilt on demand.
  --graph       Also remove the published .gitnexus/lsp-lbug graph.
  --bazel       Also run `bazel clean --expunge` in the repository.
  --all         Remove the repository's entire .gitnexus directory.
  --yes         Confirm --all, --bazel, or --shared-jdt-cache without an
                interactive prompt.
  -h, --help    Show this help.

Examples:
  ./clean_up.sh /path/to/repository --dry-run
  ./clean_up.sh /path/to/repository
  ./clean_up.sh /path/to/repository --caches
  ./clean_up.sh /path/to/repository --shared-jdt-cache --yes
  ./clean_up.sh /path/to/repository --all --bazel --yes
EOF
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

if [ "$#" -eq 0 ]; then
  usage >&2
  exit 2
fi

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
esac

repository_input=$1
shift
dry_run=false
remove_caches=false
remove_shared_jdt_cache=false
remove_graph=false
remove_all=false
clean_bazel=false
confirmed=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=true ;;
    --caches) remove_caches=true ;;
    --shared-jdt-cache) remove_shared_jdt_cache=true ;;
    --graph) remove_graph=true ;;
    --bazel) clean_bazel=true ;;
    --all) remove_all=true ;;
    --yes) confirmed=true ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

[ -d "$repository_input" ] || die "Repository directory does not exist: $repository_input"
repository=$(cd "$repository_input" && pwd -P)
[ "$repository" != "/" ] || die "Refusing to clean the filesystem root"
[ -e "$repository/.git" ] || die "Target is not a Git worktree: $repository"

gitnexus="$repository/.gitnexus"
if [ ! -e "$gitnexus" ]; then
  printf 'Nothing to clean: %s does not exist.\n' "$gitnexus"
  exit 0
fi

active_processes=$(ps -axo pid=,command= | while IFS= read -r process_line; do
  case "$process_line" in
    *lsp-link*"$repository"*|*indexer/src/cli/build.ts*"$repository"*)
      printf '%s\n' "$process_line"
      ;;
  esac
done)
if [ -n "$active_processes" ]; then
  printf 'An indexing process appears to be using this repository:\n%s\n' "$active_processes" >&2
  die "Stop the indexing process before cleaning"
fi

pid_file="$gitnexus/index.pid"
if [ -f "$pid_file" ]; then
  recorded_pid=$(tr -d '[:space:]' < "$pid_file")
  if [[ "$recorded_pid" =~ ^[0-9]+$ ]] && kill -0 "$recorded_pid" 2>/dev/null; then
    die "Index PID $recorded_pid is still running"
  fi
fi

confirm() {
  local message=$1
  if [ "$confirmed" = true ] || [ "$dry_run" = true ]; then return 0; fi
  if [ ! -t 0 ]; then die "$message; pass --yes to confirm"; fi
  printf '%s [y/N] ' "$message"
  read -r answer
  case "$answer" in y|Y|yes|YES) ;; *) die "Cleanup cancelled" ;; esac
}

safe_remove() {
  local target=$1
  local allowed=false
  case "$target" in
    "$gitnexus"|"$gitnexus"/*) allowed=true ;;
    "$temporary_root/gitnexus-jdt-projects/$repository_hash"|"$temporary_root"/gitnexus-kotlin-lsp-*) allowed=true ;;
    "$shared_jdt_cache") allowed=true ;;
  esac
  [ "$allowed" = true ] || die "Refusing unsafe cleanup target: $target"
  if [ ! -e "$target" ] && [ ! -L "$target" ]; then return 0; fi
  if [ "$dry_run" = true ]; then
    printf '[dry-run] remove %s\n' "$target"
  else
    printf 'Removing %s\n' "$target"
    rm -rf "$target"
  fi
}

repository_kib=$(du -sk "$gitnexus" 2>/dev/null | awk '{print $1}')
repository_kib=${repository_kib:-0}
printf 'Repository: %s\n' "$repository"
printf 'Index data before cleanup: %s MiB\n' "$((repository_kib / 1024))"

temporary_root=$(node -e 'const fs=require("node:fs"),os=require("node:os"); console.log(fs.realpathSync(os.tmpdir()))')
repository_hash=$(node -e 'const c=require("node:crypto"),p=require("node:path"); process.stdout.write(c.createHash("sha256").update(p.resolve(process.argv[1])).digest("hex").slice(0,16))' "$repository")
if [ -n "${GITNEXUS_JDT_SHARED_INDEX_DIR:-}" ]; then
  shared_jdt_cache=$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$GITNEXUS_JDT_SHARED_INDEX_DIR")
else
  shared_jdt_cache="$script_root/.gitnexus/cache/jdtls/external-indexes"
fi
user_home=$(node -e 'console.log(require("node:os").homedir())')
case "$shared_jdt_cache" in
  /|"$user_home"|"$repository"|"$script_root")
    die "Refusing broad shared JDT cache path: $shared_jdt_cache"
    ;;
esac
shared_jdt_cache_kib=0
if [ -e "$shared_jdt_cache" ]; then
  shared_jdt_cache_kib=$(du -sk "$shared_jdt_cache" 2>/dev/null | awk '{print $1}')
  shared_jdt_cache_kib=${shared_jdt_cache_kib:-0}
fi

if [ "$remove_all" = true ]; then
  [ "$repository" != "$script_root" ] || die "--all cannot target the LSP Link tool repository because it contains installed runtimes"
  confirm "Remove all generated index data under $gitnexus?"
  safe_remove "$gitnexus"
else
  # These files are useful only during an active or resumable in-progress
  # stage. A completed or failed crawl can recreate them safely.
  safe_remove "$gitnexus/jdtls/batch-output"
  for target in "$gitnexus"/lsp-lbug.partial-*; do
    [ -e "$target" ] || continue
    safe_remove "$target"
  done
  if [ -f "$pid_file" ]; then safe_remove "$pid_file"; fi

  consolidated="$gitnexus/jdtls/consolidated-sources"
  if [ -d "$consolidated" ]; then
    while IFS= read -r target; do safe_remove "$target"; done < <(
      find "$consolidated" -mindepth 1 -maxdepth 1 -type d \( \
        -name '.*.tmp-*' -o -name '.*.invalid-*' -o -name '*.rebuild-*' \
      \) -print
    )
  fi

  safe_remove "$temporary_root/gitnexus-jdt-projects/$repository_hash"
  if ! pgrep -f '[i]ntellij-server' >/dev/null 2>&1; then
    for target in "$temporary_root"/gitnexus-kotlin-lsp-*; do
      [ -e "$target" ] || continue
      safe_remove "$target"
    done
  else
    printf 'Keeping Kotlin temporary directories because a Kotlin server is running.\n'
  fi

  if [ "$remove_caches" = true ]; then
    safe_remove "$gitnexus/lsp-lbug.checkpoints"
    safe_remove "$gitnexus/jdtls/consolidated-sources"
    safe_remove "$gitnexus/jdtls/bazel-sources"
    safe_remove "$gitnexus/jvm-artifacts"
  fi

  if [ "$remove_graph" = true ]; then
    safe_remove "$gitnexus/lsp-lbug"
    safe_remove "$gitnexus/lsp-lbug.wal"
  fi
fi

if [ "$remove_shared_jdt_cache" = true ]; then
  confirm "Remove the shared JDT external-index cache at $shared_jdt_cache?"
  safe_remove "$shared_jdt_cache"
fi

if [ "$clean_bazel" = true ]; then
  command -v bazel >/dev/null 2>&1 || die "bazel is not available on PATH"
  confirm "Expunge Bazel outputs for $repository? The next build will be slower."
  if [ "$dry_run" = true ]; then
    printf '[dry-run] (cd %s && bazel shutdown && bazel clean --expunge)\n' "$repository"
  else
    (cd "$repository" && bazel shutdown && bazel clean --expunge)
  fi
fi

remaining_kib=0
if [ -e "$gitnexus" ]; then
  remaining_kib=$(du -sk "$gitnexus" 2>/dev/null | awk '{print $1}')
  remaining_kib=${remaining_kib:-0}
fi
if [ "$dry_run" = true ]; then
  printf 'Dry run complete; nothing was removed.\n'
else
  reclaimed_kib=$((repository_kib - remaining_kib))
  if [ "$reclaimed_kib" -lt 0 ]; then reclaimed_kib=0; fi
  printf 'Cleanup complete. Repository index data reclaimed: %s MiB; remaining: %s MiB.\n' \
    "$((reclaimed_kib / 1024))" "$((remaining_kib / 1024))"
  if [ "$remove_shared_jdt_cache" = true ]; then
    printf 'Shared JDT cache reclaimed: %s MiB.\n' "$((shared_jdt_cache_kib / 1024))"
  fi
fi
