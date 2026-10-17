import { z } from "zod";
import { cohortIdSchema } from "./hunter-cohort-schema";
import { cohortReportSchema } from "./hunter-cohort-report-schema";
export const notebookTheme=z.enum(["volume-reversal","rsi-recovery","downtrend-rebound","base-building","v-recovery","false-rebound","dejavu-similarity","high-score-failure"]);
export const notebookThemes:Record<z.infer<typeof notebookTheme>,string>={"volume-reversal":"出来高急増を伴う底打ち","rsi-recovery":"RSI回復後の反転","downtrend-rebound":"長期下降トレンド中の反発","base-building":"底固めからの上昇","v-recovery":"V字回復","false-rebound":"偽の反発・再下落","dejavu-similarity":"デジャヴ相場の類似度と実績","high-score-failure":"高スコアなのに失敗したケース"};
export const notebookInputSchema=z.object({theme:notebookTheme,cohortIds:z.array(cohortIdSchema).min(1).max(100),hypothesis:z.string().max(500).default("")}).strict();
export const notebookEvidenceSchema=z.object({evidenceId:cohortIdSchema,groupKey:z.string(),sampleCount:z.number(),reportId:cohortIdSchema,cohortIds:z.array(cohortIdSchema),evaluationIds:z.array(cohortIdSchema)});
export const notebookCaseSchema=z.object({code:z.string(),cohortId:cohortIdSchema,evaluationId:cohortIdSchema,horizon:z.number(),candidate:z.boolean(),score:z.number().nullable(),actualReturn:z.number(),conditions:z.array(z.string())});
export const notebookOriginalSchema=z.object({schemaVersion:z.literal(1),notebookId:cohortIdSchema,theme:notebookTheme,period:z.object({from:z.string().date(),to:z.string().date()}),hypothesis:z.string(),methodVersion:z.literal("kabumaru-notebook-v1"),
  createdAt:z.string().datetime(),mode:z.enum(["demo","research"]),cohortIds:z.array(cohortIdSchema),evaluationIds:z.array(cohortIdSchema),report:cohortReportSchema,evidence:z.array(notebookEvidenceSchema),successes:z.array(notebookCaseSchema).max(5),failures:z.array(notebookCaseSchema).max(5),limitations:z.array(z.string()),nextConditions:z.array(z.string())}).strict();
export const notebookSummarySchema=z.object({notebookId:cohortIdSchema,statements:z.array(z.object({text:z.string(),evidenceIds:z.array(cohortIdSchema),sampleCount:z.number()})),limitations:z.array(z.string())});
export type NotebookOriginal=z.infer<typeof notebookOriginalSchema>;
export const notebookViewSchema=notebookOriginalSchema.omit({evaluationIds:true,evidence:true,report:true}).extend({evaluationCount:z.number(),report:cohortReportSchema.omit({evaluationIds:true}).extend({evaluationCount:z.number()}),evidence:z.array(notebookEvidenceSchema.omit({evaluationIds:true}).extend({evaluationCount:z.number()}))});
