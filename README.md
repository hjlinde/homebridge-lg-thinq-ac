# homebridge-lg-thinqconnect-ac

[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

Homebridge plugin for LG ThinQ air conditioners using the official [LG ThinQ Connect API](https://connect-pat.lgthinq.com).

## Requirements

- Homebridge v1.8.0 or v2.0.0+
- An LG ThinQ account with at least one air conditioner
- A Personal Access Token from the LG ThinQ Connect Developer Portal

## Getting a Personal Access Token

1. Go to [connect-pat.lgthinq.com](https://connect-pat.lgthinq.com)
2. Sign in with your LG ThinQ account
3. Create a new Personal Access Token
4. Copy the token — you will need it during plugin configuration

## Installation

Install via the **Homebridge UI**:

1. Open the Homebridge UI
2. Go to **Plugins**
3. Search for `homebridge-lg-thinqconnect-ac`
4. Click **Install**

## Configuration

After installation, configure the plugin via the Homebridge UI plugin settings:

| Field | Description | Example |
|-------|-------------|---------|
| Personal Access Token | Token from connect-pat.lgthinq.com | `eyJ...` |
| Country Code | Your two-letter country code | `DE`, `US`, `KR` |

Restart Homebridge after saving the configuration. Your air conditioners will appear automatically in HomeKit.

## Supported Features

This plugin sticks to Apple's native HomeKit `HeaterCooler` model — one accessory,
one set of standard climate controls, nothing bolted on:

- Power on/off
- Mode selection (Cool, Heat, Auto)
- Target temperature, with per-mode ranges (Heat: 16-30°C, Cool/Auto: 18-30°C, 0.5° steps)
- Current temperature (read-only)
- Fan speed, snapped to the device's real named speeds (e.g. Low/Medium/High/Auto
  map to clean 25/50/75/100% slider steps, not an arbitrary continuous range)
- Swing
- Fault status

Fan-only, Dehumidify, and independently-controllable horizontal swing exist on
some LG models but don't fit into HomeKit's `HeaterCooler` characteristics — an
earlier version of this plugin tried representing them as extra accessories,
but that didn't render reliably in the Home app and isn't scalable across
multiple AC units, so it's been dropped in favor of staying within what
HomeKit natively supports.

## How It Works

The plugin polls the LG ThinQ Connect API every 60 seconds to sync device state to HomeKit. Commands sent from HomeKit are forwarded to LG immediately.

## Supported Regions

| Region | Countries |
|--------|-----------|
| Europe, Middle East & Africa | DE, AT, CH, FR, GB, IT, ES, NL, PL, and most other countries in the region |
| Americas | US, CA, MX, BR, CL, CO, AR |
| Asia/Pacific | KR, JP, AU, NZ, TW, SG, TH, MY, ID, PH, VN, IN, CN |

## Troubleshooting

**No devices found:** Check that your Personal Access Token is valid and that your LG ThinQ account has air conditioners registered.

**Commands not working:** Ensure your country code matches the region where your LG account is registered.
