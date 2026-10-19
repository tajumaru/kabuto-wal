import { z } from "zod";
import { scoutId } from "./bottom-scout-schema";
export const scoutForecastSchema=z.object({
  schemaVersion:z.literal(1),forecastId:scoutId,reportId:scoutId,
  methodVersion:z.literal("scout-forecast-v1"),algorithmVersion:z.literal("bottom-scout-v1"),
  createdAt:z.string().datetime(),asOf:z.string().date(),cutoff:z.string().datetime(),
  mode:z.enum(["demo","research"]),recordingMode:z.enum(["live","research"]),inputHash:scoutId,
  calendar:z.array(z.object({date:z.string().date(),open:z.boolean()})),calendarHash:scoutId,
  targets:z.object({"5":z.string().date().nullable(),"10":z.string().date().nullable(),"20":z.string().date().nullable()}),
  benchmarkCode:z.string().regex(/^[0-9A-Z]{5}$/).nullable(),
  rows:z.array(z.object({code:z.string(),rank:z.number().int().positive(),referencePrice:z.number().positive().nullable(),evidenceHash:scoutId})).max(10),
}).strict();
export type ScoutForecast=z.infer<typeof scoutForecastSchema>;
