import Wyzer from "@caseman72/wyzer-api";

const CONFIG = {
  checkIntervalMs: 60 * 1000,        // 1 minute
  cycleWaitMs: 10 * 60 * 1000,       // 10 minutes after power cycle
  powerOffDurationMs: 10 * 1000,     // 10 seconds off
  tempThreshold: 2,                   // degrees below setpoint to trigger
  maxCycles: 3,                       // max power cycles before giving up
  thermostatName: "Living Room",
  plugName: "Living Room",
};

// State machine states
const State = {
  MONITORING: "MONITORING",
  WAITING_FOR_IGNITION: "WAITING_FOR_IGNITION",
  WAITING_AFTER_CYCLE: "WAITING_AFTER_CYCLE",
  FAILED: "FAILED",
};

// Runtime state
let state = State.MONITORING;
let cycleCount = 0;
let lastCycleTime = null;
let ignitionStartTime = null;
let lastWorkingState = null;
let tempHistory = []; // { timestamp, temperature }
const MAX_HISTORY = 10; // Keep last 10 readings

const wyze = new Wyzer({ quiet: true });

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

function logError(message) {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] ERROR: ${message}`);
}

function addTempReading(temperature, setpoint) {
  tempHistory.push({ timestamp: Date.now(), temperature, setpoint });
  if (tempHistory.length > MAX_HISTORY) {
    tempHistory.shift();
  }
}

function isTemperatureDeclining() {
  // Need at least 2 readings to compare
  if (tempHistory.length < 2) {
    return false;
  }

  // Compare current to reading from ~2 minutes ago (or oldest if less history)
  const current = tempHistory[tempHistory.length - 1];
  const compareIndex = Math.max(0, tempHistory.length - 3); // ~2-3 min ago
  const previous = tempHistory[compareIndex];

  // If setpoint was lowered, temp decline is expected - not a problem
  if (current.setpoint < previous.setpoint) {
    log(`Setpoint lowered (${previous.setpoint}° → ${current.setpoint}°) - temp decline expected`);
    return false;
  }

  const delta = previous.temperature - current.temperature;
  const declining = delta >= 1; // Require 1°F decline to debounce noise

  if (declining) {
    log(`Temperature declining: ${previous.temperature}°F → ${current.temperature}°F (-${delta.toFixed(1)}°)`);
  }

  return declining;
}

async function getPlugByName(name) {
  const devices = await wyze.getDevices();
  return devices.find(d => d.nickname === name && d.product_type === "Plug");
}

async function getThermostatByName(name) {
  const devices = await wyze.getDevices();
  return devices.find(d => d.nickname === name && d.product_type === "Thermostat");
}

async function cyclePlug() {
  log(`Cycling power on "${CONFIG.plugName}" plug...`);

  const plug = await getPlugByName(CONFIG.plugName);
  if (!plug) {
    logError(`Could not find plug: ${CONFIG.plugName}`);
    return false;
  }

  log(`Turning OFF plug (${plug.mac})...`);
  const offSuccess = await wyze.plugOff(plug.mac, plug.product_model);
  if (!offSuccess) {
    logError(`Failed to turn off plug`);
    return false;
  }

  log(`Waiting ${CONFIG.powerOffDurationMs / 1000} seconds...`);
  await sleep(CONFIG.powerOffDurationMs);

  log(`Turning ON plug...`);
  const onSuccess = await wyze.plugOn(plug.mac, plug.product_model);
  if (!onSuccess) {
    logError(`CRITICAL: Failed to turn on plug after 3 attempts!`);
    return false;
  }

  log(`Power cycle complete (plug verified ON)`);
  return true;
}

async function checkThermostat() {
  const thermo = await getThermostatByName(CONFIG.thermostatName);
  if (!thermo) {
    logError(`Could not find thermostat: ${CONFIG.thermostatName}`);
    return null;
  }

  const data = await wyze.getThermostat(thermo.mac);
  return data;
}

async function handleMonitoring() {
  const data = await checkThermostat();
  if (!data) return;

  const tempDiff = data.heatSetpoint - data.temperature;
  const isHeating = data.workingState === "heating";
  const isBelowThreshold = tempDiff >= CONFIG.tempThreshold;

  // Detect transition to heating - give ignition time to work
  if (isHeating && lastWorkingState !== "heating") {
    log(`Heating started - waiting 10 minutes for ignition`);
    ignitionStartTime = Date.now();
    tempHistory = []; // Clear history for fresh readings
    lastWorkingState = data.workingState;
    state = State.WAITING_FOR_IGNITION;
    return;
  }
  lastWorkingState = data.workingState;

  addTempReading(data.temperature, data.heatSetpoint);

  const isDeclining = isTemperatureDeclining();

  log(`Status: ${data.temperature}°F (setpoint: ${data.heatSetpoint}°F, diff: ${tempDiff.toFixed(1)}°) | ` +
      `workingState: ${data.workingState} | cycles: ${cycleCount}/${CONFIG.maxCycles}`);

  // Reset cycles when heating is working (temp within threshold or not heating)
  if (cycleCount > 0 && (!isHeating || !isBelowThreshold)) {
    log(`Heating successful - resetting cycle count`);
    cycleCount = 0;
  }

  // Check if we need to intervene
  if (isHeating && isBelowThreshold && isDeclining) {
    log(`PROBLEM DETECTED: Heating but temperature declining and ${tempDiff.toFixed(1)}° below setpoint`);

    if (cycleCount >= CONFIG.maxCycles) {
      log(`Max cycles (${CONFIG.maxCycles}) reached. Entering FAILED state.`);
      log(`>>> USER INTERVENTION REQUIRED <<<`);
      state = State.FAILED;
      return;
    }

    // Cycle the power
    const success = await cyclePlug();
    if (success) {
      cycleCount++;
      lastCycleTime = Date.now();
      state = State.WAITING_AFTER_CYCLE;
      log(`Power cycle ${cycleCount}/${CONFIG.maxCycles} complete. Waiting 10 minutes before next check.`);
    }
  }
}

async function handleWaitingForIgnition() {
  const elapsed = Date.now() - ignitionStartTime;
  const remaining = CONFIG.cycleWaitMs - elapsed;

  if (remaining > 0) {
    log(`Waiting for ignition... ${Math.ceil(remaining / 1000 / 60)} minutes remaining`);
    return;
  }

  log(`Ignition wait complete. Resuming monitoring.`);
  tempHistory = [];
  state = State.MONITORING;
}

async function handleWaitingAfterCycle() {
  const elapsed = Date.now() - lastCycleTime;
  const remaining = CONFIG.cycleWaitMs - elapsed;

  if (remaining > 0) {
    log(`Waiting after cycle... ${Math.ceil(remaining / 1000 / 60)} minutes remaining`);
    return;
  }

  log(`Wait period complete. Resuming monitoring.`);
  // Clear temp history so we get fresh readings for decline detection
  tempHistory = [];
  state = State.MONITORING;
}

async function handleFailed() {
  const data = await checkThermostat();
  if (!data) return;

  const tempDiff = data.heatSetpoint - data.temperature;
  const isHeating = data.workingState === "heating";
  const isBelowThreshold = tempDiff >= CONFIG.tempThreshold;

  log(`FAILED STATE: ${data.temperature}°F (diff: ${tempDiff.toFixed(1)}°) | workingState: ${data.workingState} | Waiting...`);

  // Check if problem resolved - either not heating or temp is within threshold
  if (!isHeating || !isBelowThreshold) {
    log(`Stove recovered - ${!isHeating ? "heating stopped" : "temp within threshold"}`);
    log(`Resetting cycle count and resuming monitoring.`);
    cycleCount = 0;
    tempHistory = [];
    state = State.MONITORING;
  }
}

async function tick() {
  try {
    switch (state) {
      case State.MONITORING:
        await handleMonitoring();
        break;
      case State.WAITING_FOR_IGNITION:
        await handleWaitingForIgnition();
        break;
      case State.WAITING_AFTER_CYCLE:
        await handleWaitingAfterCycle();
        break;
      case State.FAILED:
        await handleFailed();
        break;
    }
  } catch (error) {
    logError(`Tick failed: ${error.message}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  log("=== Heating Watchdog Starting ===");
  log(`Config: check every ${CONFIG.checkIntervalMs / 1000}s, ` +
      `cycle wait ${CONFIG.cycleWaitMs / 1000 / 60}min, ` +
      `threshold ${CONFIG.tempThreshold}°, ` +
      `max cycles ${CONFIG.maxCycles}`);

  // Login to Wyze
  log("Logging in to Wyze API...");
  await wyze.login();
  log("Logged in successfully");

  // Verify we can find the devices
  const thermo = await getThermostatByName(CONFIG.thermostatName);
  const plug = await getPlugByName(CONFIG.plugName);

  if (!thermo) {
    logError(`Thermostat "${CONFIG.thermostatName}" not found!`);
    process.exit(1);
  }
  if (!plug) {
    logError(`Plug "${CONFIG.plugName}" not found!`);
    process.exit(1);
  }

  log(`Found thermostat: ${thermo.mac}`);
  log(`Found plug: ${plug.mac}`);

  // Safety check: if plug is off at startup, exit (cleaning/vacation mode)
  const plugIsOn = await wyze.isPlugOn(plug.mac, plug.product_model);
  if (!plugIsOn) {
    log("Plug is OFF at startup - assuming maintenance/vacation mode. Exiting.");
    process.exit(0);
  }
  log("Plug is ON - starting monitoring loop...");

  // Initial check
  await tick();

  // Main loop
  setInterval(tick, CONFIG.checkIntervalMs);
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  log("\nShutting down...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("\nShutting down...");
  process.exit(0);
});

main().catch(error => {
  logError(`Fatal error: ${error.message}`);
  process.exit(1);
});
