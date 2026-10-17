#!/usr/bin/env bash
# 上游 CI 验证：在上游真仓库里换文件，跑它自己的 lint 与测试
# 用法：bash audit/upstream_ci.sh [optimized|fixed|baseline]
# 需要网络（npm 镜像）
set -uo pipefail

VARIANT="${1:-optimized}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

count_ava () { (cd "$UP" && npx ava 2>&1 | grep -cE '^  √'); }
fail_ava () { (cd "$UP" && npx ava 2>&1 | grep -E '× |[0-9]+ test' | head -4); }
lint_errors () { (cd "$UP" && npx eslint index.js 2>&1 | grep -cE '^\s+[0-9]+:[0-9]+\s+(error|warning)'); }
lint_detail () { (cd "$UP" && npx eslint index.js 2>&1 | grep -E '^\s+[0-9]+:[0-9]+' | head -20); }

echo "== 拉取上游仓库 =="
curl -sL --max-time 90 -o "$WORK/repo.tar.gz" \
  https://codeload.github.com/mafintosh/csv-parser/tar.gz/refs/heads/master || {
  echo "!! 下载失败（需要网络）"; exit 1
}
tar xzf "$WORK/repo.tar.gz" -C "$WORK"
UP="$WORK/csv-parser-master"

echo "== 上游 index.js sha1 =="
sha1sum "$UP/index.js"

echo "== 安装依赖 =="
(cd "$UP" && npm i --registry=https://registry.npmmirror.com --no-audit --no-fund >/dev/null 2>&1) || {
  echo "!! 依赖安装失败"; exit 1
}

echo
echo "===== 基线（未改动）====="
echo "ava 通过: $(count_ava)"
fail_ava | sed 's/^/  /'
echo "eslint 报错条数: $(lint_errors)"

echo
echo "===== 换成 $VARIANT ====="
cp "$REPO_ROOT/patch/$VARIANT.js" "$UP/index.js"
sha1sum "$UP/index.js"
echo
echo "ava 通过: $(count_ava)"
fail_ava | sed 's/^/  /'
echo "eslint 报错条数: $(lint_errors)"
echo "--- eslint 明细 ---"
lint_detail | sed 's/^/  /'
