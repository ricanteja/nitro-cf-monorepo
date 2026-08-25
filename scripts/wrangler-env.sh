#!/usr/bin/env bash
#
# Substitute deploy-time placeholders in a wrangler config, in place.
#
# Wrangler configs have no variable interpolation, so the deployed names are
# written as [[PLACEHOLDER]] and filled in here. Placeholders only ever appear
# inside `env:` blocks — the top level is real, prefix-free, local-development
# configuration, which is why `pnpm dev` needs none of this.
#
# Usage: wrangler-env.sh <config> <prefix> [pr_number] [d1_id] [zone]
set -euo pipefail

config="${1:?usage: wrangler-env.sh <config> <prefix> [pr_number] [d1_id] [zone]}"
prefix="${2:?missing prefix}"
pr_number="${3:-}"
d1_id="${4:-}"
zone="${5:-}"

[ -f "$config" ] || { echo "::error::no such config: $config" >&2; exit 1; }

env_label="prod"
[ -n "$pr_number" ] && env_label="pr-${pr_number}"

# A deploy reads exactly ONE environment, so placeholders belonging to the other
# one are inert — but the leftover check below cannot tell the two apart, and
# without this a production deploy fails on the `pr-[[PR_NUM]]` block it is
# never going to read. Giving them a value that is obviously not a real resource
# keeps the check strict about the placeholders that DO matter.
pr_number="${pr_number:-not-a-preview}"

# BLOCKS BETWEEN `/*<zone*/` AND `/*zone>*/` EXIST ONLY WHEN A PREVIEW ZONE IS
# CONFIGURED.
#
# They hold the custom-domain route and the `workers_dev: false` that goes with
# it. A fork with no zone of its own should still get a working preview, so
# rather than requiring the variable, the whole block is deleted and wrangler
# falls back to its default of publishing on workers.dev.
#
# A RANGE rather than a marker per line: prettier reflows a long `routes` entry
# across several lines, and a per-line marker would not survive that — it would
# delete the closing bracket and leave the rest, which is the kind of breakage
# that produces a confusing parse error rather than an obvious one.
#
# Only `web` has such a block. Every other worker is unroutable in every
# environment and has no hostname to configure.
if [ -n "$zone" ]; then
    sed -i "s|\[\[ZONE\]\]|${zone}|g" "$config"
    sed -i '/\/\*<zone\*\//d; /\/\*zone>\*\//d' "$config"
else
    sed -i '/\/\*<zone\*\//,/\/\*zone>\*\//d' "$config"
fi

sed -i "s|\[\[PREFIX\]\]|${prefix}|g" "$config"
sed -i "s|\[\[PR_NUM\]\]|${pr_number}|g" "$config"
[ -n "$d1_id" ] && sed -i "s|\[\[D1_ID\]\]|${d1_id}|g" "$config"

# Fail loudly on anything left over. Without this a forgotten substitution
# deploys a worker literally bound to a database called "[[D1_ID]]", which
# fails much later and much less obviously than it should.
if grep -q '\[\[' "$config"; then
    echo "::error::unsubstituted placeholders remain in ${config}" >&2
    grep -n '\[\[' "$config" >&2
    exit 1
fi

echo "configured ${config} (prefix=${prefix}, env=${env_label}, zone=${zone:-none})"
