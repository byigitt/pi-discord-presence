# pi-discord-presence

Discord Rich Presence extension for pi coding agent.

Client ID is preconfigured as `1378773754103988274`.

## Use locally

```bash
pnpm install
pi -e .
```

Or install this folder as a pi package:

```bash
pi install /Users/baris/Desktop/Projects/pi-discord-presence
```

Then restart pi or run `/reload`.

## Commands

Inside pi:

```text
/discord-presence         # toggle on/off
/discord-presence status
/discord-presence off
/discord-presence on
/discord-presence refresh
```

## Better Discord display

The activity name shown by Discord comes from the Discord Developer Portal application name. The extension cannot change that through RPC.
To make it lowercase, rename the application to something like `pi coding agent` or `pi dc presence` in the Developer Portal.

This repo includes pi logo assets from `https://pi.dev/logo-auto.svg`:

- `assets/pi-logo.svg`
- `assets/pi-logo.png`

Upload `assets/pi-logo.png` to the Discord application's Rich Presence assets, then set the uploaded asset key with env vars:

```bash
export PI_DISCORD_LARGE_IMAGE_KEY=pi-logo
export PI_DISCORD_SMALL_IDLE_IMAGE_KEY=pi-logo
export PI_DISCORD_SMALL_WORKING_IMAGE_KEY=pi-logo
```

You can override the app id too:

```bash
export PI_DISCORD_CLIENT_ID=1378773754103988274
```
