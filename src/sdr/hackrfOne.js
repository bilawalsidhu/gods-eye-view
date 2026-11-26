// USB requests and payloads follow Great Scott Gadgets' libhackrf.
const REQUEST = {
  SET_MODE: 1,
  SET_SAMPLE_RATE: 6,
  SET_FILTER: 7,
  SET_FREQUENCY: 16,
  SET_AMP: 17,
  SET_LNA_GAIN: 19,
  SET_VGA_GAIN: 20,
};
const RX_ENDPOINT = 1;
const MODE_OFF = 0;
const MODE_RX = 1;
// The narrowest analog baseband filter on HackRF One.
const RX_BANDWIDTH_HZ = 1_750_000;
// The HackRF One firmware can buffer 64 KiB across its two RX buffers.
// Discard twice that to also cover samples captured while the tuner settles.
const RETUNE_DISCARD_BYTES = 128 * 1024;

function vendorRequest(request, value = 0, index = 0) {
  return { requestType: 'vendor', recipient: 'device', request, value, index };
}

async function claim(device) {
  if (device.opened) throw new Error('HackRF One is already open');
  await device.open();
  try {
    if (device.configuration?.configurationValue !== 1)
      await device.selectConfiguration(1);
    await device.claimInterface(0);
  } catch (error) {
    await device.close().catch(() => {});
    throw error;
  }
}

function pairOfUint32(first, second) {
  const data = new DataView(new ArrayBuffer(8));
  data.setUint32(0, first, true);
  data.setUint32(4, second, true);
  return data;
}

/** Open a selected WebUSB device for reception. Drain reads before reconfiguring. */
export async function openHackrfOne(device) {
  await claim(device);
  let receiving = false;
  let closing = null;

  async function write(request, { value = 0, index = 0, data } = {}) {
    const result = await device.controlTransferOut(
      vendorRequest(request, value, index),
      data,
    );
    if (
      result.status !== 'ok' ||
      result.bytesWritten !== (data?.byteLength ?? 0)
    )
      throw new Error(`HackRF One USB request ${request} failed`);
  }

  async function setGain(request, gain) {
    const result = await device.controlTransferIn(
      vendorRequest(request, 0, gain),
      1,
    );
    if (
      result.status !== 'ok' ||
      result.data?.byteLength !== 1 ||
      !result.data.getUint8(0)
    )
      throw new Error(`HackRF One gain request ${request} failed`);
  }

  function setCenterFrequency(frequencyHz) {
    if (closing) throw new Error('HackRF One is closed');
    return write(REQUEST.SET_FREQUENCY, {
      data: pairOfUint32(
        Math.floor(frequencyHz / 1_000_000),
        frequencyHz % 1_000_000,
      ),
    });
  }

  async function setRxGain(stage, gain) {
    if (closing) throw new Error('HackRF One is closed');
    if (stage === 'amp') {
      await write(REQUEST.SET_AMP, { value: Number(gain) });
    } else {
      await setGain(
        stage === 'lna' ? REQUEST.SET_LNA_GAIN : REQUEST.SET_VGA_GAIN,
        gain,
      );
    }
  }

  async function stopRx() {
    if (!receiving) return;
    await write(REQUEST.SET_MODE, { value: MODE_OFF });
    receiving = false;
  }

  async function readIq(byteLength) {
    if (closing || !receiving) throw new Error('HackRF One is not receiving');
    const result = await device.transferIn(RX_ENDPOINT, byteLength);
    if (result.status !== 'ok' || result.data?.byteLength !== byteLength)
      throw new Error('HackRF One IQ transfer failed');
    return result.data;
  }

  return {
    async configure({ sampleRate, frequencyHz, gain }) {
      if (closing) throw new Error('HackRF One is closed');
      await stopRx();
      await write(REQUEST.SET_SAMPLE_RATE, {
        data: pairOfUint32(sampleRate, 1),
      });
      await write(REQUEST.SET_FILTER, {
        value: RX_BANDWIDTH_HZ & 0xffff,
        index: RX_BANDWIDTH_HZ >>> 16,
      });
      await setCenterFrequency(frequencyHz);
      await setRxGain('amp', gain.amp);
      await setRxGain('lna', gain.lna);
      await setRxGain('vga', gain.vga);
      // If the USB response fails after the command took effect, close still
      // attempts to stop reception.
      receiving = true;
      try {
        await write(REQUEST.SET_MODE, { value: MODE_RX });
      } catch (error) {
        await stopRx().catch(() => {});
        throw error;
      }
    },

    setCenterFrequency,
    setRxGain,

    async resetBuffer() {
      await readIq(RETUNE_DISCARD_BYTES);
    },

    async readSamples(sampleCount) {
      const byteLength = sampleCount * 2;
      const { buffer, byteOffset } = await readIq(byteLength);
      const view = new Uint8Array(buffer, byteOffset, byteLength);
      const samples =
        byteOffset === 0 && buffer.byteLength === byteLength
          ? view
          : view.slice();
      // HackRF uses signed 8-bit I/Q. The worker expects offset binary.
      for (let index = 0; index < samples.length; index++)
        samples[index] ^= 0x80;
      return { data: samples.buffer };
    },

    // The controller has a bounded close deadline and keeps the raw USB handle
    // for recovery. A late adapter close must not reach a newly opened session.
    fenceUsb() {
      device = null;
    },

    close() {
      closing ??= stopRx().finally(() => device?.close());
      return closing;
    },
  };
}
