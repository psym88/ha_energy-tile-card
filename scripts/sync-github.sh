#!/usr/bin/env bash
# Syncs this repository and one of its releases to the public GitHub repository.
#
# Forgejo is the source of truth. GitHub gets the branch and the tags that exist
# here, plus the release as a GitHub release object with the file HACS installs
# as its asset, because that asset is what a download count on GitHub counts.
# What GitHub shows of a ref is the installable set, built from an include list,
# see publish_include. Nothing is ever deleted on GitHub, a published tag never
# moves, and an asset a release already carries stays where it is: uploading it
# again starts its count at zero.
set -euo pipefail

cd "$(dirname "$0")/.."

: "${GH_RELEASE_TOKEN:?GH_RELEASE_TOKEN is required}"
: "${FORGEJO_TOKEN:?FORGEJO_TOKEN is required}"
: "${FORGEJO_API_URL:?FORGEJO_API_URL is required}"
: "${FORGEJO_REPOSITORY:?FORGEJO_REPOSITORY is required}"
: "${GITHUB_DISTRIBUTION_REPOSITORY:?GITHUB_DISTRIBUTION_REPOSITORY is required}"

branch=${BRANCH:-main}
release_tag=${RELEASE_TAG:-}
github_url="https://github.com/${GITHUB_DISTRIBUTION_REPOSITORY}.git"
github_api="https://api.github.com/repos/${GITHUB_DISTRIBUTION_REPOSITORY}"
github_uploads="https://uploads.github.com/repos/${GITHUB_DISTRIBUTION_REPOSITORY}"

# The token goes into a header and never into the remote url: git repeats the
# url in its error messages and would repeat the password with it.
auth_header="Authorization: Basic $(printf 'x-access-token:%s' "$GH_RELEASE_TOKEN" | base64 -w0)"
github() { git -c "http.extraHeader=${auth_header}" "$@"; }

# What a published repository is: an include list rather than a list of things to
# leave out, so a file added to this repository is not on GitHub until somebody
# names it here. Home Assistant Marketplace reads hacs.json at the ref it installs,
# so that file is always part of the set, and so is the file it names: the asset of
# the release is what gets installed, but when a release has no asset HACS falls
# back to the files at the ref. Everything the README shows has to be named too, a
# picture that is not published is a broken picture on that page.
publish_include=()
read -r -a publish_include <<< "${PUBLISH_INCLUDE:-hacs.json README.md LICENSE images}"

# Where the file hacs.json names sits inside a commit: beside hacs.json, under
# themes/ for a theme, under dist/ for built code.
manifest_file() {
  local source=$1 name candidate
  name=$(git show "${source}:hacs.json" 2>/dev/null | json filename 2>/dev/null)
  if test -z "$name" && git show "${source}:hacs.json" 2>/dev/null | grep -q '"filename"'; then
    echo "${source} has a hacs.json with a filename that does not read as JSON." >&2
    return 1
  fi
  test -n "$name" || return 0
  for candidate in "${name}" "themes/${name}" "dist/${name}"; do
    if git cat-file -e "${source}:${candidate}" 2>/dev/null; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  echo "${source} names ${name} in hacs.json, but carries it beside itself, under themes/ or under dist/." >&2
  return 1
}

# A path is published when the list names it or names the folder it sits in.
is_published() {
  local path=$1 entry
  shift
  for entry in "$@"; do
    case "$path" in
      "$entry" | "$entry"/*) return 0 ;;
    esac
  done
  return 1
}

# The tree a ref gets on GitHub: the files of the source commit that the list
# names, plus the file hacs.json names. Entries go from the object store into a
# scratch index, so the checkout of this run is not involved, and the result is
# read back against the list: a file that slipped in is an error rather than a
# published repository that is wider than it was meant to be.
published_tree() {
  local source=$1 index tree entry mode sha path wanted
  local keep=("${publish_include[@]}")
  wanted=$(manifest_file "$source") || return 1
  if test -n "$wanted"; then
    keep+=("$wanted")
  fi
  index=$(mktemp)
  if ! GIT_INDEX_FILE="$index" git read-tree --empty; then
    rm -f "$index"
    echo "Could not build the published tree of ${source}" >&2
    return 1
  fi
  while IFS= read -r -d '' entry; do
    mode=${entry%%$'\t'*}
    sha=${entry#*$'\t'}
    sha=${sha%%$'\t'*}
    path=${entry#*$'\t'}
    path=${path#*$'\t'}
    if is_published "$path" "${keep[@]}"; then
      if ! GIT_INDEX_FILE="$index" git update-index --add --cacheinfo "${mode},${sha},${path}"; then
        rm -f "$index"
        echo "Could not add ${path} to the published tree of ${source}" >&2
        return 1
      fi
    fi
  done < <(git ls-tree -r --format='%(objectmode)%x09%(objectname)%x09%(path)%x00' "${source}^{tree}")
  tree=$(GIT_INDEX_FILE="$index" git write-tree)
  rm -f "$index"
  if test -z "$tree" || test "$(git ls-tree -r --name-only "$tree" | wc -l)" = 0; then
    echo "Publishing ${source} would leave no files at all, the include list is wrong." >&2
    return 1
  fi
  if ! git cat-file -e "${tree}:hacs.json" 2>/dev/null; then
    echo "The include list does not carry hacs.json, so the Marketplace would have nothing to read." >&2
    return 1
  fi
  while IFS= read -r -d '' entry; do
    path=${entry#*$'\t'}
    path=${path#*$'\t'}
    if ! is_published "$path" "${keep[@]}"; then
      echo "${path} is not on the include list but ended up in the published tree." >&2
      return 1
    fi
  done < <(git ls-tree -r --format='%(objectmode)%x09%(objectname)%x09%(path)%x00' "$tree")
  printf '%s\n' "$tree"
}

# The commit a ref gets on GitHub, which is the source commit with that tree and
# the source commit as its parent: the history on GitHub stays the real history,
# only what a checkout holds is the installable set. Author and date are the
# source commit's and the committer is fixed, so the same source commit always
# becomes the same published commit and a sync that has nothing new to say
# pushes nothing. A commit whose tree already is the published tree is published
# as it is.
published_commit() {
  local source=$1 tree name email date
  tree=$(published_tree "$source") || return 1
  if test "$tree" = "$(git rev-parse "${source}^{tree}")"; then
    printf '%s\n' "$source"
    return
  fi
  name=$(git show -s --format='%an' "$source")
  email=$(git show -s --format='%ae' "$source")
  date=$(git show -s --format='%aI' "$source")
  GIT_AUTHOR_NAME="$name" GIT_AUTHOR_EMAIL="$email" GIT_AUTHOR_DATE="$date" \
    GIT_COMMITTER_NAME="publish to github" GIT_COMMITTER_EMAIL="sync@forgejo.local" \
    GIT_COMMITTER_DATE="$date" \
    git commit-tree "$tree" -p "$source" \
    -m "Publish the files the Home Assistant Marketplace installs"
}

json() {
  node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk)).on("end", () => {
      let value = JSON.parse(input);
      for (const key of process.argv.slice(1)) value = value[key];
      process.stdout.write(value === undefined || value === null ? "" : String(value));
    });
  ' "$@"
}

git fetch --quiet --tags origin

# What GitHub holds becomes a ref this run knows, so that both pushes below can
# offer it while negotiating and carry nothing but what is new. A ref that
# arrives with the whole history as a fresh pack is a ref GitHub weighs commit by
# commit against its own rules, and a rule check that trips over itself answers
# "fatal error in commit_refs_rules" and leaves the ref where it was. A
# repository on GitHub that is still empty has nothing to fetch, and that is not
# an error here.
github fetch --quiet --no-tags "$github_url" \
  "+refs/heads/${branch}:refs/remotes/github/${branch}" \
  "+refs/tags/*:refs/remotes/github/tags/*" || true

# A push GitHub's own rule check tripped over says nothing about what was being
# pushed, so it is worth another attempt before the run admits it failed.
push_to_github() {
  local attempts=0
  until github push --quiet "$@"; do
    attempts=$((attempts + 1))
    if test "$attempts" = 3; then
      echo "GitHub refused the push ${attempts} times." >&2
      return 1
    fi
    echo "GitHub refused the push, trying again." >&2
    sleep 5
  done
}

echo '::group::Branch'
if git rev-parse --verify --quiet "refs/heads/${branch}" >/dev/null; then
  source_ref="refs/heads/${branch}"
else
  source_ref="refs/remotes/origin/${branch}"
fi
test -n "$(git rev-parse --verify --quiet "$source_ref")" || {
  echo "No ${branch} in this checkout to push" >&2
  exit 1
}
published=$(published_commit "$(git rev-parse "$source_ref")") || exit 1
push_to_github --force "$github_url" "${published}:refs/heads/${branch}" || exit 1
printf 'Pushed %s to %s' "$source_ref" "$branch"
if test "$published" = "$(git rev-parse "$source_ref")"; then
  printf '.\n'
else
  printf ', with only %s.\n' "$(printf '%s ' "${publish_include[@]}")"
fi
echo '::endgroup::'

echo '::group::Tags'
tags=$(git tag --list)
if test -z "$tags"; then
  echo "No tags here, nothing to push."
else
  # The peeled commit of every tag on GitHub, named refs/tags/<tag> for both tag types.
  remote_tags=$(github ls-remote --tags "$github_url" | awk '
    {
      peeled = ($2 ~ /\^\{\}$/)
      name = $2
      sub(/\^\{\}$/, "", name)
      if (peeled || !(name in sha)) sha[name] = $1
    }
    END { for (name in sha) print name, sha[name] }
  ')
  refspecs=()
  moved=""
  present=0
  while read -r tag; do
    test -n "$tag" || continue
    local_sha=$(git rev-parse "refs/tags/${tag}^{commit}")
    remote_sha=$(printf '%s\n' "$remote_tags" | awk -v name="refs/tags/${tag}" '$1 == name { print $2 }')
    if test -z "$remote_sha"; then
      published=$(published_commit "$local_sha") || exit 1
      refspecs+=("${published}:refs/tags/${tag}")
    elif test "$remote_sha" = "$local_sha"; then
      present=$((present + 1))
    elif published=$(published_commit "$local_sha") && test "$remote_sha" = "$published"; then
      # A tag published from now on carries the installable set rather than the
      # commit made here, and that is still the tag it was made from.
      present=$((present + 1))
    elif github fetch --quiet --no-tags --depth=2 "$github_url" \
        "+refs/tags/${tag}:refs/remotes/github/${tag}" &&
      test "$(git rev-parse --quiet --verify "refs/remotes/github/${tag}^" || true)" = "$local_sha"; then
      # GitHub holds a published copy of this commit: a commit with this one as its
      # parent, made here on an earlier run. It keeps the files it was published
      # with, because a published tag never moves even when the include list
      # changes later. Anything else on that sha is somebody moving the tag.
      present=$((present + 1))
    else
      moved="${moved} ${tag} (GitHub $(printf '%.7s' "$remote_sha") would become $(printf '%.7s' "$local_sha"))"
    fi
  done <<<"$tags"
  if test -n "$moved"; then
    echo "A published tag never moves: it is the version the Marketplace hands out," >&2
    echo "and its GitHub release hangs off it." >&2
    echo "Moved here:${moved}" >&2
    exit 1
  fi
  if test "${#refspecs[@]}" = 0; then
    echo "All ${present} tag(s) are already on GitHub."
  else
    # A tag is a new ref, so it is the ref GitHub's own rule check trips over.
    push_to_github "$github_url" "${refspecs[@]}" || exit 1
    echo "Pushed ${#refspecs[@]} new tag(s), ${present} already there."
  fi
fi
echo '::endgroup::'

if test -z "$release_tag"; then
  echo "No release tag given, so no release was published. Refs are up to date."
  exit 0
fi

echo '::group::Release'
release=$(curl -fsS -H "Authorization: token ${FORGEJO_TOKEN}" \
  "${FORGEJO_API_URL}/repos/${FORGEJO_REPOSITORY}/releases/tags/${release_tag}") || {
  echo "Forgejo has no release for ${release_tag}" >&2
  exit 1
}

tag_commit=$(git rev-parse --verify --quiet "refs/tags/${release_tag}^{commit}" || true)
if test -z "$tag_commit"; then
  tag_commit=$(printf '%s' "$release" | json target_commitish)
fi

payload=$(printf '%s' "$release" | GITHUB_TARGET_COMMIT="$tag_commit" node -e '
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk)).on("end", () => {
    const release = JSON.parse(input);
    process.stdout.write(JSON.stringify({
      tag_name: release.tag_name,
      name: release.name || release.tag_name,
      body: release.body || "",
      draft: false,
      prerelease: release.prerelease === true,
      target_commitish: process.env.GITHUB_TARGET_COMMIT,
    }));
  });
')

release_file=$(mktemp)
status=$(curl -sS -o "$release_file" -w '%{http_code}' \
  -H "Authorization: Bearer ${GH_RELEASE_TOKEN}" -H "Accept: application/vnd.github+json" \
  "${github_api}/releases/tags/${release_tag}")

if test "$status" = "404"; then
  method=POST
  url="${github_api}/releases"
elif test "$status" = "200"; then
  method=PATCH
  url="${github_api}/releases/$(json id <"$release_file")"
else
  echo "GitHub answered ${status} on the release of ${release_tag}" >&2
  cat "$release_file" >&2
  rm -f "$release_file"
  exit 1
fi
rm -f "$release_file"

# GitHub has answered 500 on this call while everything before it was already in
# place, which leaves a ref without its release behind. So the answer is read
# instead of dropped, its body is what a failing run shows, and the call gets
# three attempts: the same hold a refused push gets, for the one call that puts
# the release where the ref already is.
answer=$(mktemp)
created=""
attempts=0
while :; do
  attempts=$((attempts + 1))
  status=$(curl -sS -o "$answer" -w '%{http_code}' -X "$method" "$url" \
    -H "Authorization: Bearer ${GH_RELEASE_TOKEN}" -H "Accept: application/vnd.github+json" \
    -H "Content-Type: application/json" -d "$payload" || true)
  case "$status" in
    200|201)
      created=$(cat "$answer")
      break
      ;;
  esac
  if test "$attempts" = 3; then
    echo "GitHub answered ${status:-no answer} on the release of ${release_tag} ${attempts} times:" >&2
    cat "$answer" >&2
    rm -f "$answer"
    exit 1
  fi
  echo "GitHub answered ${status:-no answer} on the release of ${release_tag}, trying again." >&2
  sleep 5
done
rm -f "$answer"

html_url=$(printf '%s' "$created" | json html_url)
echo "${method} ${url}"
echo "Release ${release_tag} on GitHub: ${html_url}"
if test -n "${GITHUB_STEP_SUMMARY:-}"; then
  {
    printf '%s\n\n' "**${release_tag}** is on [${GITHUB_DISTRIBUTION_REPOSITORY}](${html_url})."
    printf '%s\n' "$(printf '%s' "$created" | json body)"
  } >>"$GITHUB_STEP_SUMMARY"
fi
echo '::endgroup::'

echo '::group::Release asset'
# The file hacs.json names is the asset of the release, because that is what HACS
# installs and what a download count on GitHub counts. An asset the release already
# carries is left alone: uploading it again starts that count from zero.
asset_path=$(manifest_file "refs/tags/${release_tag}") || exit 1
if test -z "$asset_path"; then
  echo "hacs.json at ${release_tag} names no filename, so there is no asset to upload."
else
  asset_name=$(basename "$asset_path")
  release_id=$(printf '%s' "$created" | json id)
  existing_asset=$(printf '%s' "$created" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk)).on("end", () => {
      const release = JSON.parse(input);
      const wanted = process.argv[1];
      const asset = (release.assets || []).find((item) => item.name === wanted);
      process.stdout.write(asset ? String(asset.id) : "");
    });
  ' "$asset_name")
  if test -n "$existing_asset"; then
    echo "Release ${release_tag} already carries ${asset_name} on GitHub, its download count stays as it is."
  else
    # The media type is what GitHub keeps on the asset. These are the types the
    # releases of these repositories already carry; anything else goes as bytes.
    case "$asset_name" in
      *.js) asset_type="application/javascript" ;;
      *.zip) asset_type="application/zip" ;;
      *) asset_type="application/octet-stream" ;;
    esac
    asset_file=$(mktemp)
    git show "refs/tags/${release_tag}:${asset_path}" >"$asset_file"
    answer=$(mktemp)
    upload_url="${github_uploads}/releases/${release_id}/assets?name=${asset_name}"
    status=$(curl -sS -o "$answer" -w '%{http_code}' -X POST \
      -H "Authorization: Bearer ${GH_RELEASE_TOKEN}" -H "Accept: application/vnd.github+json" \
      -H "Content-Type: ${asset_type}" \
      --data-binary "@${asset_file}" \
      "${upload_url}")
    case "$status" in
      200 | 201) uploaded=$(cat "$answer") ;;
      *)
        echo "GitHub answered ${status} on ${upload_url} with type ${asset_type}:" >&2
        cat "$answer" >&2
        rm -f "$asset_file" "$answer"
        exit 1
        ;;
    esac
    rm -f "$answer"
    asset_url=$(printf '%s' "$uploaded" | json url)
    asset_size=$(printf '%s' "$uploaded" | json size)
    # Reading the asset back is what shows GitHub stored the file byte for byte.
    curl -fsSL -H "Authorization: Bearer ${GH_RELEASE_TOKEN}" -H "Accept: application/octet-stream" \
      "$asset_url" >"${asset_file}.read-back"
    if test "$(sha256sum "$asset_file" | cut -d' ' -f1)" != \
      "$(sha256sum "${asset_file}.read-back" | cut -d' ' -f1)"; then
      echo "GitHub stored ${asset_name} with a checksum that does not match ${release_tag}" >&2
      rm -f "$asset_file" "${asset_file}.read-back"
      exit 1
    fi
    rm -f "$asset_file" "${asset_file}.read-back"
    echo "Uploaded ${asset_name} (${asset_size} bytes) as the asset of ${release_tag}, the copy on GitHub matches."
    if test -n "${GITHUB_STEP_SUMMARY:-}"; then
      printf '%s\n' "${asset_name} (${asset_size} bytes) is the downloadable asset of this release." \
        >>"$GITHUB_STEP_SUMMARY"
    fi
  fi
fi
echo '::endgroup::'
