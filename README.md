# Pellet Stove Heating Watchdog

A daemon that monitors a Wyze thermostat and automatically power-cycles a pellet stove when the fire fails to light.

## Problem

Pellet stoves sometimes fail to ignite. The thermostat shows "heating" but the temperature drops instead of rising. The fix is to power-cycle the stove to trigger a new ignition attempt.

## Solution

This watchdog:
1. Checks the thermostat every minute
2. Detects when heating but temperature is declining
3. Cycles the plug (off 10s, on) to restart ignition
4. Retries up to 3 times before giving up (likely out of pellets)

## Trigger Conditions

All must be true:
- `workingState == "heating"`
- Temperature is 2°+ below setpoint
- Temperature dropped 1°+ from recent readings

## Safety Features

- **Startup check**: Exits if plug is off (maintenance/vacation mode)
- **Max 3 cycles**: Stops retrying after 3 failed attempts
- **Setpoint tracking**: Ignores temp decline if someone lowered the setpoint
- **Plug verification**: Confirms plug actually turned on after power cycle

## Setup

1. Clone the repo
2. Copy `.env.local.example` to `.env.local` and fill in Wyze credentials
3. Install dependencies:
   ```bash
   npm install
   ```

## Usage

```bash
npm start
# or
node heating-watchdog.js
```

## Configuration

Edit `CONFIG` in `heating-watchdog.js`:

```javascript
const CONFIG = {
  checkIntervalMs: 60 * 1000,        // 1 minute
  cycleWaitMs: 10 * 60 * 1000,       // 10 minutes after power cycle
  powerOffDurationMs: 10 * 1000,     // 10 seconds off
  tempThreshold: 2,                   // degrees below setpoint to trigger
  maxCycles: 3,                       // max power cycles before giving up
  thermostatName: "Living Room",
  plugName: "Living Room",
};
```

## Dependencies

- [@caseman72/wyzer-api](https://www.npmjs.com/package/@caseman72/wyzer-api) - Wyze API client

## License

MIT
