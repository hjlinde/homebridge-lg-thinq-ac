import {
  API,
  Categories,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';
import { v4 as uuidv4 } from 'uuid';
import { PLUGIN_NAME, PLATFORM_NAME } from './settings';
import { AirConditionerAccessory } from './accessory';
import { ThinQApi, DeviceInfo, httpStatus, isTransient } from './api';

const AC_DEVICE_TYPE = 'DEVICE_AIR_CONDITIONER';
const POLL_INTERVAL_MS = 60_000;
// Upper bound for exponential backoff after repeated transient poll failures.
const MAX_BACKOFF_MS = 15 * 60_000;

// Subtypes used by an earlier version of this plugin for Fan Only/Dehumidify/
// Horizontal Swing/Natural Wind, each published as its own accessory. That
// approach didn't render well in Home and isn't scalable across multiple AC
// units, so it's been dropped in favor of Apple's native HeaterCooler model
// only — this list is used once to clean up any such accessories still
// registered from that experiment.
const RETIRED_AUX_KINDS = ['fan-only', 'dehumidify', 'horizontal-swing', 'natural-wind'];

interface BackoffState {
  failures: number;
  nextPollAt: number;
}

export class LgThinQAcPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly thinqApi: ThinQApi;

  private readonly cachedAccessories = new Map<string, PlatformAccessory>();
  private readonly deviceAccessories = new Map<string, AirConditionerAccessory>();
  private readonly backoff = new Map<string, BackoffState>();
  private pollTimer?: ReturnType<typeof setInterval>;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.thinqApi = new ThinQApi(
      config['accessToken'] as string,
      (config['countryCode'] as string | undefined) ?? 'DE',
      uuidv4(),
    );

    this.api.on('didFinishLaunching', () => this.initialize());
    this.api.on('shutdown', () => {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
      }
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  /** Removes any Fan Only/Dehumidify/Horizontal Swing/Natural Wind accessory
   * left over from the earlier separate-accessories experiment. */
  private cleanupRetiredAuxAccessories(device: DeviceInfo) {
    for (const kind of RETIRED_AUX_KINDS) {
      const uuid = this.api.hap.uuid.generate(`${device.deviceId}:${kind}`);
      const existing = this.cachedAccessories.get(uuid);
      if (existing) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existing]);
        this.cachedAccessories.delete(uuid);
      }
    }
  }

  private async initialize() {
    await this.discoverDevices();
    if (this.deviceAccessories.size > 0) {
      this.pollTimer = setInterval(() => this.pollAllDevices(), POLL_INTERVAL_MS);
    }
  }

  private async discoverDevices() {
    let devices: DeviceInfo[];
    try {
      const all = await this.thinqApi.getDevices();
      devices = all.filter(d => d.deviceType === AC_DEVICE_TYPE);
    } catch (err) {
      this.log.error('Failed to fetch device list:', (err as Error).message);
      return;
    }

    this.log.info(`Found ${devices.length} LG AC device(s)`);

    for (const device of devices) {
      const uuid = this.api.hap.uuid.generate(device.deviceId);
      const existingAccessory = this.cachedAccessories.get(uuid);
      const accessory = existingAccessory
        ?? new this.api.platformAccessory(device.alias || device.deviceId, uuid, Categories.AIR_CONDITIONER);

      accessory.category = Categories.AIR_CONDITIONER;
      accessory.context['device'] = device;

      this.cleanupRetiredAuxAccessories(device);

      // Fetch the profile so the accessory only exposes supported features.
      // On failure we pass no profile and the accessory exposes everything.
      let profile: Record<string, unknown> | undefined;
      try {
        profile = await this.thinqApi.getDeviceProfile(device.deviceId);
      } catch (err) {
        this.log.warn(
          `[${device.alias}] Profile fetch failed, exposing all features:`, (err as Error).message,
        );
      }

      const acAccessory = new AirConditionerAccessory(this, accessory, device, profile);
      this.deviceAccessories.set(device.deviceId, acAccessory);

      if (existingAccessory) {
        this.api.updatePlatformAccessories([existingAccessory]);
      } else {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cachedAccessories.set(uuid, accessory);
      }

      this.log.info(`[${device.alias}] Registered`);
    }
  }

  private async pollAllDevices() {
    const now = Date.now();
    for (const [deviceId, accessory] of this.deviceAccessories) {
      const state = this.backoff.get(deviceId);
      if (state && now < state.nextPollAt) {
        continue; // still backing off after earlier transient failures
      }
      try {
        const status = await this.thinqApi.getDeviceStatus(deviceId);
        accessory.updateState(status);
        if (state) {
          this.backoff.delete(deviceId);
          this.log.info(`[${deviceId}] Recovered, resuming normal polling`);
        }
      } catch (err) {
        this.handlePollError(deviceId, err);
      }
    }
  }

  private handlePollError(deviceId: string, err: unknown) {
    const status = httpStatus(err);
    const message = (err as Error).message;

    // Transient failures (rate limiting, 5xx, network errors) back off instead of
    // hammering the API; anything else is a hard error we surface immediately.
    if (!isTransient(err)) {
      this.backoff.delete(deviceId);
      this.log.error(`[${deviceId}] Poll failed:`, message);
      return;
    }

    const failures = (this.backoff.get(deviceId)?.failures ?? 0) + 1;
    const delay = Math.min(POLL_INTERVAL_MS * 2 ** failures, MAX_BACKOFF_MS);
    const jittered = delay + Math.floor(Math.random() * 1_000);
    this.backoff.set(deviceId, { failures, nextPollAt: Date.now() + jittered });

    this.log.warn(
      `[${deviceId}] Poll failed (${status ?? 'network error'}), backing off ~${Math.round(jittered / 1_000)}s `
      + `(attempt ${failures}):`,
      message,
    );
  }
}
