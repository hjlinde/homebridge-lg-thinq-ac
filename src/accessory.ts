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
} from './settings';

interface AcState {
  isOn: boolean;
  mode: string;
  currentTempC: number;
  targetTempC: number;
  windStrength: string;
  swingUpDown: boolean;
  hasFault: boolean;
  naturalWind: boolean;
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
  naturalWind: boolean;
  modes?: Set<string>;
}

export class AirConditionerAccessory {
  private readonly service: Service;
  private naturalWindService?: Service;
  private windStrengthPct: Record<string, number> = WIND_STRENGTH_TO_PCT;
  private state: AcState = {
    isOn: false,
    mode: AC_MODE.COOL,
    currentTempC: 22,
    targetTempC: 22,
    windStrength: 'AUTO',
    swingUpDown: false,
    hasFault: false,
    naturalWind: false,
  };

  constructor(
    private readonly platform: LgThinQAcPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly device: DeviceInfo,
    profile?: Record<string, unknown>,
  ) {
    const { Service, Characteristic } = platform;
    const caps = parseCapabilities(profile);
    const swing = caps.swingUpDown || caps.swingLeftRight;
    const windStrengthPct = caps.windStrengthValues
      ? buildWindStrengthPctTable(caps.windStrengthValues)
      : WIND_STRENGTH_TO_PCT;
    this.windStrengthPct = windStrengthPct;

    this.platform.log.info(
      `[${device.alias}] Capabilities: swing=${swing} (upDown=${caps.swingUpDown}, `
      + `leftRight=${caps.swingLeftRight}), windStrength=${caps.windStrength}, `
      + `modes=${caps.modes ? [...caps.modes].join('/') : 'unknown'}`
      + (caps.hasProfile ? '' : ' (no profile — exposing all features)'),
    );

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'LG')
      .setCharacteristic(Characteristic.Model, device.modelName || 'AC')
      .setCharacteristic(Characteristic.SerialNumber, device.deviceId);

    this.service = this.accessory.getService(Service.HeaterCooler)
      ?? this.accessory.addService(Service.HeaterCooler);

    this.service.setCharacteristic(Characteristic.Name, device.alias);

    this.service.getCharacteristic(Characteristic.Active)
      .onGet(() =>
        this.state.isOn ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE,
      )
      .onSet(async (value: CharacteristicValue) => {
        this.state.isOn = value === Characteristic.Active.ACTIVE;
        await this.sendControl('Power', {
          operation: { airConOperationMode: this.state.isOn ? AC_OPERATION.ON : AC_OPERATION.OFF },
        });
      });

    this.service.getCharacteristic(Characteristic.CurrentHeaterCoolerState)
      .onGet(() => this.currentHcState());

    const targetModeChar = this.service.getCharacteristic(Characteristic.TargetHeaterCoolerState);
    const validModes = this.homekitTargetModes(caps.modes);
    if (validModes && validModes.length > 0) {
      targetModeChar.setProps({ validValues: validModes });
    }
    targetModeChar
      .onGet(() => {
        switch (this.state.mode) {
          case AC_MODE.HEAT: return Characteristic.TargetHeaterCoolerState.HEAT;
          case AC_MODE.AUTO: return Characteristic.TargetHeaterCoolerState.AUTO;
          default:           return Characteristic.TargetHeaterCoolerState.COOL;
        }
      })
      .onSet(async (value: CharacteristicValue) => {
        switch (value) {
          case Characteristic.TargetHeaterCoolerState.HEAT: this.state.mode = AC_MODE.HEAT; break;
          case Characteristic.TargetHeaterCoolerState.AUTO: this.state.mode = AC_MODE.AUTO; break;
          default: this.state.mode = AC_MODE.COOL;
        }
        await this.sendControl('Mode', {
          airConJobMode: { currentJobMode: this.state.mode },
        });
        this.service.updateCharacteristic(
          Characteristic.CurrentHeaterCoolerState, this.currentHcState(),
        );
      });

    this.service.getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => this.state.currentTempC);

    this.service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .setProps({ minValue: TEMPERATURE_MIN_C, maxValue: TEMPERATURE_MAX_C, minStep: 1 })
      .onGet(() => this.state.targetTempC)
      .onSet(async (value: CharacteristicValue) => {
        this.state.targetTempC = value as number;
        await this.sendControl('Temperature', {
          temperature: { targetTemperature: value },
        });
      });

    this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .setProps({ minValue: TEMPERATURE_MIN_C, maxValue: TEMPERATURE_MAX_C, minStep: 1 })
      .onGet(() => this.state.targetTempC)
      .onSet(async (value: CharacteristicValue) => {
        this.state.targetTempC = value as number;
        await this.sendControl('Temperature', {
          temperature: { targetTemperature: value },
        });
      });

    this.service.getCharacteristic(Characteristic.StatusFault)
      .onGet(() => this.state.hasFault
        ? Characteristic.StatusFault.GENERAL_FAULT
        : Characteristic.StatusFault.NO_FAULT,
      );

    // RotationSpeed and SwingMode are optional characteristics: only expose them
    // when the device supports them, and strip them from cached accessories that
    // no longer (or never did) support them so stale controls stop erroring.
    if (caps.windStrength) {
      this.service.getCharacteristic(Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
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

    // Natural Wind is a separate LG "wind style" setting, not reachable via the
    // RotationSpeed slider, so it gets its own Switch service.
    if (caps.naturalWind) {
      this.naturalWindService = this.accessory.getServiceById(Service.Switch, 'natural-wind')
        ?? this.accessory.addService(Service.Switch, `${device.alias} Natural Wind`, 'natural-wind');
      this.naturalWindService.setCharacteristic(Characteristic.Name, `${device.alias} Natural Wind`);
      this.naturalWindService.getCharacteristic(Characteristic.On)
        .onGet(() => this.state.naturalWind)
        .onSet(async (value: CharacteristicValue) => {
          this.state.naturalWind = value as boolean;
          if (this.state.naturalWind) {
            await this.sendControl('NaturalWind', {
              airFlow: { windStrengthDetail: 'NATURE' },
            });
          } else {
            // windStrengthDetail doesn't accept AUTO, so restore via windStrength
            // instead (the device syncs windStrengthDetail to match automatically —
            // confirmed against a live unit).
            await this.sendControl('NaturalWind', {
              airFlow: { windStrength: this.state.windStrength },
            });
          }
        });
    } else {
      const existing = this.accessory.getServiceById(Service.Switch, 'natural-wind');
      if (existing) {
        this.accessory.removeService(existing);
      }
    }

    this.refreshState();
  }

  /** Sends a control command and logs LG's actual error detail on failure. */
  private async sendControl(label: string, body: Record<string, unknown>) {
    try {
      await this.platform.thinqApi.controlDevice(this.device.deviceId, body);
    } catch (err) {
      this.platform.log.error(
        `[${this.device.alias}] ${label} control failed: ${controlErrorDetail(err)}`,
      );
      throw err; // let HomeKit surface "No Response" for this characteristic
    }
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

  private currentHcState(): number {
    const { Characteristic } = this.platform;
    if (!this.state.isOn) return Characteristic.CurrentHeaterCoolerState.INACTIVE;
    if (this.state.mode === AC_MODE.HEAT) return Characteristic.CurrentHeaterCoolerState.HEATING;
    if (this.state.mode === AC_MODE.COOL) return Characteristic.CurrentHeaterCoolerState.COOLING;
    return Characteristic.CurrentHeaterCoolerState.IDLE;
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
    const windDetail   = nested(data, 'airFlow', 'windStrengthDetail') as string | undefined;

    if (operation !== undefined) {
      this.state.isOn = operation === AC_OPERATION.ON;
      this.service.updateCharacteristic(
        Characteristic.Active,
        this.state.isOn ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE,
      );
    }
    if (jobMode !== undefined) {
      this.state.mode = jobMode;
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
    if (windDetail !== undefined && this.naturalWindService) {
      this.state.naturalWind = windDetail === 'NATURE';
      this.naturalWindService.updateCharacteristic(Characteristic.On, this.state.naturalWind);
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

function parseCapabilities(profile?: Record<string, unknown>): Capabilities {
  const props = properties(profile);
  // No usable profile → expose everything, preserving the previous behaviour.
  if (Object.keys(props).length === 0) {
    return {
      hasProfile: false, swingUpDown: true, swingLeftRight: true, windStrength: true, naturalWind: true,
    };
  }
  const swingUpDown = writable(props, 'windDirection', 'rotateUpDown').isWritable;
  const swingLeftRight = writable(props, 'windDirection', 'rotateLeftRight').isWritable;
  const windStrengthW = writable(props, 'airFlow', 'windStrength');
  const windStrengthDetailW = writable(props, 'airFlow', 'windStrengthDetail');
  const jobModes = writable(props, 'airConJobMode', 'currentJobMode').wValues;
  return {
    hasProfile: true,
    swingUpDown,
    swingLeftRight,
    windStrength: windStrengthW.isWritable,
    windStrengthValues: windStrengthW.wValues,
    naturalWind: windStrengthDetailW.isWritable && !!windStrengthDetailW.wValues?.includes('NATURE'),
    modes: jobModes ? new Set(jobModes) : undefined,
  };
}
