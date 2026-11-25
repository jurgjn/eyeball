#!/usr/bin/env bash
# Install the latest build of Eyeball from main: the VSIX of the most recent successful CI run.
#
# Usage: ./install_latest.sh [CLI]
#   CLI  command that installs extensions: codium (default), code or positron. Over Remote SSH,
#        run this in the editor's integrated terminal, so that it installs on the remote host.
#
# Needs the GitHub CLI (gh), logged in: GitHub serves workflow artifacts to logged-in users only.
set -euo pipefail

repo=jurgjn/eyeball
cli=${1:-codium}

for command in gh "$cli"; do
  if ! command -v "$command" > /dev/null; then
    echo "install_latest.sh: $command not found" >&2
    exit 1
  fi
done

run=$(gh run list --repo "$repo" --workflow ci.yml --branch main --status success --limit 1 \
  --json databaseId --jq '.[0].databaseId // empty')
if [[ -z $run ]]; then
  echo "install_latest.sh: no successful CI run on main in $repo" >&2
  exit 1
fi

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
gh run download "$run" --repo "$repo" --name eyeball-vsix --dir "$dir"
shopt -s nullglob
vsix=("$dir"/eyeball-*.vsix)
if (( ${#vsix[@]} != 1 )); then
  echo "install_latest.sh: expected one VSIX in the artifact of run $run, found ${#vsix[@]}" >&2
  exit 1
fi

echo "Installing ${vsix[0]##*/} from https://github.com/$repo/actions/runs/$run"
"$cli" --install-extension "${vsix[0]}" --force
echo "Done. Reload open windows (Developer: Reload Window) to use the new version."
