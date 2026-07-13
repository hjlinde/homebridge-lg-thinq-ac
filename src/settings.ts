export const PLUGIN_NAME = 'homebridge-lg-thinqconnect-ac';
export const PLATFORM_NAME = 'LgThinQAc';

// Verified against docs/aircon-profile-response.json's airConJobMode.currentJobMode enum.
export const AC_MODE = {
  COOL: 'COOL',
  HEAT: 'HEAT',
  FAN:  'FAN',
  DRY:  'AIR_DRY',
  AUTO: 'AUTO',
} as const;
export type AcMode = typeof AC_MODE[keyof typeof AC_MODE];

// Verified against docs/aircon-profile-response.json's operation.airConOperationMode enum.
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

// Canonical low→high ordering of the non-AUTO wind strength steps. AUTO is always
// treated as the last (highest) step on the scale.
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
 * value (e.g. MID_HIGH) the device doesn't support. Every step (AUTO included)
 * gets an even 1/N share of 0-100 — e.g. a standard LOW/MID/HIGH/AUTO device maps
 * cleanly to 25/50/75/100, matching the device's real, named speed steps rather
 * than an arbitrary continuous range.
 */
export function buildWindStrengthPctTable(writableValues: string[]): Record<string, number> {
  const steps = WIND_STRENGTH_ORDER.filter(v => writableValues.includes(v));
  const ordered = writableValues.includes(AC_WIND_STRENGTH.AUTO)
    ? [...steps, AC_WIND_STRENGTH.AUTO]
    : steps;
  const table: Record<string, number> = {};
  ordered.forEach((v, i) => {
    table[v] = Math.round(((i + 1) / ordered.length) * 100);
  });
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

/** The RotationSpeed minStep that makes HomeKit's slider snap exactly to each named
 * speed in `table` (e.g. 25 for a 4-step LOW/MID/HIGH/AUTO device), so users only
 * ever land on a real speed instead of an arbitrary in-between value. */
export function windStrengthMinStep(table: Record<string, number>): number {
  const count = Object.keys(table).length;
  return count > 0 ? Math.round(100 / count) : 1;
}
