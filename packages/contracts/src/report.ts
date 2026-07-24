import { z } from "zod";
import {
  MetricOutcomeV1Schema,
  SourceAttributionV1Schema
} from "./observation-v3.js";
import {
  ProtocolRefSchema,
  ReportSectionIdSchema
} from "./protocol.js";

export const REPORT_BOUNDARY_STATEMENT =
  "Engineering measurements from this local session only. Results are not identity-verified and are not intended for medical decisions or longitudinal comparison.";

export const REPORT_SOURCE_DISCLOSURE =
  "Audio reflects unverified local microphone input; facial measurements require exactly one visible face.";

const CaptureQualityFactV1Schema = z
  .object({
    code: z.enum([
      "session-duration",
      "voice-lane",
      "face-lane",
      "eligible-windows",
      "withheld-windows"
    ]),
    label: z.string().min(1),
    value: z.union([z.string().min(1), z.number().finite()]),
    unit: z.string().min(1).nullable()
  })
  .strict();
export type CaptureQualityFactV1 = z.infer<
  typeof CaptureQualityFactV1Schema
>;

export const ReportSectionV1Schema = z
  .object({
    sectionId: ReportSectionIdSchema,
    label: z.string().min(1),
    qualityFacts: z.array(CaptureQualityFactV1Schema),
    outcomes: z.array(MetricOutcomeV1Schema)
  })
  .strict()
  .superRefine((section, context) => {
    if (
      section.sectionId === "capture-quality" &&
      (section.qualityFacts.length === 0 || section.outcomes.length !== 0)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "The capture-quality section requires facts and cannot contain metric outcomes."
      });
    }
    if (
      section.sectionId !== "capture-quality" &&
      section.qualityFacts.length !== 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Only the capture-quality section may contain quality facts."
      });
    }
    if (
      section.outcomes.some(
        (outcome) => outcome.reportSection !== section.sectionId
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcomes"],
        message: "Metric outcome is assigned to the wrong report section."
      });
    }
  });
export type ReportSectionV1 = z.infer<typeof ReportSectionV1Schema>;

export const PostEncounterReportV1Schema = z
  .object({
    schemaVersion: z.literal("phenometric.post-encounter-report.v1"),
    reportId: z.string().min(1),
    observationId: z.string().min(1),
    sessionId: z.string().min(1),
    subjectRef: z.string().min(1),
    protocolRef: ProtocolRefSchema,
    generatedAt: z.string().datetime({ offset: true }),
    source: SourceAttributionV1Schema,
    sections: z.array(ReportSectionV1Schema).length(10),
    boundaryStatement: z.literal(REPORT_BOUNDARY_STATEMENT),
    sourceDisclosure: z.literal(REPORT_SOURCE_DISCLOSURE),
    persistence: z.literal("session-memory-only"),
    exportAvailable: z.literal(false)
  })
  .strict()
  .superRefine((report, context) => {
    if (report.source.sourceSessionRef !== report.sessionId) {
      context.addIssue({
        code: "custom",
        path: ["source", "sourceSessionRef"],
        message: "Report source attribution must belong to the report session."
      });
    }
    const sections = report.sections.map((section) => section.sectionId);
    if (new Set(sections).size !== sections.length) {
      context.addIssue({
        code: "custom",
        path: ["sections"],
        message: "Report sections must be unique."
      });
    }
    const codes = report.sections.flatMap((section) =>
      section.outcomes.map((outcome) => outcome.metricCode)
    );
    if (new Set(codes).size !== codes.length) {
      context.addIssue({
        code: "custom",
        path: ["sections"],
        message: "Each metric may appear only once in the report."
      });
    }
  });
export type PostEncounterReportV1 = z.infer<
  typeof PostEncounterReportV1Schema
>;
