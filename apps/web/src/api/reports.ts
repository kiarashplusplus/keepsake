import { z } from "zod";
import { CreateReportInput as CreateReportInputSchema, type CreateReportInput } from "@keepsake/contracts/report";
import { UlidSchema } from "@keepsake/contracts/common";
import { apiFetch } from "@/api/client";

const CreateReportResultSchema = z.object({ id: UlidSchema });
export type CreateReportResult = z.infer<typeof CreateReportResultSchema>;

export type CreateReportOptions = {
  turnstileToken: string;
  signal?: AbortSignal;
};

/** `POST /api/listings/:id/reports` — anonymous, Turnstile-gated. 409s
 * (`conflict`) on a repeat report from the same address. */
export async function createReport(
  listingId: string,
  input: CreateReportInput,
  options: CreateReportOptions,
): Promise<CreateReportResult> {
  const body = CreateReportInputSchema.parse(input);
  const data = await apiFetch<unknown>(`/api/listings/${encodeURIComponent(listingId)}/reports`, {
    method: "POST",
    body,
    turnstileToken: options.turnstileToken,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  return CreateReportResultSchema.parse(data);
}
