import { z } from "zod";

const SemanticVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const NonNegativeFiniteSchema = z.number().finite().nonnegative();
const PositiveFiniteSchema = z.number().finite().positive();

export const AmbientModalitySchema = z.enum(["voice", "face"]);
export type AmbientModality = z.infer<typeof AmbientModalitySchema>;

export const AmbientMeasurementContextSchema = z.enum([
  "ambient-speech-turn",
  "ambient-frontal"
]);
export type AmbientMeasurementContext = z.infer<
  typeof AmbientMeasurementContextSchema
>;

export const ReportSectionIdSchema = z.enum([
  "capture-quality",
  "pitch",
  "speech-timing",
  "eye-geometry",
  "mouth-geometry",
  "symmetry",
  "expression-dynamics",
  "movement",
  "blink-behavior"
]);
export type ReportSectionId = z.infer<typeof ReportSectionIdSchema>;

export const MetricCodeSchema = z.enum([
  "ambient.voice.f0.median",
  "ambient.voice.f0.variability",
  "ambient.voice.speech_activity_fraction",
  "ambient.voice.pause_rate",
  "ambient.voice.pause_duration.median",
  "ambient.voice.speech_run_duration.median",
  "ambient.voice.acoustic_nucleus_rate",
  "ambient.face.eye_aperture.left",
  "ambient.face.eye_aperture.right",
  "ambient.face.eye_aperture.asymmetry",
  "ambient.face.mouth_width",
  "ambient.face.mouth_aperture.median",
  "ambient.face.mouth_aperture.p90",
  "ambient.face.mouth_corner_position.asymmetry",
  "ambient.face.landmark_speed.p90",
  "ambient.face.blink_rate.bilateral",
  "ambient.face.rest_mouth_corner_asymmetry.signed",
  "ambient.face.rest_eye_aperture_asymmetry.signed",
  "ambient.face.spontaneous_event_rate",
  "ambient.face.spontaneous_excursion.p90",
  "ambient.face.spontaneous_excursion_asymmetry.median",
  "ambient.face.oculo_oral_synkinesis_index"
]);
export type MetricCode = z.infer<typeof MetricCodeSchema>;

export const ProtocolRefSchema = z
  .object({
    packId: z.literal("ambient-local-observation"),
    version: SemanticVersionSchema,
    contentSha256: Sha256Schema
  })
  .strict();
export type ProtocolRef = z.infer<typeof ProtocolRefSchema>;

export const MetricDefinitionSchema = z
  .object({
    code: MetricCodeSchema,
    label: z.string().min(1),
    modality: AmbientModalitySchema,
    context: AmbientMeasurementContextSchema,
    unit: z.string().min(1),
    reportSection: ReportSectionIdSchema.exclude(["capture-quality"]),
    reportOrder: z.number().int().nonnegative(),
    algorithmId: z.string().min(1),
    algorithmVersion: SemanticVersionSchema,
    evidenceRequirements: z
      .record(z.string().min(1), NonNegativeFiniteSchema)
      .refine((requirements) => Object.keys(requirements).length > 0, {
        message: "Every metric must declare evidence requirements."
      }),
    qualityInputs: z.array(z.string().min(1)).min(1),
    withheldReasonCodes: z.array(z.string().min(1)).min(1),
    technicalVerification: z.literal("automated-test"),
    clinicalValidation: z.literal("none")
  })
  .strict();
export type MetricDefinition = z.infer<typeof MetricDefinitionSchema>;

export const CaptureQualityPolicyV1Schema = z
  .object({
    id: z.literal("ambient-local-quality.v1"),
    maximumSessionDurationMs: z.literal(300_000),
    setupTimeoutMs: PositiveFiniteSchema,
    audio: z
      .object({
        quietCalibrationMs: z.literal(2_000),
        minimumSampleRateHz: z.literal(44_100),
        maximumFrameGapMs: z.literal(40),
        maximumLostBlockFraction: z.literal(0.05),
        maximumClippingFraction: z.literal(0.01),
        maximumAbsoluteDcOffset: z.literal(0.02),
        minimumSpeechSnrDb: z.literal(15),
        maximumRawAudioBufferMs: z.literal(2_000)
      })
      .strict(),
    face: z
      .object({
        minimumCalibrationDurationMs: z.literal(1_500),
        minimumCalibrationUsableFraction: z.literal(0.8),
        binDurationMs: z.literal(5_000),
        minimumDataPerBinMs: z.literal(4_000),
        minimumSamplesPerBin: z.literal(80),
        minimumBinSpanMs: z.literal(4_800),
        maximumFrameGapMs: z.literal(200),
        maximumAbsoluteYawDegrees: z.literal(7),
        maximumAbsolutePitchDegrees: z.literal(10),
        maximumAbsoluteRollDegrees: z.literal(5),
        maximumCalibrationScaleDeviation: z.literal(0.2),
        maximumWithinBinScaleRatio: z.literal(1.15),
        minimumBins: z.literal(3),
        minimumObservationSpanMs: z.literal(30_000),
        maximumDetectedFaces: z.literal(2),
        requiredFaceCount: z.literal(1)
      })
      .strict(),
    blink: z
      .object({
        minimumExposureMs: z.literal(60_000),
        minimumCadenceHz: z.literal(24),
        maximumP95FrameGapMs: z.literal(75),
        closureFractionOfOpenReference: z.literal(0.6),
        minimumClosureMs: z.literal(50),
        recoveryFractionOfOpenReference: z.literal(0.8),
        maximumRecoveryMs: z.literal(800),
        refractoryMs: z.literal(150)
      })
      .strict()
  })
  .strict();
export type CaptureQualityPolicyV1 = z.infer<
  typeof CaptureQualityPolicyV1Schema
>;

export const ProtocolPackV1Schema = z
  .object({
    schemaVersion: z.literal("phenometric.protocol-pack.v1"),
    packId: z.literal("ambient-local-observation"),
    version: SemanticVersionSchema,
    contentSha256: Sha256Schema,
    status: z.literal("nonclinical-prototype"),
    maximumSessionDurationMs: z.literal(300_000),
    supportedTarget: z
      .object({
        browser: z.literal("chrome"),
        versions: z.literal("current-and-previous-stable"),
        operatingSystem: z.literal("macos"),
        requiresHttps: z.literal(true)
      })
      .strict(),
    modalities: z.tuple([
      z.literal("voice"),
      z.literal("face")
    ]),
    sourcePolicy: z
      .object({
        role: z.literal("local-participant"),
        audioAttribution: z.literal("user-asserted-local-participant"),
        speakerAttribution: z.literal("unverified-local-input"),
        faceAttribution: z.literal("single-visible-face"),
        performsIdentityVerification: z.literal(false)
      })
      .strict(),
    consentDocument: z
      .object({
        version: z.literal("ambient-local-consent.v1"),
        contentSha256: Sha256Schema
      })
      .strict(),
    qualityPolicy: CaptureQualityPolicyV1Schema,
    reportSections: z.tuple([
      z.literal("capture-quality"),
      z.literal("pitch"),
      z.literal("speech-timing"),
      z.literal("eye-geometry"),
      z.literal("mouth-geometry"),
      z.literal("symmetry"),
      z.literal("expression-dynamics"),
      z.literal("movement"),
      z.literal("blink-behavior")
    ]),
    metrics: z.array(MetricDefinitionSchema).length(22)
  })
  .strict()
  .superRefine((pack, context) => {
    const codes = pack.metrics.map((metric) => metric.code);
    if (new Set(codes).size !== codes.length) {
      context.addIssue({
        code: "custom",
        path: ["metrics"],
        message: "Metric codes must be unique."
      });
    }
    const orders = pack.metrics.map(
      (metric) => `${metric.reportSection}:${metric.reportOrder}`
    );
    if (new Set(orders).size !== orders.length) {
      context.addIssue({
        code: "custom",
        path: ["metrics"],
        message: "Report order must be unique within each section."
      });
    }
  });
export type ProtocolPackV1 = z.infer<typeof ProtocolPackV1Schema>;

export function protocolRefFor(pack: ProtocolPackV1): ProtocolRef {
  return ProtocolRefSchema.parse({
    packId: pack.packId,
    version: pack.version,
    contentSha256: pack.contentSha256
  });
}
