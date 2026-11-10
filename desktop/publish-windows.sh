#!/usr/bin/env bash
set -euo pipefail

tag=$1
artifacts=$2
version=${tag#v}
installer="New-World-Setup-$version-x64.exe"
sums=SHA256SUMS.txt
notes="docs/releases/$tag.md"
release_json=$(mktemp)
trap 'rm -f "$release_json"' EXIT

(cd "$artifacts" && sha256sum --check "$sums")

get_release() {
  gh api --paginate "repos/$GITHUB_REPOSITORY/releases?per_page=100" \
    --jq ".[] | select(.tag_name == \"$tag\")" > "$release_json"
}

ref="refs/tags/$tag"
refs=$(git ls-remote origin "$ref" "$ref^{}")
target=$(awk -v ref="$ref^{}" '$2 == ref { print $1 }' <<< "$refs")
if [[ -z "$target" ]]; then
  target=$(awk -v ref="$ref" '$2 == ref { print $1 }' <<< "$refs")
fi
if [[ -n "$target" && "$target" != "$GITHUB_SHA" ]]; then
  echo "$tag points to a different commit."
  exit 1
fi

get_release
if [[ ! -s "$release_json" ]]; then
  gh release create "$tag" --draft --target "$GITHUB_SHA" --title "New World $tag · Windows" --notes-file "$notes"
  get_release
elif jq -e '.draft == false and .prerelease == false' "$release_json" > /dev/null; then
  test "$target" = "$GITHUB_SHA"
  jq -e --arg name "$installer" --arg sums "$sums" \
    '([.assets[] | select(.state == "uploaded") | .name] | contains([$name, $sums]))' "$release_json" > /dev/null
  echo "$tag is already published."
  exit 0
fi

jq -e --arg target "$GITHUB_SHA" \
  '.draft and (.prerelease | not) and .target_commitish == $target' "$release_json" > /dev/null

for name in "$installer" "$sums"; do
  if ! jq -e --arg name "$name" '.assets[] | select(.name == $name)' "$release_json" > /dev/null; then
    gh release upload "$tag" "$artifacts/$name"
  fi
done

get_release
for name in "$installer" "$sums"; do
  digest="sha256:$(sha256sum "$artifacts/$name" | cut -d ' ' -f 1)"
  jq -e --arg name "$name" --arg digest "$digest" \
    '.assets[] | select(.name == $name and .state == "uploaded" and .digest == $digest)' "$release_json" > /dev/null
done

gh release edit "$tag" --draft=false --latest
gh api "repos/$GITHUB_REPOSITORY/releases/tags/$tag" \
  --jq '. | select(.draft == false and .prerelease == false) | .html_url' | grep -F "/releases/tag/$tag"
