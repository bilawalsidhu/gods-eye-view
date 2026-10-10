/**
 * WebUSB receiver selection for the local RTL-SDR.
 *
 * Dual-channel boards such as the Nooelec FlyCatcher enumerate as two USB
 * devices (an ADS-B 1090 MHz channel and a UAT 978 MHz channel) that can share
 * a serial number. Selection therefore remembers the full identity
 * (vendorId, productId, productName, serialNumber) per receiver mode and, for
 * ADS-B, prefers a channel whose product name names ADS-B or 1090 MHz.
 */

export const SDR_DEVICE_STORAGE_KEY = 'gev:sdr:device:v1';
/** RTL2832U vendor/product pairs requested by the WebUSB RTL-SDR provider. */
export const RTL_SDR_USB_FILTERS = Object.freeze([
  Object.freeze({ vendorId: 0x0bda, productId: 0x2832 }),
  Object.freeze({ vendorId: 0x0bda, productId: 0x2838 }),
]);
const ADSB_PRODUCT_PATTERN = /ads.?b|1090/i;
const NON_FM_PRODUCT_PATTERN = /ads.?b|1090|uat|978/i;

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Plain identity of a WebUSB device (or a stored identity).
 * @param {object|null} device USBDevice-like object.
 * @returns {{vendorId:number|null, productId:number|null, productName:string|null, serialNumber:string|null}|null}
 */
export function sdrDeviceIdentity(device) {
  if (!device || typeof device !== 'object') return null;
  return {
    vendorId: Number.isInteger(device.vendorId) ? device.vendorId : null,
    productId: Number.isInteger(device.productId) ? device.productId : null,
    productName: text(device.productName),
    serialNumber: text(device.serialNumber),
  };
}

/**
 * Whether two devices or identities name the same receiver channel.
 * @param {object|null} a Device or identity.
 * @param {object|null} b Device or identity.
 * @returns {boolean}
 */
export function sameSdrDevice(a, b) {
  const left = sdrDeviceIdentity(a);
  const right = sdrDeviceIdentity(b);
  return Boolean(
    left &&
    right &&
    left.vendorId === right.vendorId &&
    left.productId === right.productId &&
    left.productName === right.productName &&
    left.serialNumber === right.serialNumber,
  );
}

/**
 * Human-readable receiver label for status text.
 * @param {object|null} device Device or identity.
 * @returns {string}
 */
export function sdrDeviceLabel(device) {
  const identity = sdrDeviceIdentity(device);
  if (!identity) return 'RTL-SDR';
  return identity.productName || 'RTL-SDR';
}

function filterMatchesDevice(filter, device) {
  return (
    (filter.vendorId === undefined || filter.vendorId === device.vendorId) &&
    (filter.productId === undefined || filter.productId === device.productId) &&
    (filter.serialNumber === undefined ||
      filter.serialNumber === device.serialNumber)
  );
}

/**
 * Choose an already-authorized receiver without opening the WebUSB picker.
 * Order: the device remembered for this mode; then, for ADS-B, a channel
 * named for ADS-B/1090 MHz, or for FM a channel not named for ADS-B/UAT; then
 * the first matching device.
 * @param {object[]} devices Authorized devices from `navigator.usb.getDevices()`.
 * @param {object} [options]
 * @param {object[]} [options.filters] WebUSB request filters.
 * @param {'fm'|'adsb'} [options.mode] Receiver mode being connected.
 * @param {object|null} [options.remembered] Identity remembered for this mode.
 * @returns {object|null} Chosen device, or null when the picker is needed.
 */
export function selectAuthorizedSdrDevice(
  devices,
  { filters = [], mode = 'fm', remembered = null } = {},
) {
  const candidates = (Array.isArray(devices) ? devices : []).filter(
    (device) =>
      device &&
      (filters.length === 0 ||
        filters.some((filter) => filterMatchesDevice(filter, device))),
  );
  if (!candidates.length) return null;
  if (remembered) {
    const match = candidates.find((device) =>
      sameSdrDevice(device, remembered),
    );
    if (match) return match;
  }
  const preferred =
    mode === 'adsb'
      ? candidates.find((device) =>
          ADSB_PRODUCT_PATTERN.test(device.productName || ''),
        )
      : candidates.find(
          (device) => !NON_FM_PRODUCT_PATTERN.test(device.productName || ''),
        );
  return preferred || candidates[0];
}

/**
 * Per-mode remembered receiver identities in browser storage.
 * @param {Storage|null} storage Browser storage or a test double.
 * @returns {{get(mode:string):object|null, set(mode:string, device:object):void}}
 */
export function createSdrDeviceMemory(storage) {
  const read = () => {
    try {
      const value = JSON.parse(
        storage?.getItem?.(SDR_DEVICE_STORAGE_KEY) || 'null',
      );
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  };
  return {
    get(mode) {
      return sdrDeviceIdentity(read()[mode]);
    },
    set(mode, device) {
      const identity = sdrDeviceIdentity(device);
      if (!identity) return;
      try {
        storage?.setItem?.(
          SDR_DEVICE_STORAGE_KEY,
          JSON.stringify({ ...read(), [mode]: identity }),
        );
      } catch {
        /* storage can be unavailable or quota-limited */
      }
    },
  };
}

/**
 * Wrap `navigator.usb` so the RTL-SDR provider reuses an authorized receiver
 * for the current mode before asking WebUSB to show its picker.
 * @param {USB} webUsb Browser WebUSB object.
 * @param {object} [options]
 * @param {() => 'fm'|'adsb'} [options.getMode] Mode being connected.
 * @param {{get:Function,set:Function}} [options.memory] Remembered identities.
 * @param {() => boolean} [options.consumeForcePicker] Returns true once when
 *   the user asked to choose a different device.
 * @param {(device:object) => void} [options.onSelected] Selected device hook.
 * @returns {USB} Proxy exposing the same WebUSB surface.
 */
export function createRememberingWebUsb(
  webUsb,
  {
    getMode = () => 'fm',
    memory = null,
    consumeForcePicker = () => false,
    onSelected = () => {},
  } = {},
) {
  if (!webUsb?.getDevices || !webUsb?.requestDevice) return webUsb;
  return new Proxy(webUsb, {
    get(target, property) {
      if (property === 'requestDevice') {
        return async (options = {}) => {
          const mode = getMode();
          const filters = Array.isArray(options.filters) ? options.filters : [];
          let device = null;
          if (!consumeForcePicker()) {
            device = selectAuthorizedSdrDevice(await target.getDevices(), {
              filters,
              mode,
              remembered: memory?.get(mode) || null,
            });
          }
          if (!device) {
            // Only an explicit picker choice is remembered; automatic
            // selection is re-derived from the preference on every connect.
            device = await target.requestDevice(options);
            if (device) memory?.set(mode, device);
          }
          if (device) onSelected(device);
          return device;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
