/**
 * The browser's own position, and the five ways asking for it can turn out.
 *
 * **This is the one position on the globe that is about the person looking at it, so it is
 * handled differently from every other position in the app.** Everything else here arrives
 * from a feed, is stored on the server, travels over our socket and can be put in a shared
 * link. This never leaves the tab. It is not fetched, not posted, not logged, not written
 * into the URL hash that `state/url.ts` builds, and it is not in the store. The only things
 * that ever see it are the mark on the globe and the accuracy figure on the rail row.
 *
 * Nothing in this module imports `net/`, and a test asserts it, because a single well-meaning
 * `fetch` or `console.log` here would send a real person's home to a server or to a log file
 * that outlives the tab. Under ADR 008 a home address joined to a named profile is the
 * highest-harm thing this project can hold; the viewer's own is the same fact about a
 * different person.
 *
 * **The permission is a real state machine, not an optional extra.** `getCurrentPosition`
 * can be refused outright, can fail to fix a position, can time out, and on a browser with
 * geolocation disabled or on an insecure origin it is not there at all. Each of those is a
 * different sentence to put on screen, and drawing nothing while saying nothing is what the
 * product must never do: an empty layer reads as a broken renderer.
 *
 * No Cesium and no DOM in here, so all of it runs in the node test runner. The drawing lives
 * in `globe/layers/user-location.ts`.
 */

import type { LayerCapability } from '../types/entities';

/**
 * The layer key: the rail row, the URL's `off=` list and the capability all use it.
 *
 * Short because it is user-visible in a shared link. `LAYER_LABELS` in the rail turns it into
 * a heading.
 */
export const LOCATION_LAYER = 'me';

/** One position the browser reported, in this project's own units and order. */
export interface LocationFix {
  lon: number;
  lat: number;
  /**
   * The browser's own accuracy radius in metres.
   *
   * The Geolocation specification defines it as a 95% confidence radius and makes it the one
   * field other than the coordinates that is never null, which is why the circle drawn from it
   * is honest rather than decorative. It ranges from a few metres on GPS to tens of kilometres
   * when the answer came from an IP address, and the difference is the whole point of drawing it.
   */
  accuracyM: number;
  /** Metres above the WGS84 ellipsoid, or null. Most devices without GPS report none. */
  altitudeM: number | null;
  /** When the browser fixed it, Unix milliseconds. Its clock, not ours. */
  atMs: number;
}

/** Why the browser gave no position. The three `GeolocationPositionError` codes, named. */
export type LocationRefusal = 'denied' | 'unavailable' | 'timeout';

export type LocationState =
  | { kind: 'unsupported' }
  | { kind: 'off' }
  | { kind: 'asking' }
  | { kind: 'fixed'; fix: LocationFix }
  | { kind: 'refused'; reason: LocationRefusal };

/**
 * `GeolocationPositionError` codes. Named here so no branch below reads as a bare number.
 *
 * The specification's third code, `POSITION_UNAVAILABLE` (2), is deliberately not named: it falls
 * into the same branch as an unrecognised code, so a constant for it would be unused and the
 * linter would refuse it. It is documented at that branch instead.
 */
const PERMISSION_DENIED = 1;
const TIMEOUT = 3;

export function refusalFromCode(code: number): LocationRefusal {
  switch (code) {
    case PERMISSION_DENIED: {
      return 'denied';
    }
    case TIMEOUT: {
      return 'timeout';
    }
    default: {
      // The specification's `POSITION_UNAVAILABLE` (2) lands here, and so does anything it has not
      // defined, because both mean the same thing to a reader: the browser did not fix a
      // position and did not usefully say why. Named in the comment rather than as its own
      // case, which the linter correctly calls useless when the body is identical.
      return 'unavailable';
    }
  }
}

/**
 * Turn a browser position into a domain fix, or null when it does not make sense.
 *
 * A trust boundary in the same way `parseViewHash` is one. The values come from a device
 * driver by way of a browser, and a NaN latitude reaching `Cartesian3.fromDegrees` draws
 * nothing and reports nothing, which is the failure mode this project keeps finding.
 *
 * A zero accuracy is refused as well as a negative one: the specification says the radius is
 * non-negative, but a circle of no radius drawn as a claim of perfect knowledge would be the
 * one number on this layer that is certainly false.
 */
export function fixFromPosition(position: GeolocationPosition): LocationFix | null {
  const { longitude, latitude, accuracy, altitude } = position.coords;
  const usable =
    Number.isFinite(longitude) &&
    Number.isFinite(latitude) &&
    Number.isFinite(accuracy) &&
    longitude >= -180 &&
    longitude <= 180 &&
    latitude >= -90 &&
    latitude <= 90 &&
    accuracy > 0;
  if (!usable) {
    return null;
  }
  return {
    lon: longitude,
    lat: latitude,
    accuracyM: accuracy,
    // Only a finite altitude is an altitude. Null is the normal answer on a laptop.
    altitudeM: altitude !== null && Number.isFinite(altitude) ? altitude : null,
    atMs: Number.isFinite(position.timestamp) ? position.timestamp : Date.now(),
  };
}

/** A distance a person reads. Metres up to a kilometre, then kilometres to one decimal. */
export function accuracyText(metres: number): string {
  if (metres < 1000) {
    return `${Math.round(metres)} m`;
  }
  return `${(metres / 1000).toFixed(1)} km`;
}

/**
 * The promise this layer makes, on the row, in every state.
 *
 * It is on screen rather than only in this comment because it is the one thing a viewer
 * cannot check for themselves, and because a globe that suddenly knows where you are and says
 * nothing about it is the reason people refuse the permission prompt.
 */
export const LOCATION_PRIVACY_NOTICE =
  'Your position stays in this tab: never sent to our server, never in the shared link.';

/**
 * What the rail should say about this layer, one array element per notice.
 *
 * Never empty. Every other layer's notice list is empty when it is working, because a healthy
 * feed has nothing to explain; this one always carries the privacy line, because "it is
 * working" is exactly the state a viewer wants that sentence in.
 */
export function locationNotices(state: LocationState): readonly string[] {
  switch (state.kind) {
    case 'unsupported': {
      return ['This browser offers no location, so nothing is drawn.'];
    }
    case 'off': {
      return ['Switch on to put your own position on the globe.', LOCATION_PRIVACY_NOTICE];
    }
    case 'asking': {
      return [
        'Waiting for the browser, which may be asking your permission.',
        LOCATION_PRIVACY_NOTICE,
      ];
    }
    case 'refused': {
      return [refusalNotice(state.reason)];
    }
    case 'fixed': {
      return [
        `Accurate to about ${accuracyText(state.fix.accuracyM)}, as the browser reports it.`,
        LOCATION_PRIVACY_NOTICE,
      ];
    }
  }
}

function refusalNotice(reason: LocationRefusal): string {
  switch (reason) {
    case 'denied': {
      // No retry offered, because there is nothing this page can do: the permission is held by
      // the browser against the origin and only its own controls can change it.
      return 'Location permission was refused in this browser, so nothing is drawn.';
    }
    case 'unavailable': {
      return 'The browser could not fix a position, so nothing is drawn. Switch off and on to retry.';
    }
    case 'timeout': {
      return 'The browser did not answer in time, so nothing is drawn. Switch off and on to retry.';
    }
  }
}

/**
 * What the rail should know about whether this layer can work at all.
 *
 * The shape `/api/capabilities` uses, and the browser is the only thing that can fill it in:
 * the server has no idea whether this machine has a location or whether its owner granted it.
 * Same reasoning as `CloudLayer.capability`.
 *
 * **Only the two states nobody can act on report unavailable**, and that is a rail rule
 * rather than a preference: a row whose capability is unavailable loses its switch, so
 * marking a not-yet-asked layer unavailable would take away the only control that could ask.
 * A refused fix and a timeout keep the switch, because switching off and on is a real retry.
 */
export function locationCapability(state: LocationState): LayerCapability {
  if (state.kind === 'unsupported') {
    return { layer: LOCATION_LAYER, available: false, reason: 'this browser offers no location' };
  }
  if (state.kind === 'refused' && state.reason === 'denied') {
    return {
      layer: LOCATION_LAYER,
      available: false,
      reason: 'location permission refused in this browser',
    };
  }
  return { layer: LOCATION_LAYER, available: true, reason: null };
}

/**
 * Just enough of `navigator.geolocation` to drive it, so a test can supply a fake.
 *
 * The real `Geolocation` satisfies this as it stands, with no adapter, the same way
 * `EnginePort` in `globe/satellites/feed.ts` is satisfied by a real `Worker`.
 */
export interface GeolocationPort {
  watchPosition(
    onFix: (position: GeolocationPosition) => void,
    onError: (error: GeolocationPositionError) => void,
    options?: PositionOptions,
  ): number;
  clearWatch(id: number): void;
}

/**
 * How the browser is asked.
 *
 * High accuracy is off: this is a mark on a globe rather than a navigation aid, and turning it
 * on wakes the GPS and drains a battery for a precision no zoom level here can show. A cached
 * fix up to a minute old is accepted for the same reason. The timeout is what turns a browser
 * that never answers into a sentence on the rail rather than a layer that stays empty for ever.
 */
export const LOCATION_OPTIONS: PositionOptions = {
  enableHighAccuracy: false,
  maximumAge: 60_000,
  timeout: 20_000,
};

export interface UserLocationOptions {
  /** Null when the browser has no geolocation at all, which is a state and not a failure. */
  port: GeolocationPort | null;
  onChange: (state: LocationState) => void;
}

/**
 * Watch the browser's position while the layer is switched on.
 *
 * `watchPosition` rather than `getCurrentPosition`, because a mark that was right when the
 * page loaded and is wrong now is the same lie this project refuses everywhere else. The watch
 * is cleared the moment the layer is switched off, so nothing is being asked of the device
 * while the layer is not on screen.
 */
export class UserLocation {
  private readonly options: UserLocationOptions;
  private watch: number | null = null;
  private current: LocationState;

  constructor(options: UserLocationOptions) {
    this.options = options;
    this.current = options.port === null ? { kind: 'unsupported' } : { kind: 'off' };
  }

  get state(): LocationState {
    return this.current;
  }

  /** Whether anything is being asked of the device right now. */
  get watching(): boolean {
    return this.watch !== null;
  }

  /** Start watching. A no-op when there is no geolocation, or when already watching. */
  start(): void {
    const port = this.options.port;
    if (port === null || this.watch !== null) {
      return;
    }
    this.publish({ kind: 'asking' });
    this.watch = port.watchPosition(
      (position) => {
        const fix = fixFromPosition(position);
        // A position that will not map is dropped and counted as a failure to fix one, which
        // is what it is. Never partially accepted, and never logged: the whole record is the
        // thing that must not leave the tab.
        this.publish(
          fix === null ? { kind: 'refused', reason: 'unavailable' } : { kind: 'fixed', fix },
        );
      },
      (error) => {
        this.publish({ kind: 'refused', reason: refusalFromCode(error.code) });
      },
      LOCATION_OPTIONS,
    );
  }

  /** Stop watching and forget the fix. Switching off must leave nothing behind. */
  stop(): void {
    if (this.watch !== null) {
      this.options.port?.clearWatch(this.watch);
      this.watch = null;
    }
    if (this.current.kind !== 'unsupported') {
      this.publish({ kind: 'off' });
    }
  }

  private publish(state: LocationState): void {
    this.current = state;
    this.options.onChange(state);
  }
}
