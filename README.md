# Pellet Stove Heating Watchdog

A daemon that monitors a Wyze thermostat and automatically power-cycles a pellet stove when the fire fails to light.

## How It Works

### Physical Setup

```
[Wyze Thermostat] → [C-Wire Adapter] → [Pellet Stove]
                          ↑
                    [Wyze Plug]
```

Pellet stoves typically don't have a C-wire (common wire) that smart thermostats need for power. A **C-wire adapter** bridges this gap, allowing a Wyze thermostat to control the stove.

The C-wire adapter is plugged into a **Wyze smart plug**. This gives us remote control over the entire heating system:

- **Plug ON**: Thermostat can control the stove normally
- **Plug OFF**: Stove is completely disabled (won't run)

### Vacation Mode

When away from home:
1. Turn off the Wyze plug remotely
2. Stove won't run, conserving pellets
3. Backup furnace keeps house above freezing
4. When heading home, turn plug back on remotely
5. By arrival, house is warm

The watchdog daemon safely handles this - if the plug is off at startup, it exits cleanly instead of trying to turn it on.

## Problem

Pellet stoves sometimes fail to ignite. The thermostat shows "heating" but the temperature drops instead of rising. The fix is to power-cycle the stove to trigger a new ignition attempt.

## Solution

This watchdog:
1. Checks the thermostat every minute
2. Waits 10 minutes when heating starts (ignition time)
3. Detects when heating but temperature is declining
4. Cycles the plug (off 10s, on) to restart ignition
5. Retries up to 3 times before giving up (likely out of pellets)
6. Resets cycle count when heating succeeds

### State Machine

```
MONITORING ──────────────────────────────────────┐
    │                                            │
    │ (idle → heating)                           │ (temp within threshold)
    ▼                                            │
WAITING_FOR_IGNITION ───(10 min)───► MONITORING ─┘
                                         │
                                         │ (heating + declining + 2°+ below)
                                         ▼
                                    POWER CYCLE
                                         │
                                         ▼
WAITING_AFTER_CYCLE ◄────────────────────┘
    │
    │ (10 min)
    ▼
MONITORING ◄─────── (3 failures) ───► FAILED (auto-recover when stove works)
```

## Trigger Conditions

All must be true:
- `workingState == "heating"`
- Temperature is 2°+ below setpoint
- Temperature dropped 1°+ from recent readings (debounce)

## Safety Features

- **Startup check**: Exits if plug is off (maintenance/vacation mode)
- **Ignition wait**: 10 minute grace period when heating starts (stove needs time to ignite)
- **Max 3 cycles**: Stops retrying after 3 failed attempts, auto-recovers when stove works
- **Auto-reset**: Cycle count resets when heating succeeds
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
