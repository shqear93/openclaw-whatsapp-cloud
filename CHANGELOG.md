# Changelog

## [1.2.1](https://github.com/shqear93/openclaw-whatsapp-cloud/compare/v1.2.0...v1.2.1) (2026-07-20)


### Bug Fixes

* **inbound:** mark inbound image messages as read and start typing ([4bfef1c](https://github.com/shqear93/openclaw-whatsapp-cloud/commit/4bfef1cfe950be1d148f0c5222391ae1677c371f))
* **inbound:** reply with a clear message instead of silence when media download fails ([4c3bc1a](https://github.com/shqear93/openclaw-whatsapp-cloud/commit/4c3bc1a0e3ee1acea89843ed60649f0d89d04758))

## [1.2.0](https://github.com/shqear93/openclaw-whatsapp-cloud/compare/v1.1.0...v1.2.0) (2026-07-17)


### Features

* **inbound:** support inbound WhatsApp image messages ([2c18462](https://github.com/shqear93/openclaw-whatsapp-cloud/commit/2c18462b5d27a9dd8e73d66283f529aee4e1eedb))


### Bug Fixes

* **ci:** restore the npm upgrade step -- confirmed load-bearing ([856a9cb](https://github.com/shqear93/openclaw-whatsapp-cloud/commit/856a9cb35faa37d79b037c161e4259f4ce71e199))

## [1.1.0](https://github.com/shqear93/openclaw-whatsapp-cloud/compare/v1.0.0...v1.1.0) (2026-07-17)


### Features

* adopt mise for tooling + add a GitHub secrets sync task ([202b133](https://github.com/shqear93/openclaw-whatsapp-cloud/commit/202b13303b6063a128c30b92fe08e7181e67a7f7))


### Bug Fixes

* **ci:** bump publish workflow to Node 22 -- npm@latest refuses Node 20 ([6e0dc46](https://github.com/shqear93/openclaw-whatsapp-cloud/commit/6e0dc46c43d24a4489f400d1f097ef9e14c95e44))
* **ci:** make releases actually trigger the npm publish workflow ([4914e7c](https://github.com/shqear93/openclaw-whatsapp-cloud/commit/4914e7c8e22bd615775caa7411cf4aadec8f1808))
* **ci:** upgrade npm before publish -- OIDC needs npm &gt;= 11.5.1 ([5b5a551](https://github.com/shqear93/openclaw-whatsapp-cloud/commit/5b5a55150746866fd4be293f6e8e1144d5a725c1))

## 1.0.0 (2026-07-17)


### Features

* initial standalone release of the OpenClaw WhatsApp Cloud plugin ([9818ce3](https://github.com/shqear93/openclaw-whatsapp-cloud/commit/9818ce37b4f9683f4a756d943878387c629fcd4f))
