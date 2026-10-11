// Web Serial link to the Ruida controller's USB port (an FTDI FT245R FIFO).
// Per MeerK40t's usb_transport: no ACKs, no checksum over USB, hardware flow control, and the
// baud rate is effectively ignored by the FIFO chip. Confirm in docs/HARDWARE.md (Phase 0).

import { STOP_PROCESS, swizzle, unswizzle } from '../ruida/swizzle';
import {
  MAX_FILES, MEM_FILE_COUNT, deleteOneFile, namePacket, parseReplies, readFileName, readMemory, type Reply,
} from '../ruida/panel';

// Vendor only: the product ID (6001 expected) is unverified, and other FTDI chips use other IDs.
export const FTDI_FILTER: SerialPortFilter = { usbVendorId: 0x0403 };
const CHUNK = 512;
const REPLY_MS = 1500;
const NO_REPLY = 'The laser did not answer when asked for its file list. Check the cable, press Choose USB port… in case it is the wrong port, or ask your teacher to turn off "Send to panel".';

/** A USB port by its vendor and product id. */
export interface PortId { vid: number; pid: number | null }

/**
 * The remembered port to open without asking, or null to show the picker: the one that worked last
 * time, else the only FTDI port. Never just "the first port Chrome remembers": that was how a wrong
 * port picked once got reused forever. Exported for tests.
 */
export function choosePort<P extends { getInfo(): SerialPortInfo }>(granted: P[], remembered: PortId | null): P | null {
  const id = (p: P) => p.getInfo();
  if (remembered) {
    const same = granted.filter((p) => id(p).usbVendorId === remembered.vid && (remembered.pid === null || id(p).usbProductId === remembered.pid));
    if (same.length === 1) return same[0];
  }
  const ftdi = granted.filter((p) => id(p).usbVendorId === FTDI_FILTER.usbVendorId);
  return ftdi.length === 1 ? ftdi[0] : null;
}

export interface LinkOptions {
  baud: number;
  magic: number;
  flowControl?: FlowControlType; // default 'hardware'
  onReceive?: (bytes: Uint8Array) => void; // raw bytes from the controller (for the log)
  onDisconnect?: () => void;
}

export class LaserLink {
  private port: SerialPort | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reading = false;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private readDone: (() => void) | null = null;
  private abort = false;
  sending = false;
  private rx = new Uint8Array(0);
  private onReply: ((r: Reply) => void) | null = null;

  private opts: LinkOptions;

  constructor(opts: LinkOptions) {
    this.opts = opts; // not a parameter property, so Node's type stripping can load this file in tests
  }

  static supported(): boolean {
    return 'serial' in navigator;
  }

  get connected(): boolean {
    return this.port !== null;
  }

  get info(): SerialPortInfo | null {
    return this.port?.getInfo() ?? null;
  }

  /** Chrome's picker with every USB port. Throws NotFoundError when cancelled. Opens nothing. */
  static pick(): Promise<SerialPort> {
    if (!LaserLink.supported()) return Promise.reject(new Error('This browser cannot talk to USB devices. Use Chrome on a Chromebook.'));
    return navigator.serial.requestPort({});
  }

  isPort(p: SerialPort): boolean {
    return this.port === p;
  }

  /** Which port is open, to remember for next time (null: none, or Chrome does not say). */
  get portId(): PortId | null {
    const i = this.port?.getInfo();
    return i?.usbVendorId !== undefined ? { vid: i.usbVendorId, pid: i.usbProductId ?? null } : null;
  }

  /**
   * Open the laser's port. `pick`: 'auto' reuses the port that worked last time (or the one FTDI port Chrome
   * remembers) and shows Chrome's picker otherwise; 'all' always shows the picker with every USB port.
   * Nothing is ever forgotten (Dalton 2026-10-05: a failed or wrong pick must not lose the right port);
   * the caller remembers a port only once it has opened.
   */
  async connect(pick: 'auto' | 'filtered' | 'all' = 'auto', remembered?: PortId | null, chosen?: SerialPort): Promise<void> {
    if (!LaserLink.supported()) throw new Error('This browser cannot talk to USB devices. Use Chrome on a Chromebook.');
    const granted = await navigator.serial.getPorts();
    // The picker lists every port: the laser's USB chip is not verified (docs/HARDWARE.md), and a vendor
    // filter that guessed wrong showed an empty list (Dalton 2026-10-06).
    const port = chosen ?? (pick === 'auto' ? choosePort(granted, remembered ?? null) : null)
      ?? (await navigator.serial.requestPort({}));
    try {
      await port.open({ baudRate: this.opts.baud, flowControl: this.opts.flowControl ?? 'hardware', bufferSize: 4096 });
    } catch (e) {
      throw new Error(`Couldn't open the laser's USB port. Close any other tab or laser app using it, then unplug and replug the cable. (${(e as Error).message})`);
    }
    this.port = port;
    this.writer = port.writable!.getWriter();
    navigator.serial.addEventListener('disconnect', this.onDisconnect);
    void this.readLoop();
  }

  private onDisconnect = (ev: Event) => {
    if ((ev as unknown as { target: SerialPort }).target === this.port) {
      this.cleanup();
      this.opts.onDisconnect?.();
    }
  };

  private async readLoop(): Promise<void> {
    const port = this.port;
    if (!port?.readable) return;
    this.reading = true;
    while (this.reading && port.readable) {
      const reader = port.readable.getReader();
      this.reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.length) {
            this.opts.onReceive?.(value);
            this.feed(value);
          }
        }
      } catch {
        // framing/buffer errors are recoverable. Loop and grab a new reader
      } finally {
        reader.releaseLock();
        this.reader = null;
      }
    }
    this.readDone?.();
  }

  /** Stream an already-swizzled .rd job. Resolves when the last byte has been handed to the OS. */
  async send(bytes: Uint8Array, onProgress?: (sent: number, total: number) => void): Promise<void> {
    await this.exclusive(() => this.stream(bytes, onProgress));
  }

  /** The file names stored on the controller, slot 1 first. Read only: the page asks the student before
   *  it replaces one, because a name that is already there may be another student's waiting job. */
  async listNames(): Promise<string[]> {
    return this.exclusive(() => this.fileNames());
  }

  /**
   * Send to panel: store the job in the controller's file list under `name`. If that name is already
   * stored, it is deleted first ONLY when `replace` is true (the student pressed Replace); otherwise
   * nothing is deleted and this throws. The delete is by slot number, so the slot is read again right
   * before it. STOP at any point before the delete means no delete. Returns whether an old file was replaced.
   */
  async sendToPanel(job: Uint8Array, name: string, opts: { replace?: boolean; onProgress?: (sent: number, total: number) => void } = {}): Promise<boolean> {
    const prefix = swizzle(namePacket(name), this.opts.magic); // throws on a bad name, before anything is sent
    const stopped = () => { if (this.abort) throw new Error('Stopped.'); };
    return this.exclusive(async () => {
      const slot = (await this.fileNames()).indexOf(name) + 1;
      stopped();
      if (slot > 0) {
        // the list changed since the student was asked: never delete without asking
        if (!opts.replace) throw new Error(`A file called ${name} is already on the laser. Press Send again to choose what to do.`);
        const again = await this.ask(readFileName(slot), (r) => (r.kind === 'name' && r.slot === slot ? r.name : undefined));
        stopped();
        if (again !== name) throw new Error('The list of files on the laser changed. Press Send again.');
        stopped();
        await this.writer!.write(swizzle(deleteOneFile(slot), this.opts.magic));
        await new Promise((r) => setTimeout(r, 500)); // give the controller a moment to finish the delete
      }
      const all = new Uint8Array(prefix.length + job.length);
      all.set(prefix);
      all.set(job, prefix.length);
      await this.stream(all, opts.onProgress);
      return slot > 0;
    });
  }

  /** Names stored on the controller, slot 1 first. Read only. */
  private async fileNames(): Promise<string[]> {
    const count = await this.ask(readMemory(MEM_FILE_COUNT), (r) => (r.kind === 'mem' && r.addr === MEM_FILE_COUNT ? r.value : undefined));
    if (count > MAX_FILES) throw new Error(NO_REPLY);
    const names: string[] = [];
    for (let i = 1; i <= count; i++) {
      if (this.abort) throw new Error('Stopped.');
      names.push(await this.ask(readFileName(i), (r) => (r.kind === 'name' && r.slot === i ? r.name : undefined)));
    }
    return names;
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.writer) throw new Error('Connect the laser first.');
    if (this.sending) throw new Error('A job is already being sent.');
    this.sending = true;
    this.abort = false;
    try {
      return await fn();
    } finally {
      this.sending = false;
    }
  }

  private async stream(bytes: Uint8Array, onProgress?: (sent: number, total: number) => void): Promise<void> {
    for (let i = 0; i < bytes.length; i += CHUNK) {
      if (this.abort || !this.writer) throw new Error('Stopped.');
      await this.writer.write(bytes.subarray(i, i + CHUNK));
      onProgress?.(Math.min(i + CHUNK, bytes.length), bytes.length);
    }
  }

  /** Write one command and wait for the reply `pick` accepts. */
  private ask<T>(cmd: Uint8Array, pick: (r: Reply) => T | undefined): Promise<T> {
    this.rx = new Uint8Array(0);
    return new Promise<T>((resolve, reject) => {
      const done = (err?: Error, v?: T) => {
        clearTimeout(timer);
        this.onReply = null;
        if (err) reject(err);
        else resolve(v as T);
      };
      const timer = setTimeout(() => done(new Error(this.abort ? 'Stopped.' : NO_REPLY)), REPLY_MS);
      this.onReply = (r) => {
        const v = pick(r);
        if (v !== undefined) done(undefined, v);
      };
      if (!this.writer) return done(new Error('Connect the laser first.'));
      this.writer.write(swizzle(cmd, this.opts.magic)).catch((e: Error) => done(e));
    });
  }

  private feed(value: Uint8Array): void {
    if (!this.onReply) return;
    const plain = unswizzle(value, this.opts.magic);
    const buf = new Uint8Array(this.rx.length + plain.length);
    buf.set(this.rx);
    buf.set(plain, this.rx.length);
    const { replies, used } = parseReplies(buf);
    this.rx = buf.slice(used);
    for (const r of replies) this.onReply?.(r);
  }

  /**
   * Stop streaming and tell the controller to abort the running job. True once STOP is handed to the OS;
   * false when it could not be (not connected, or still queued after `waitMs` behind a write that hardware
   * flow control is holding): then only the laser's own E-stop button is sure. Throws if the write failed.
   */
  async stop(waitMs = 1000): Promise<boolean> {
    this.abort = true;
    if (!this.writer) return false;
    const sent = this.writer.write(swizzle(STOP_PROCESS, this.opts.magic)).then(() => true);
    return Promise.race([sent, new Promise<boolean>((r) => setTimeout(() => r(false), waitMs))]);
  }

  async disconnect(): Promise<void> {
    const port = this.port;
    const done = new Promise<void>((r) => (this.readDone = r));
    const hadReader = !!this.reader;
    this.cleanup();
    if (hadReader) await Promise.race([done, new Promise((r) => setTimeout(r, 500))]);
    try {
      await port?.close();
    } catch {
      /* already gone */
    }
  }

  /**
   * For Reset USB: close even when a write is stuck (hardware flow control can hold one forever, and then
   * an ordinary close fails because the stream is still locked). Cancels the reader, aborts the writer,
   * then closes the port. Never forgets the port. Never throws, never hangs: a write the USB driver never
   * finishes cannot be ended from a web page (an abort waits for it), so each step has a time limit and the
   * answer says whether the port really closed. False: unplug the cable or reload the page.
   */
  async hardClose(): Promise<boolean> {
    const { port, writer, reader } = this;
    this.reading = false;
    this.abort = true;
    this.port = null;
    this.writer = null;
    navigator.serial?.removeEventListener('disconnect', this.onDisconnect);
    const within = <T>(p: Promise<T> | undefined, ms: number) =>
      Promise.race([Promise.resolve(p).then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
    await within(reader?.cancel(), 1000);
    await within(writer?.abort(), 1000);
    try {
      writer?.releaseLock();
    } catch {
      /* still busy with the stuck write */
    }
    await new Promise((r) => setTimeout(r, 200)); // let the read loop let go
    if (!port) return true;
    let closed = false;
    await within(port.close().then(() => { closed = true; }), 1500);
    return closed;
  }

  private cleanup(): void {
    this.reading = false;
    this.abort = true;
    void this.reader?.cancel().catch(() => {});
    try {
      this.writer?.releaseLock();
    } catch {
      /* pending writes */
    }
    this.writer = null;
    this.port = null;
    navigator.serial?.removeEventListener('disconnect', this.onDisconnect);
  }
}
