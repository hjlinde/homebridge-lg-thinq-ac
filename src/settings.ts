export const PLUGIN_NAME = 'homebridge-lg-thinqconnect-ac';
export const PLATFORM_NAME = 'LgThinQAc';

// TODO: verify these enum values against a live asyncGetDeviceStatus() response
export const AC_MODE = {
  COOL: 'COOL',
  HEAT: 'HEAT',
  FAN:  'FAN',
  DRY:  'DRY',
  AUTO: 'AUTO',
} as const;
export type AcMode = typeof AC_MODE[keyof typeof AC_MODE];

// TODO: verify operation enum values (might be 'POWER_ON'/'POWER_OFF' or 'ON'/'OFF')
export const AC_OPERATION = {
  ON:  'POWER_ON',
  OFF: 'POWER_OFF',
} as const;

// TODO: verify wind strength enum values
export const AC_WIND_STRENGTH = {
  AUTO:     'AUTO',
  LOW:      'LOW',
  LOW_MID:  'LOW_MID',
  MID:      'MID',
  MID_HIGH: 'MID_HIGH',
  HIGH:     'HIGH',
} as const;
export type AcWindStrength = typeof AC_WIND_STRENGTH[keyof typeof AC_WIND_STRENGTH];

export const TEMPERATURE_MIN_C = 18;
export const TEMPERATURE_MAX_C = 30;

// Canonical low→high ordering of the non-AUTO wind strength steps. AUTO is handled
// separately (always pinned to 100%) since it isn't a point on the low/high scale.
const WIND_STRENGTH_ORDER: AcWindStrength[] = [
  AC_WIND_STRENGTH.LOW,
  AC_WIND_STRENGTH.LOW_MID,
  AC_WIND_STRENGTH.MID,
  AC_WIND_STRENGTH.MID_HIGH,
  AC_WIND_STRENGTH.HIGH,
];

// Default table used when a device's profile is unavailable (previous behaviour:
// expose the full 6-step range).
export const WIND_STRENGTH_TO_PCT: Record<string, number> = buildWindStrengthPctTable(
  Object.values(AC_WIND_STRENGTH),
);

/**
 * Builds a wind-strength → HomeKit RotationSpeed percentage table from the set of
 * values a device's profile actually declares writable, so we never send an enum
 * value (e.g. MID_HIGH) the device doesn't support. Non-AUTO steps are spread
 * evenly low→high; AUTO (if present) is pinned to 100%.
 */
export function buildWindStrengthPctTable(writableValues: string[]): Record<string, number> {
  const steps = WIND_STRENGTH_ORDER.filter(v => writableValues.includes(v));
  const table: Record<string, number> = {};
  steps.forEach((v, i) => {
    table[v] = steps.length === 1 ? 50 : Math.round(((i + 1) / steps.length) * 90);
  });
  if (writableValues.includes(AC_WIND_STRENGTH.AUTO)) {
    table[AC_WIND_STRENGTH.AUTO] = 100;
  }
  return table;
}

/** Finds the wind-strength enum value in `table` whose percentage is closest to `pct`. */
export function pctToWindStrength(pct: number, table: Record<string, number>): AcWindStrength {
  const entries = Object.entries(table);
  let best = entries[0];
  for (const entry of entries) {
    if (Math.abs(entry[1] - pct) < Math.abs(best[1] - pct)) {
      best = entry;
    }
  }
  return best[0] as AcWindStrength;
}
