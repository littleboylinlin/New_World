#!/usr/bin/env bash
set -euo pipefail

tag=$1
artifacts=$2
version=${tag#v}
installer="New-World-Setup-$version-x64.exe"
sums=SHA256SUMS.txt
languages=('New-World-lang-zh-CN.json' 'New-World-lang-en.json')
notes="docs/releases/$tag.md"
title="New World $tag · Windows"
api="repos/$GITHUB_REPOSITORY/releases"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
release_json="$work/release.json"
asset_json="$work/asset.json"

(cd "$artifacts" && sha256sum --check "$sums")

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

# An unpublished draft can have a temporary tag while keeping its intended title and commit.
gh api --paginate "$api?per_page=100" | jq -sc --arg tag "$tag" --arg title "$title" --arg commit "$GITHUB_SHA" '
  [.[][] | select(.tag_name == $tag or (.draft and .name == $title and .target_commitish == $commit))]
  | if length > 1 then error("Multiple releases match this tag") else .[0] // empty end
' > "$release_json"
if [[ ! -s "$release_json" ]]; then
  # Use the creation response. A new draft may not appear immediately in the release list.
  gh api --method POST "$api" -f tag_name="$tag" -f target_commitish="$GITHUB_SHA" \
    -f name="$title" -F draft=true -F "body=@$notes" > "$release_json"
elif jq -e '.draft == false and .prerelease == false' "$release_json" > /dev/null; then
  test "$target" = "$GITHUB_SHA"
  jq -e --arg name "$installer" --arg sums "$sums" --arg zh "${languages[0]}" --arg en "${languages[1]}" \
    '([.assets[] | select(.state == "uploaded") | .name] | contains([$name, $sums, $zh, $en]))' "$release_json" > /dev/null
  echo "$tag is already published."
  exit 0
fi

jq -e --arg target "$GITHUB_SHA" --arg title "$title" \
  '.draft and (.prerelease | not) and .target_commitish == $target and .name == $title' "$release_json" > /dev/null
release_id=$(jq -er '.id | numbers' "$release_json")

for name in "$installer" "${languages[@]}" "$sums"; do
  jq -c --arg name "$name" '.assets[] | select(.name == $name)' "$release_json" > "$asset_json"
  if [[ ! -s "$asset_json" ]]; then
    printf 'header = "Authorization: Bearer %s"\n' "$GH_TOKEN" | \
      curl --config - --fail --silent --show-error --max-time 180 \
        -H 'Accept: application/vnd.github+json' -H 'Content-Type: application/octet-stream' \
        --data-binary "@$artifacts/$name" "https://uploads.github.com/$api/$release_id/assets?name=$name" > "$asset_json"
  fi
  jq -e --arg name "$name" '.name == $name and .state == "uploaded"' "$asset_json" > /dev/null
  digest="sha256:$(sha256sum "$artifacts/$name" | cut -d ' ' -f 1)"
  actual=$(jq -r '.digest // empty' "$asset_json")
  if [[ -z "$actual" ]]; then
    asset_id=$(jq -er '.id | numbers' "$asset_json")
    actual="sha256:$(gh api -H 'Accept: application/octet-stream' "$api/assets/$asset_id" | sha256sum | cut -d ' ' -f 1)"
  fi
  if [[ "$actual" != "$digest" ]]; then
    echo "SHA-256 mismatch: $name"
    exit 1
  fi
  echo "Verified release asset: $name"
done

gh api --method PATCH "$api/$release_id" -f tag_name="$tag" -F draft=false -f make_latest=true | \
  jq -er --arg tag "$tag" 'select(.tag_name == $tag and .draft == false and .prerelease == false) | .html_url'
