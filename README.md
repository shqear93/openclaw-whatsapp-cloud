# openclaw-whatsapp-cloud

[![CI](https://github.com/shqear93/openclaw-whatsapp-cloud/actions/workflows/ci.yml/badge.svg)](https://github.com/shqear93/openclaw-whatsapp-cloud/actions/workflows/ci.yml)
[![Release Please](https://github.com/shqear93/openclaw-whatsapp-cloud/actions/workflows/release-please.yml/badge.svg)](https://github.com/shqear93/openclaw-whatsapp-cloud/actions/workflows/release-please.yml)
[![npm version](https://img.shields.io/npm/v/openclaw-whatsapp-cloud.svg)](https://www.npmjs.com/package/openclaw-whatsapp-cloud)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

A production-grade [OpenClaw](https://github.com/openclaw/openclaw) channel plugin that connects your OpenClaw agent to Meta's **WhatsApp Business Cloud API** — inbound webhooks, outbound replies (text, voice, images), and an agent-driven delivery model instead of naive auto-reply.

This isn't a proof-of-concept: it's the real integration behind a live, production WhatsApp assistant, refined through several rounds of real incidents and fixes. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full as-built design, including the mistakes that shaped it.

## Features

- **Inbound webhooks** — Meta signature verification, text and voice-note ingestion, read receipts, typing indicators that survive long-running turns.
- **Voice notes in, voice notes out** — Deepgram STT (with a worked-out multilingual model/language strategy) and Cartesia TTS, wired through a direct API integration that bypasses a real bug in the framework's own audio model-override path.
- **Agent-driven reply delivery** — replies are sent via explicit tools (`send_text_reply_for_whatsapp`, `send_voice_reply_for_whatsapp`), not automatic passthrough. The agent decides text vs. voice per turn; nothing leaks to the channel until it deliberately sends something.
- **Image generation** — a `generate_image_for_whatsapp` tool wired for reliable delivery (no base64-in-context hallucination failure mode).
- **Control-command aware** — `/reset` and friends are delivered as plain text, never wrapped in the "no explicit send" fallback warning.
- **150+ tests** covering webhook parsing, signature verification, delivery routing, STT/TTS fallback ladders, and known regressions.

## Installation

```bash
openclaw plugins install openclaw-whatsapp-cloud
```

Or manually, as a local plugin:

```bash
cd your-openclaw-project/plugins
git clone https://github.com/shqear93/openclaw-whatsapp-cloud.git whatsapp-cloud
cd whatsapp-cloud && npm install
```

## Configuration

Set up a [Meta WhatsApp Business Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api) app, then configure these environment variables:

| Variable | Required | Description |
| --- | --- | --- |
| `WHATSAPP_ACCESS_TOKEN` | yes | Meta Cloud API access token |
| `WHATSAPP_PHONE_NUMBER_ID` | yes | Meta phone number id |
| `WHATSAPP_APP_SECRET` | yes | Meta app secret, used for webhook signature verification |
| `WHATSAPP_VERIFY_TOKEN` | yes | Webhook verification token (you choose this) |
| `OPENROUTER_API_KEY` | for images | Used by `generate_image_for_whatsapp` |
| `DEEPGRAM_API_KEY` | for voice notes | Speech-to-text |
| `CARTESIA_API_KEY` | for voice replies | Text-to-speech |
| `WHATSAPP_STT_MODEL` | no | Defaults to `nova-3` |
| `WHATSAPP_STT_LANGUAGE` | no | Defaults to `ar`; see [`ARCHITECTURE.md`](./ARCHITECTURE.md) §3.3 for why |
| `WHATSAPP_TTS_LANGUAGE` | no | Overrides only the primary STT model's language |
| `WHATSAPP_CARTESIA_MODEL` | no | Defaults to `sonic-3` |
| `WHATSAPP_CARTESIA_VOICE_ID` | no | Cartesia voice id |

In your OpenClaw config:

```json
{
  "channels": {
    "whatsapp-cloud": {
      "dmPolicy": "allowlist",
      "allowFrom": ["15550001234"]
    }
  }
}
```

Grant your agent the tools it needs:

```json
{
  "agents": {
    "list": [
      {
        "id": "whatsapp",
        "tools": {
          "allow": [
            "read", "write", "image", "message",
            "generate_image_for_whatsapp",
            "send_text_reply_for_whatsapp",
            "send_voice_reply_for_whatsapp"
          ]
        }
      }
    ]
  }
}
```

## Documentation

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — full design doc: dispatch flow, delivery model, STT/TTS design decisions (with diagrams), and known limitations.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — how to get set up and submit changes.

## Development

Uses [mise](https://mise.jdx.dev) to pin the Node version and provide task shortcuts:

```bash
mise install
mise run install   # npm ci
mise run test      # run the full suite
mise run typecheck
mise run build
```

Plain `npm ci && npm test` works the same without mise. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for details.

## License

[MIT](./LICENSE)
