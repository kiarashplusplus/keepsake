import { z } from "zod";

export const REPORT_REASONS = [
  "illegal",
  "not_a_keepsake",
  "spam",
  "harassment",
  "personal_info",
  "other",
] as const;

export const ReportReasonSchema = z.enum(REPORT_REASONS);
export type ReportReason = z.infer<typeof ReportReasonSchema>;

export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  illegal: "Illegal item",
  not_a_keepsake: "Not a keepsake",
  spam: "Spam",
  harassment: "Harassment",
  personal_info: "Personal info exposed",
  other: "Other",
};

export const CreateReportInput = z.object({
  reason: ReportReasonSchema,
  details: z.string().trim().max(500).optional(),
});
export type CreateReportInput = z.infer<typeof CreateReportInput>;
