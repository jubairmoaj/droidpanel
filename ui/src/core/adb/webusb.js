// WebUSB transport for adb.js. Chrome, Edge, Brave, Opera (desktop and Android); needs HTTPS or localhost.

export const ADB_FILTER = { classCode: 0xff, subclassCode: 0x42, protocolCode: 1 };

/** Find the ADB interface of a USB device, or null if it has none (e.g. USB debugging is off). */
export function findAdbInterface(device) {
  for (const conf of device.configurations) {
    for (const iface of conf.interfaces) {
      for (const alt of iface.alternates) {
        if (alt.interfaceClass === ADB_FILTER.classCode && alt.interfaceSubclass === ADB_FILTER.subclassCode
          && alt.interfaceProtocol === ADB_FILTER.protocolCode) {
          return { conf, iface, alt };
        }
      }
    }
  }
  return null;
}

export class UsbTransport {
  constructor(device, ifaceNumber, inEp, outEp) {
    this.device = device;
    this.ifaceNumber = ifaceNumber;
    this.inEp = inEp;
    this.outEp = outEp;
  }

  static async open(device) {
    const found = findAdbInterface(device);
    if (!found) throw new Error('This device has no ADB interface — turn on USB debugging');
    const { conf, iface, alt } = found;
    if (!device.opened) await device.open();
    if (device.configuration?.configurationValue !== conf.configurationValue) {
      await device.selectConfiguration(conf.configurationValue);
    }
    try {
      await device.claimInterface(iface.interfaceNumber);
    } catch {
      await device.close().catch(() => {});
      throw new Error('The phone is busy: another program is using it over USB. '
        + 'Stop the adb server on this computer (run "adb kill-server"), close Android Studio / scrcpy, then try again.');
    }
    if (iface.alternate?.alternateSetting !== alt.alternateSetting) {
      await device.selectAlternateInterface(iface.interfaceNumber, alt.alternateSetting);
    }
    const ep = (dir) => alt.endpoints.find((e) => e.direction === dir && e.type === 'bulk');
    const inEp = ep('in'), outEp = ep('out');
    if (!inEp || !outEp) throw new Error('ADB interface has no bulk endpoints');
    return new UsbTransport(device, iface.interfaceNumber, inEp, outEp);
  }

  async write(header, data) {
    await this.out(header);
    if (data.length) {
      await this.out(data);
      // A transfer that is an exact multiple of the packet size needs a zero-length packet to end it.
      if (data.length % this.outEp.packetSize === 0) await this.out(new Uint8Array(0));
    }
  }

  async out(bytes) {
    const r = await this.device.transferOut(this.outEp.endpointNumber, bytes);
    if (r.status === 'stall') {
      await this.device.clearHalt('out', this.outEp.endpointNumber);
      throw new Error('USB write stalled');
    }
  }

  async in(length) {
    const r = await this.device.transferIn(this.inEp.endpointNumber, length);
    if (r.status === 'stall') {
      await this.device.clearHalt('in', this.inEp.endpointNumber);
      return new Uint8Array(0);
    }
    return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  }

  async read() {
    // Read a whole USB packet, not 24 bytes: after a page reload the phone may still be
    // sending data from the old session, and a short read buffer would overflow. Anything
    // that isn't a valid ADB header (cmd ^ magic) is leftover and skipped.
    let chunk, dv;
    for (;;) {
      chunk = await this.in(Math.max(24, this.inEp.packetSize));
      if (chunk.length < 24) continue;
      dv = new DataView(chunk.buffer, chunk.byteOffset, 24);
      if ((dv.getUint32(0, true) ^ dv.getUint32(20, true)) >>> 0 === 0xffffffff) break;
    }
    const header = chunk.subarray(0, 24);
    const length = dv.getUint32(12, true);
    if (!length) return { header, data: new Uint8Array(0) };
    const data = new Uint8Array(length);
    let off = Math.min(length, chunk.length - 24);
    data.set(chunk.subarray(24, 24 + off));
    while (off < length) {
      const chunk = await this.in(length - off);
      data.set(chunk, off);
      off += chunk.length;
    }
    return { header, data };
  }

  async close() {
    try { await this.device.releaseInterface(this.ifaceNumber); } catch { /* already gone */ }
    try { await this.device.close(); } catch { /* already closed */ }
  }
}
