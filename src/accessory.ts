import {
  PlatformAccessory,
  Service,
  CharacteristicValue,
} from 'homebridge';
import { LgThinQAcPlatform } from './platform';
import { DeviceInfo, controlErrorDetail } from './api';
import {
  AC_MODE,
  AC_OPERATION,
  TEMPERATURE_MIN_C,
  TEMPERATURE_MAX_C,
  WIND_STRENGTH_TO_PCT,
  buildWindStrengthPctTable,
  pctToWindStrength,
  windStrengthMinStep,
} from './settings';

interface AcState {
  isOn: boolean;
  mode: string;
  /** Last real HEAT/COOL/AUTO selection, distinct from `mode` (which the device
   * can also independently report as FAN/AIR_DRY via its own physical/app
   * control, even though this plugin no longer offers a way to select those). */
  lastConventionalMode: string;
  currentTempC: number;
  targetTempC: number;
  windStrength: string;
  swingUpDown: boolean;
  hasFault: boolean;
}

interface TempRange {
  min: number;
  max: number;
  step: number;
}

/**
 * Which optional features the device actually supports, derived from its
 * profile. We only expose (and send control commands for) supported features,
 * so unsupported ones (e.g. swing on a model without it) can't fail and drag
 * the whole accessory into "No Response" in HomeKit. When no profile is
 * available we fall back to exposing everything, matching prior behaviour.
 */
interface Capabilities {
  hasProfile: boolean;
  swingUpDown: boolean;
  swingLeftRight: boolean;
  windStrength: boolean;
  windStrengthValues?: string[];
  modes?: Set<string>;
  heatTempRange?: TempRange;
  coolTempRange?: TempRange;
  autoTempRange?: TempRange;
}

export class AirConditionerAccessory {
  private readonly service: Service;
  private readonly caps: Capabilities;
  private windStrengthPct: Record<string, number> = WIND_STRENGTH_TO_PCT;
  /** Chains sendControl() calls so only one hits LG's API at a time — see sendControl(). */
  private controlQueue: Promise<void> = Promise.resolve();
  private state: AcState = {
    isOn: false,
    mode: AC_MODE.COOL,
    lastConventionalMode: AC_MODE.COOL,
    currentTempC: 22,
    targetTempC: 22,
    windStrength: 'AUTO',
    swingUpDown: false,
    hasFault: false,
  };

  constructor(
    private readonly platform: LgThinQAcPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly device: DeviceInfo,
    profile?: Record<string, unknown>,
  ) {
    const { Service, Characteristic } = platform;
    const caps = parseCapabilities(profile);
    this.caps = caps;
    const windStrengthPct = caps.windStrengthValues
      ? buildWindStrengthPctTable(caps.windStrengthValues)
      : WIND_STRENGTH_TO_PCT;
    this.windStrengthPct = windStrengthPct;

    this.platform.log.info(
      `[${device.alias}] Capabilities: swing=${caps.swingUpDown || caps.swingLeftRight} `
      + `(upDown=${caps.swingUpDown}, leftRight=${caps.swingLeftRight}), windStrength=${caps.windStrength}, `
      + `modes=${caps.modes ? [...caps.modes].join('/') : 'unknown'}`
      + (caps.hasProfile ? '' : ' (no profile — exposing all features)'),
    );

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'LG')
      .setCharacteristic(Characteristic.Model, device.modelName || 'AC')
      .setCharacteristic(Characteristic.SerialNumber, device.deviceId);

    this.service = this.accessory.getService(Service.HeaterCooler)
      ?? this.accessory.addService(Service.HeaterCooler);
    this.service.setPrimaryService(true);
    this.service.setCharacteristic(Characteristic.Name, device.alias);

    // Clean up services from earlier plugin versions that bolted extra
    // functions (Fan Only/Dehumidify/Horizontal Swing/Natural Wind) directly
    // onto this accessory — this plugin now sticks to Apple's native
    // HeaterCooler model only, so any leftovers from those experiments need
    // to be removed rather than linger as stale/duplicate controls.
    const staleFanOnly = this.accessory.getServiceById(Service.Fanv2, 'fan-only');
    if (staleFanOnly) {
      this.accessory.removeService(staleFanOnly);
    }
    for (const subtype of ['dehumidify', 'horizontal-swing', 'natural-wind']) {
      const stale = this.accessory.getServiceById(Service.Switch, subtype);
      if (stale) {
        this.accessory.removeService(stale);
      }
    }

    this.service.getCharacteristic(Characteristic.Active)
      .onGet(() =>
        this.state.isOn ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE,
      )
      .onSet(async (value: CharacteristicValue) => {
        this.state.isOn = value === Characteristic.Active.ACTIVE;
        await this.sendControl('Power', {
          operation: { airConOperationMode: this.state.isOn ? AC_OPERATION.ON : AC_OPERATION.OFF },
        }, { requiresPower: false });
      });

    this.service.getCharacteristic(Characteristic.CurrentHeaterCoolerState)
      .onGet(() => this.currentHcState());

    const targetModeChar = this.service.getCharacteristic(Characteristic.TargetHeaterCoolerState);
    const validModes = this.homekitTargetModes(caps.modes);
    if (validModes && validModes.length > 0) {
      targetModeChar.setProps({ validValues: validModes });
    }
    targetModeChar
      .onGet(() => this.targetModeCharValue(this.state.lastConventionalMode))
      .onSet(async (value: CharacteristicValue) => {
        switch (value) {
          case Characteristic.TargetHeaterCoolerState.HEAT: this.state.mode = AC_MODE.HEAT; break;
          case Characteristic.TargetHeaterCoolerState.AUTO: this.state.mode = AC_MODE.AUTO; break;
          default: this.state.mode = AC_MODE.COOL;
        }
        this.state.lastConventionalMode = this.state.mode;
        await this.sendControl('Mode', {
          airConJobMode: { currentJobMode: this.state.mode },
        });
        this.applyTempRangeProps(this.state.mode);
        this.service.updateCharacteristic(
          Characteristic.CurrentHeaterCoolerState, this.currentHcState(),
        );
      });

    this.service.getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => this.state.currentTempC);

    this.service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .onGet(() => this.state.targetTempC)
      .onSet(async (value: CharacteristicValue) => {
        this.state.targetTempC = value as number;
        await this.sendControl('Temperature', {
          temperature: { targetTemperature: value },
        });
      });

    this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .onGet(() => this.state.targetTempC)
      .onSet(async (value: CharacteristicValue) => {
        this.state.targetTempC = value as number;
        await this.sendControl('Temperature', {
          temperature: { targetTemperature: value },
        });
      });

    // Bounds depend on the currently selected mode (Heat: 16-30°C, Cool/Auto:
    // 18-30°C, both 0.5° steps per the device profile) — set them for the
    // starting mode; onSet/updateState() re-apply them whenever mode changes.
    this.applyTempRangeProps(this.state.mode);

    // HeaterCooler doesn't declare StatusFault as required or optional, so it must
    // be registered explicitly or hap-nodejs logs a warning every time it's accessed.
    this.service.addOptionalCharacteristic(Characteristic.StatusFault);
    this.service.getCharacteristic(Characteristic.StatusFault)
      .onGet(() => this.state.hasFault
        ? Characteristic.StatusFault.GENERAL_FAULT
        : Characteristic.StatusFault.NO_FAULT,
      );

    // RotationSpeed and SwingMode are optional characteristics: only expose them
    // when the device supports them, and strip them from cached accessories that
    // no longer (or never did) support them so stale controls stop erroring.
    if (caps.windStrength) {
      // minStep snaps the slider to exactly the device's named speeds (e.g. 25 for
      // a 4-step LOW/MID/HIGH/AUTO device: 25/50/75/100) instead of an arbitrary
      // continuous 1-100 range that silently rounds to the nearest real speed.
      const minStep = windStrengthMinStep(this.windStrengthPct);
      this.service.getCharacteristic(Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 100, minStep })
        .onGet(() => this.windStrengthPct[this.state.windStrength] ?? 100)
        .onSet(async (value: CharacteristicValue) => {
          const strength = pctToWindStrength(value as number, this.windStrengthPct);
          this.state.windStrength = strength;
          await this.sendControl('WindStrength', {
            airFlow: { windStrength: strength },
          });
        });
    } else {
      this.removeCharacteristicIfPresent(Characteristic.RotationSpeed);
    }

    const swing = caps.swingUpDown || caps.swingLeftRight;
    if (swing) {
      this.service.getCharacteristic(Characteristic.SwingMode)
        .onGet(() =>
          this.state.swingUpDown
            ? Characteristic.SwingMode.SWING_ENABLED
            : Characteristic.SwingMode.SWING_DISABLED,
        )
        .onSet(async (value: CharacteristicValue) => {
          const enabled = value === Characteristic.SwingMode.SWING_ENABLED;
          this.state.swingUpDown = enabled;
          const windDirection: Record<string, boolean> = {};
          if (caps.swingUpDown) windDirection['rotateUpDown'] = enabled;
          if (caps.swingLeftRight) windDirection['rotateLeftRight'] = enabled;
          await this.sendControl('SwingMode', { windDirection });
        });
    } else {
      this.removeCharacteristicIfPresent(Characteristic.SwingMode);
    }

    this.refreshState();
  }

  /** Sends a control command and logs LG's actual error detail on failure. */
  /**
   * Sends a control command and logs LG's actual error detail on failure.
   *
   * Calls are serialized per device via `controlQueue`: a HomeKit Scene sets
   * several characteristics at once (e.g. Active, both temperature thresholds,
   * SwingMode, RotationSpeed), and HAP-NodeJS fires all of those onSet handlers
   * essentially simultaneously. Without serialization, that sends several
   * overlapping requests to LG's API at once — which it appears to reject
   * outright (a generic "Fail device control" error), even though each request
   * is individually valid. A single tap only ever changes one characteristic,
   * so it was never affected. Queuing ensures only one control call to this
   * device is ever in flight at a time, regardless of how many characteristics
   * change together.
   *
   * `requiresPower` (default true) skips the call entirely if the unit is off
   * at execution time — climate parameters (mode/temperature/swing/fan speed)
   * are meaningless while off, and some units implicitly power back on when
   * they receive one. This matters for exactly the same Scene scenario above:
   * a "turn off" Scene's batch can include those other characteristics too,
   * and forwarding them after the power-off would undo it. The check is read
   * lazily when this call's turn in the queue actually runs (not when it's
   * enqueued), so if Active's onSet already flipped `state.isOn` to false
   * earlier in the same batch — synchronously, before any queued call has had
   * a chance to execute — this correctly sees the final value regardless of
   * which characteristic HomeKit happened to send first.
   */
  private sendControl(
    label: string, body: Record<string, unknown>, opts: { requiresPower?: boolean } = {},
  ): Promise<void> {
    const requiresPower = opts.requiresPower ?? true;
    const run = async () => {
      if (requiresPower && !this.state.isOn) {
        this.platform.log.info(`[${this.device.alias}] Skipping ${label} — device is off.`);
        return;
      }
      try {
        await this.platform.thinqApi.controlDevice(this.device.deviceId, body);
      } catch (err) {
        this.platform.log.error(
          `[${this.device.alias}] ${label} control failed: ${controlErrorDetail(err)}`,
        );
        throw err; // let HomeKit surface "No Response" for this characteristic
      }
    };
    const result = this.controlQueue.then(run, run);
    // The queue tail must never reject, or the next queued call would never run.
    this.controlQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private removeCharacteristicIfPresent(char: any) {
    if (this.service.testCharacteristic(char)) {
      this.service.removeCharacteristic(this.service.getCharacteristic(char));
    }
  }

  /** Maps the device's writable job modes to the HomeKit TargetHeaterCoolerState values. */
  private homekitTargetModes(modes?: Set<string>): number[] | undefined {
    if (!modes) return undefined;
    const { Characteristic } = this.platform;
    const values = new Set<number>();
    for (const m of modes) {
      if (m === AC_MODE.HEAT) values.add(Characteristic.TargetHeaterCoolerState.HEAT);
      else if (m === AC_MODE.AUTO) values.add(Characteristic.TargetHeaterCoolerState.AUTO);
      else if (m === AC_MODE.COOL) values.add(Characteristic.TargetHeaterCoolerState.COOL);
    }
    // If none of the modes map to a HomeKit state, don't restrict (avoid empty validValues).
    return values.size > 0 ? [...values] : undefined;
  }

  /** Maps a conventional (HEAT/AUTO/COOL) mode to its HomeKit TargetHeaterCoolerState value. */
  private targetModeCharValue(mode: string): number {
    const { Characteristic } = this.platform;
    switch (mode) {
      case AC_MODE.HEAT: return Characteristic.TargetHeaterCoolerState.HEAT;
      case AC_MODE.AUTO: return Characteristic.TargetHeaterCoolerState.AUTO;
      default:           return Characteristic.TargetHeaterCoolerState.COOL;
    }
  }

  private currentHcState(): number {
    const { Characteristic } = this.platform;
    if (!this.state.isOn) return Characteristic.CurrentHeaterCoolerState.INACTIVE;
    if (this.state.mode === AC_MODE.HEAT) return Characteristic.CurrentHeaterCoolerState.HEATING;
    if (this.state.mode === AC_MODE.COOL) return Characteristic.CurrentHeaterCoolerState.COOLING;
    return Characteristic.CurrentHeaterCoolerState.IDLE;
  }

  /** The device's writable temperature bounds for the given mode, falling back
   * to the generic constants when profile data for that mode is unavailable. */
  private tempRangeForMode(mode: string): { minValue: number; maxValue: number; minStep: number } {
    const range = mode === AC_MODE.HEAT ? this.caps.heatTempRange
      : mode === AC_MODE.AUTO ? this.caps.autoTempRange
        : this.caps.coolTempRange;
    return range
      ? { minValue: range.min, maxValue: range.max, minStep: range.step }
      : { minValue: TEMPERATURE_MIN_C, maxValue: TEMPERATURE_MAX_C, minStep: 1 };
  }

  private applyTempRangeProps(mode: string) {
    const { Characteristic } = this.platform;
    const props = this.tempRangeForMode(mode);
    // Seed a value that's valid before narrowing minValue/maxValue, so hap-nodejs's
    // own value/props reconciliation inside setProps() never has to correct a stale
    // default value (harmless — it self-heals — but avoidable entirely this way).
    this.service.updateCharacteristic(Characteristic.CoolingThresholdTemperature, this.state.targetTempC);
    this.service.updateCharacteristic(Characteristic.HeatingThresholdTemperature, this.state.targetTempC);
    this.service.getCharacteristic(Characteristic.CoolingThresholdTemperature).setProps(props);
    this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature).setProps(props);
  }

  private async refreshState() {
    try {
      const state = await this.platform.thinqApi.getDeviceStatus(this.device.deviceId);
      this.updateState(state);
    } catch (err) {
      this.platform.log.error(
        `[${this.device.deviceId}] Initial state fetch failed:`, (err as Error).message,
      );
    }
  }

  updateState(data: Record<string, unknown>) {
    const { Characteristic } = this.platform;

    const jobMode      = nested(data, 'airConJobMode', 'currentJobMode') as string | undefined;
    const operation    = nested(data, 'operation', 'airConOperationMode') as string | undefined;
    const currentTemp  = nested(data, 'temperature', 'currentTemperature') as number | undefined;
    const targetTemp   = nested(data, 'temperature', 'targetTemperature') as number | undefined;
    const windStrength = nested(data, 'airFlow', 'windStrength') as string | undefined;
    const swingUpDown  = (nested(data, 'windDirection', 'rotateUpDown')
      ?? nested(data, 'windDirection', 'rotateLeftRight')) as boolean | undefined;
    const runState     = nested(data, 'runState', 'currentState') as string | undefined;

    if (operation !== undefined) {
      this.state.isOn = operation === AC_OPERATION.ON;
      this.service.updateCharacteristic(
        Characteristic.Active,
        this.state.isOn ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE,
      );
    }
    if (jobMode !== undefined) {
      this.state.mode = jobMode;
      if (jobMode === AC_MODE.HEAT || jobMode === AC_MODE.COOL || jobMode === AC_MODE.AUTO) {
        if (this.state.lastConventionalMode !== jobMode) {
          this.state.lastConventionalMode = jobMode;
          this.service.updateCharacteristic(
            Characteristic.TargetHeaterCoolerState, this.targetModeCharValue(jobMode),
          );
        }
        this.applyTempRangeProps(jobMode);
      }
      this.service.updateCharacteristic(
        Characteristic.CurrentHeaterCoolerState, this.currentHcState(),
      );
    }
    if (currentTemp !== undefined) {
      this.state.currentTempC = currentTemp;
      this.service.updateCharacteristic(Characteristic.CurrentTemperature, currentTemp);
    }
    if (targetTemp !== undefined) {
      this.state.targetTempC = targetTemp;
      this.service.updateCharacteristic(Characteristic.CoolingThresholdTemperature, targetTemp);
      this.service.updateCharacteristic(Characteristic.HeatingThresholdTemperature, targetTemp);
    }
    if (windStrength !== undefined && this.service.testCharacteristic(Characteristic.RotationSpeed)) {
      this.state.windStrength = windStrength;
      this.service.updateCharacteristic(
        Characteristic.RotationSpeed, this.windStrengthPct[windStrength] ?? 100,
      );
    }
    if (swingUpDown !== undefined && this.service.testCharacteristic(Characteristic.SwingMode)) {
      this.state.swingUpDown = swingUpDown === true;
      this.service.updateCharacteristic(
        Characteristic.SwingMode,
        this.state.swingUpDown
          ? Characteristic.SwingMode.SWING_ENABLED
          : Characteristic.SwingMode.SWING_DISABLED,
      );
    }
    if (runState !== undefined) {
      this.state.hasFault = runState === 'ERROR';
      this.service.updateCharacteristic(
        Characteristic.StatusFault,
        this.state.hasFault ? Characteristic.StatusFault.GENERAL_FAULT : Characteristic.StatusFault.NO_FAULT,
      );
    }
  }
}

function nested(obj: Record<string, unknown>, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** Flattens a device profile's `property` (object, or array for multi-unit devices). */
function properties(profile?: Record<string, unknown>): Record<string, unknown> {
  const p = profile?.['property'];
  if (Array.isArray(p)) {
    return Object.assign({}, ...p.filter(x => x && typeof x === 'object'));
  }
  if (p && typeof p === 'object') {
    return p as Record<string, unknown>;
  }
  return {};
}

/** Returns whether `property.<resource>.<field>` is writable, plus its writable enum values. */
function writable(
  props: Record<string, unknown>, resource: string, field: string,
): { isWritable: boolean; wValues?: string[] } {
  const res = props[resource];
  const f = res && typeof res === 'object'
    ? (res as Record<string, unknown>)[field]
    : undefined;
  if (!f || typeof f !== 'object') return { isWritable: false };
  const mode = (f as Record<string, unknown>)['mode'];
  const isWritable = Array.isArray(mode) && mode.includes('w');
  const wValuesRaw = ((f as Record<string, unknown>)['value'] as Record<string, unknown> | undefined)?.['w'];
  const wValues = Array.isArray(wValuesRaw) ? wValuesRaw.map(String) : undefined;
  return { isWritable, wValues };
}

/** Returns the writable {min,max,step} bounds of a `type: "range"` profile field, if any. */
function writableRange(
  props: Record<string, unknown>, resource: string, field: string,
): TempRange | undefined {
  const res = props[resource];
  const f = res && typeof res === 'object'
    ? (res as Record<string, unknown>)[field]
    : undefined;
  if (!f || typeof f !== 'object') return undefined;
  const w = ((f as Record<string, unknown>)['value'] as Record<string, unknown> | undefined)?.['w'];
  if (!w || typeof w !== 'object' || typeof (w as Record<string, unknown>)['min'] !== 'number') {
    return undefined;
  }
  const { min, max, step } = w as { min: number; max: number; step?: number };
  return { min, max, step: step ?? 0.5 };
}

function parseCapabilities(profile?: Record<string, unknown>): Capabilities {
  const props = properties(profile);
  // No usable profile → expose everything, preserving the previous behaviour.
  if (Object.keys(props).length === 0) {
    return {
      hasProfile: false, swingUpDown: true, swingLeftRight: true, windStrength: true,
    };
  }
  const swingUpDown = writable(props, 'windDirection', 'rotateUpDown').isWritable;
  const swingLeftRight = writable(props, 'windDirection', 'rotateLeftRight').isWritable;
  const windStrengthW = writable(props, 'airFlow', 'windStrength');
  const jobModes = writable(props, 'airConJobMode', 'currentJobMode').wValues;
  return {
    hasProfile: true,
    swingUpDown,
    swingLeftRight,
    windStrength: windStrengthW.isWritable,
    windStrengthValues: windStrengthW.wValues,
    modes: jobModes ? new Set(jobModes) : undefined,
    heatTempRange: writableRange(props, 'temperature', 'heatTargetTemperature'),
    coolTempRange: writableRange(props, 'temperature', 'coolTargetTemperature'),
    autoTempRange: writableRange(props, 'temperature', 'autoTargetTemperature'),
  };
}
