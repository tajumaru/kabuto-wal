import { z } from "zod";
import { hunterCode } from "./hunter-schema";
export const COHORT_METHOD="hunter-cohort-v1";
export const cohortIdSchema=z.string().regex(/^[a-f0-9]{64}$/);
export const cohortMemberSchema=z.object({code:hunterCode,score:z.number().min(0).max(100).nullable(),candidate:z.boolean(),classification:z.string(),referencePrice:z.number().positive().nullable(),
  inputRevisionIds:z.array(z.string()),eligible:z.boolean(),exclusionReasons:z.array(z.string()),conditions:z.array(z.string()),risks:z.array(z.string()),indicators:z.record(z.string(),z.number().finite().nullable()),adjustmentVersion:z.string().nullable(),scoringMethodVersion:z.string().nullable().default(null),featureVersion:z.string().nullable().default(null),configHash:z.string().nullable().default(null)}).strict();
export const cohortManifestSchema=z.object({schemaVersion:z.literal(1),cohortId:cohortIdSchema,jobId:z.string().uuid(),datasetId:z.string(),analysisId:z.string(),asOf:z.string().date(),cutoff:z.string().datetime(),
  methodVersion:z.string(),scoringVersions:z.array(z.string()),cohortMethod:z.literal(COHORT_METHOD),universeId:z.string(),createdAt:z.string().datetime(),mode:z.enum(["demo","research"]),experiment:z.enum(["prospective","retrospective","walk-forward"]),plan:z.string(),delayDays:z.number(),
  targets:z.object({"1":z.string().date().nullable(),"5":z.string().date().nullable(),"20":z.string().date().nullable()}),memberCount:z.number().int().min(0).max(20000),shards:z.array(z.object({key:z.string().regex(/^members\/\d{5}\.json$/),hash:cohortIdSchema,count:z.number().int().max(200)}))}).strict();
export const cohortInputSchema=z.object({jobId:z.string().uuid(),experiment:z.enum(["prospective","retrospective","walk-forward"]).default("retrospective")}).strict();
export type CohortMember=z.infer<typeof cohortMemberSchema>;
export type CohortManifest=z.infer<typeof cohortManifestSchema>;
export const cohortEvaluationSchema=z.object({schemaVersion:z.literal(1),evaluationId:cohortIdSchema,cohortId:cohortIdSchema,code:hunterCode,horizon:z.union([z.literal(1),z.literal(5),z.literal(20)]),target:z.string().date().nullable(),
  status:z.enum(["evaluated","pending","missing","excluded"]),reasons:z.array(z.string()),actualReturn:z.number().finite().min(-1).nullable(),up:z.boolean().nullable(),maxDrawdown:z.number().finite().min(-1).max(0).nullable(),maxRise:z.number().finite().min(0).nullable(),relapse:z.boolean().nullable(),
  inputRevisionIds:z.array(z.string()),evaluatedAt:z.string().datetime(),dataAvailableAt:z.string().datetime().nullable(),evaluationCutoff:z.string().datetime(),adjustmentVersion:z.string().nullable(),basePrice:z.number().positive().nullable(),targetPrice:z.number().positive().nullable()}).strict().superRefine((r,ctx)=>{
    if(r.status!=="evaluated")return;
    if(r.actualReturn===null||r.up===null||r.maxDrawdown===null||r.maxRise===null||r.relapse===null||r.basePrice===null||r.targetPrice===null||!r.target||!r.dataAvailableAt||!r.inputRevisionIds.length||r.dataAvailableAt>r.evaluationCutoff||r.dataAvailableAt>r.evaluatedAt||Math.abs(r.actualReturn-(r.targetPrice/r.basePrice-1))>1e-10||r.up!==(r.actualReturn>0))ctx.addIssue({code:"custom",message:"評価済みの価格・時点・指標が不整合です"});
  });
export type CohortEvaluation=z.infer<typeof cohortEvaluationSchema>;
