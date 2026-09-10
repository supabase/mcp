import { z } from 'zod/v4';
import type { SupabasePlatform } from './platform/types.js';
import {
  currentFeatureGroupSchema,
  featureGroupSchema,
  type FeatureGroup,
  PLATFORM_INDEPENDENT_FEATURES,
} from './types.js';

/**
 * Parses a key-value string into an object.
 *
 * @returns An object representing the key-value pairs
 *
 * @example
 * const result = parseKeyValueList("key1=value1\nkey2=value2");
 * console.log(result); // { key1: "value1", key2: "value2" }
 */
export function parseKeyValueList(data: string): { [key: string]: string } {
  return Object.fromEntries(
    data
      .split('\n')
      .map((item) => item.split(/=(.*)/)) // split only on the first '='
      .filter(([key]) => key) // filter out empty keys
      .map(([key, value]) => [key, value ?? '']) // ensure value is not undefined
  );
}

/**
 * Creates a unique hash from a JavaScript object.
 * @param obj - The object to hash
 * @param length - Optional length to truncate the hash (default: full length)
 */
export async function hashObject(
  obj: Record<string, any>,
  length?: number
): Promise<string> {
  // Sort object keys to ensure consistent output regardless of original key order
  const str = JSON.stringify(obj, (_, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value)
        .sort()
        .reduce<Record<string, any>>((result, key) => {
          result[key] = value[key];
          return result;
        }, {});
    }
    return value;
  });

  const buffer = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(str)
  );

  // Convert to base64
  const base64Hash = btoa(String.fromCharCode(...new Uint8Array(buffer)));
  return base64Hash.slice(0, length);
}

/**
 * Parses and validates feature groups based on the platform's available features.
 */
export function parseFeatureGroups(
  platform: SupabasePlatform,
  features: string[]
) {
  // First pass: validate that all features are valid
  const desiredFeatures = z.set(featureGroupSchema).parse(new Set(features));

  // The platform implementation can define a subset of features
  const availableFeatures: FeatureGroup[] = [
    ...PLATFORM_INDEPENDENT_FEATURES,
    ...currentFeatureGroupSchema.options.filter((key) =>
      Object.keys(platform).includes(key)
    ),
  ];

  const availableFeaturesSchema = z.enum(
    availableFeatures as [string, ...string[]],
    {
      error: (issue) => {
        if (issue.code === 'invalid_value') {
          return `This platform does not support the '${issue.input}' feature group. Supported groups are: ${availableFeatures.join(', ')}`;
        }
      },
    }
  );

  // Second pass: validate the desired features against this platform's available features
  return z.set(availableFeaturesSchema).parse(desiredFeatures);
}
