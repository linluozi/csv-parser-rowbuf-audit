# NOTICE

本仓库的 `upstream/index.js` 与 `patch/*.js` 派生自
[`mafintosh/csv-parser`](https://github.com/mafintosh/csv-parser) v3.2.1，
Copyright (c) 2014 Mathias Buus，MIT License。

`LICENSE` 与上游 `LICENSE` 逐字节一致（sha1 `a95ab3a4b0e4bd978897f09b3b430a449da20a08`）。

## 相对上游的改动

`patch/optimized.js`、`patch/fixed.js`、`patch/submission.js` 修改了上游 `_transform`
的部分行缓冲策略，并给 `parseLine` 增加了一个 `byteOffset` 参数。公共工厂 API 未变。

`patch/baseline.js` 是包内提供的重排版副本，仅用于对照，无逻辑改动。

## 免责

本仓库是对第三方优化包的独立审查记录，不代表上游维护者的意见或背书。
