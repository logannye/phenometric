import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

interface WorkletMessagePort {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown, transfer?: unknown[]): void;
  start(): void;
  close(): void;
}

interface CapturedBlock {
  schemaVersion: string;
  type: string;
  captureEpoch: number;
  sequence: number;
  absoluteSampleIndex: number;
  buffer: ArrayBuffer;
}

function loadProcessor(): new () => {
  port: WorkletMessagePort;
  process(inputs: Float32Array[][]): boolean;
} {
  let registered:
    | (new () => {
        port: WorkletMessagePort;
        process(inputs: Float32Array[][]): boolean;
      })
    | null = null;
  class AudioWorkletProcessorFixture {
    port: WorkletMessagePort = {
      onmessage: null,
      postMessage() {},
      start() {},
      close() {}
    };
  }
  runInNewContext(
    readFileSync(
      new URL("../public/voice-capture-worklet.js", import.meta.url),
      "utf8"
    ),
    {
      AudioWorkletProcessor: AudioWorkletProcessorFixture,
      registerProcessor: (
        name: string,
        processor: typeof registered
      ) => {
        expect(name).toBe("phenometric-voice-capture");
        registered = processor;
      },
      sampleRate: 48_000,
      currentTime: 1,
      ArrayBuffer,
      Float32Array,
      Math
    }
  );
  if (!registered) throw new Error("Worklet processor was not registered.");
  return registered;
}

function renderBlock(
  processor: { process(inputs: Float32Array[][]): boolean },
  value: number
): void {
  for (let offset = 0; offset < 960; offset += 128) {
    const length = Math.min(128, 960 - offset);
    processor.process([
      [Float32Array.from({ length }, () => value)]
    ]);
  }
}

describe("voice capture AudioWorklet", () => {
  it("emits continuous 20 ms blocks and reuses returned buffers", () => {
    const Processor = loadProcessor();
    const processor = new Processor();
    const blocks: CapturedBlock[] = [];
    const dataPort: WorkletMessagePort = {
      onmessage: null,
      postMessage(message) {
        blocks.push(message as CapturedBlock);
      },
      start() {},
      close() {}
    };
    processor.port.onmessage?.({
      data: { type: "attach-port", port: dataPort }
    });
    processor.port.onmessage?.({
      data: { type: "capture-epoch", captureEpoch: 7 }
    });

    renderBlock(processor, 0.25);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      schemaVersion: "phenometric.voice-worklet-message.v1",
      type: "pcm-block",
      captureEpoch: 7,
      sequence: 1,
      absoluteSampleIndex: 0
    });
    expect(new Float32Array(blocks[0].buffer)).toHaveLength(960);

    const recycled = blocks[0].buffer;
    dataPort.onmessage?.({
      data: { type: "recycle", buffer: recycled }
    });
    renderBlock(processor, -0.25);
    expect(blocks[1].buffer).toBe(recycled);
    expect(blocks[1]).toMatchObject({
      captureEpoch: 7,
      sequence: 2,
      absoluteSampleIndex: 960
    });
  });

  it("resets epoch, sequence, and absolute sample time atomically", () => {
    const Processor = loadProcessor();
    const processor = new Processor();
    const blocks: CapturedBlock[] = [];
    const dataPort: WorkletMessagePort = {
      onmessage: null,
      postMessage(message) {
        blocks.push(message as CapturedBlock);
      },
      start() {},
      close() {}
    };
    processor.port.onmessage?.({
      data: { type: "attach-port", port: dataPort }
    });
    renderBlock(processor, 0.1);
    processor.port.onmessage?.({
      data: { type: "capture-epoch", captureEpoch: 11 }
    });
    renderBlock(processor, 0.2);
    expect(blocks.at(-1)).toMatchObject({
      captureEpoch: 11,
      sequence: 1,
      absoluteSampleIndex: 0
    });
  });

  it("bounds recycled-buffer memory and rejects wrong-sized buffers", () => {
    const Processor = loadProcessor();
    const processor = new Processor();
    const dataPort: WorkletMessagePort = {
      onmessage: null,
      postMessage() {},
      start() {},
      close() {}
    };
    processor.port.onmessage?.({
      data: { type: "attach-port", port: dataPort }
    });
    for (let index = 0; index < 20; index += 1) {
      dataPort.onmessage?.({
        data: {
          type: "recycle",
          buffer: new ArrayBuffer(960 * Float32Array.BYTES_PER_ELEMENT)
        }
      });
    }
    dataPort.onmessage?.({
      data: { type: "recycle", buffer: new ArrayBuffer(4) }
    });
    expect(
      (
        processor as unknown as {
          pool: ArrayBuffer[];
          maximumPoolSize: number;
        }
      ).pool
    ).toHaveLength(8);
  });
});
