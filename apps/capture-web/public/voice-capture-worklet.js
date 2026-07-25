class PhenoMetrixVoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.dataPort = null;
    this.captureEpoch = 0;
    this.sequence = 0;
    this.absoluteSampleIndex = 0;
    this.blockSamples = Math.max(1, Math.round(sampleRate * 0.02));
    this.pending = new Float32Array(this.blockSamples);
    this.pendingLength = 0;
    this.pool = [];
    this.maximumPoolSize = 8;
    this.port.onmessage = (event) => {
      const message = event.data;
      if (message?.type === "attach-port" && message.port) {
        this.dataPort = message.port;
        this.dataPort.onmessage = (portEvent) => {
          if (
            portEvent.data?.type === "recycle" &&
            portEvent.data.buffer instanceof ArrayBuffer &&
            portEvent.data.buffer.byteLength ===
              this.blockSamples * Float32Array.BYTES_PER_ELEMENT &&
            this.pool.length < this.maximumPoolSize
          ) {
            this.pool.push(portEvent.data.buffer);
          }
        };
        this.dataPort.start();
      } else if (message?.type === "capture-epoch") {
        this.pending.fill(0);
        this.captureEpoch = message.captureEpoch;
        this.sequence = 0;
        this.absoluteSampleIndex = 0;
        this.pendingLength = 0;
      } else if (message?.type === "dispose") {
        this.dataPort?.close();
        this.dataPort = null;
        this.pending.fill(0);
        for (const buffer of this.pool) {
          new Float32Array(buffer).fill(0);
        }
        this.pool.length = 0;
        this.pendingLength = 0;
      }
    };
  }

  emitBlock() {
    if (!this.dataPort) {
      this.pendingLength = 0;
      return;
    }
    const buffer =
      this.pool.pop() ??
      new ArrayBuffer(this.blockSamples * Float32Array.BYTES_PER_ELEMENT);
    const samples = new Float32Array(buffer);
    samples.set(this.pending);
    this.sequence += 1;
    const firstSampleIndex = this.absoluteSampleIndex;
    this.absoluteSampleIndex += this.blockSamples;
    this.dataPort.postMessage(
      {
        schemaVersion: "phenometrix.voice-worklet-message.v1",
        type: "pcm-block",
        captureEpoch: this.captureEpoch,
        sequence: this.sequence,
        absoluteSampleIndex: firstSampleIndex,
        acquisitionAudioTimeSeconds: currentTime,
        sampleRateHz: sampleRate,
        channelCount: 1,
        buffer
      },
      [buffer]
    );
    this.pendingLength = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let sourceIndex = 0;
    while (sourceIndex < channel.length) {
      const count = Math.min(
        channel.length - sourceIndex,
        this.blockSamples - this.pendingLength
      );
      this.pending.set(
        channel.subarray(sourceIndex, sourceIndex + count),
        this.pendingLength
      );
      this.pendingLength += count;
      sourceIndex += count;
      if (this.pendingLength === this.blockSamples) this.emitBlock();
    }
    return true;
  }
}

registerProcessor(
  "phenometrix-voice-capture",
  PhenoMetrixVoiceCaptureProcessor
);
