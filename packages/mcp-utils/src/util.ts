import type { ExtractParams } from './types.js';

/**
 * Asserts that a URI is valid.
 */
export function assertValidUri(uri: string) {
  try {
    new URL(uri);
    return uri;
  } catch {
    throw new Error(`invalid uri: ${uri}`);
  }
}

/**
 * Compares two URIs.
 */
export function compareUris(uriA: string, uriB: string): boolean {
  const urlA = new URL(uriA);
  const urlB = new URL(uriB);

  return urlA.href === urlB.href;
}

/**
 * Matches a URI to a RFC 6570 URI Template (resourceUris) and extracts
 * the parameters.
 *
 * Currently only supports simple string parameters.
 */
export function matchUriTemplate<Templates extends string[]>(
  uri: string,
  uriTemplates: Templates
):
  | {
      uri: Templates[number];
      params: { [Param in ExtractParams<Templates[number]>]: string };
    }
  | undefined {
  const url = new URL(uri);
  const segments = url.pathname.split('/').slice(1);

  for (const resourceUri of uriTemplates) {
    const resourceUrl = new URL(resourceUri);
    const resourceSegments = decodeURIComponent(resourceUrl.pathname)
      .split('/')
      .slice(1);

    if (segments.length !== resourceSegments.length) {
      continue;
    }

    const params: Record<string, string> = {};
    let isMatch = true;

    for (let i = 0; i < segments.length; i++) {
      const resourceSegment = resourceSegments[i];
      const segment = segments[i];

      if (!resourceSegment || !segment) {
        isMatch = false;
        break;
      }

      if (resourceSegment.startsWith('{') && resourceSegment.endsWith('}')) {
        const paramKey = resourceSegment.slice(1, -1);

        if (!paramKey) {
          isMatch = false;
          break;
        }

        params[paramKey] = segment;
      } else if (segments[i] !== resourceSegments[i]) {
        isMatch = false;
        break;
      }
    }

    if (isMatch) {
      return {
        uri: resourceUri,
        params: params as {
          [Param in ExtractParams<Templates[number]>]: string;
        },
      };
    }
  }
}
