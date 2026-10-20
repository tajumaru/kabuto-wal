import { z } from "zod";

export const earningsCode = z.string().regex(/^[0-9A-Z]{5}$/);
const date = z.string().date();
const optionalDate = z.union([date, z.literal("")]);
// The API returns strings, including numeric fields. Empty never means zero.
const amount = z.string().refine(v => v === "" || (/^-?\d+(?:\.\d+)?$/.test(v) && Number.isFinite(Number(v))), "不正な財務数値");
export const financialFields = [
  "Sales", "OP", "OdP", "NP", "EPS", "DEPS", "TA", "Eq", "EqAR", "BPS", "CFO", "CFI", "CFF", "CashEq",
  "Div1Q", "Div2Q", "Div3Q", "DivFY", "DivAnn", "DivUnit", "DivTotalAnn", "PayoutRatioAnn",
  "FDiv1Q", "FDiv2Q", "FDiv3Q", "FDivFY", "FDivAnn", "FDivUnit", "FDivTotalAnn", "FPayoutRatioAnn",
  "NxFDiv1Q", "NxFDiv2Q", "NxFDiv3Q", "NxFDivFY", "NxFDivAnn", "NxFDivUnit", "NxFPayoutRatioAnn",
  "FSales2Q", "FOP2Q", "FOdP2Q", "FNP2Q", "FEPS2Q", "NxFSales2Q", "NxFOP2Q", "NxFOdP2Q", "NxFNp2Q", "NxFEPS2Q",
  "FSales", "FOP", "FOdP", "FNP", "FEPS", "NxFSales", "NxFOP", "NxFOdP", "NxFNp", "NxFEPS",
  "ShEq", "NCShEq", "ROE", "NCROE", "ShOutFY", "TrShFY", "AvgSh", "NCSales", "NCOP", "NCOdP", "NCNP", "NCEPS", "NCTA", "NCEq", "NCEqAR", "NCBPS",
  "FNCSales2Q", "FNCOP2Q", "FNCOdP2Q", "FNCNP2Q", "FNCEPS2Q", "NxFNCSales2Q", "NxFNCOP2Q", "NxFNCOdP2Q", "NxFNCNP2Q", "NxFNCEPS2Q",
  "FNCSales", "FNCOP", "FNCOdP", "FNCNP", "FNCEPS", "NxFNCSales", "NxFNCOP", "NxFNCOdP", "NxFNCNP", "NxFNCEPS",
] as const;
export const earningsSummarySchema = z.object({
  DiscDate: date, DiscTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/),
  Code: earningsCode, DiscNo: z.string().regex(/^\d+$/), DocType: z.string().min(1),
  CurPerType: z.enum(["1Q", "2Q", "3Q", "4Q", "5Q", "FY", ""]),
  CurPerSt: optionalDate, CurPerEn: optionalDate, CurFYSt: optionalDate, CurFYEn: optionalDate,
  NxtFYSt: optionalDate.optional(), NxtFYEn: optionalDate.optional(),
  ...Object.fromEntries(financialFields.map(f => [f, amount.optional()])),
}).catchall(z.string());
export type EarningsSummary = z.infer<typeof earningsSummarySchema>;
export const earningsDateSchema = z.object({
  PubDate: date, SchDate: optionalDate, FQName: z.enum(["1Q", "2Q", "3Q", "FY"]),
  FYE: z.string().regex(/^\d{4}$/), Code: earningsCode, CoName: z.string(), CoNameEn: z.string(),
}).catchall(z.string());
export type EarningsDate = z.infer<typeof earningsDateSchema>;
export const materialCheckSchema = z.object({
  status: z.enum(["checked", "no-data", "not-fetched", "failed"]),
  reason: z.string(), checkedAt: z.string().datetime().nullable(),
  source: z.literal("jquants-v2"), revisions: z.array(z.string()),
  evidence: z.array(z.object({revision:z.string(),rawHash:z.string(),fetchedAt:z.string().datetime()})).optional(),
});
export const companyMaterialsSchema = z.object({
  cutoff: z.string().datetime(), earnings: materialCheckSchema, schedule: materialCheckSchema,
  news: z.object({status: z.literal("unchecked"), reason: z.string()}),
  latestDisclosure: z.object({date: z.string(), time: z.string(), number: z.string(), period: z.string(), revision: z.string()}).nullable(),
  nextEarningsDate: date.nullable(), comments: z.array(z.string()),
});
export type CompanyMaterials = z.infer<typeof companyMaterialsSchema>;

// Acquisition diagnostics expose stages and safe categories, never provider bodies.
export const earningsAcquisitionSchema = z.object({
  status: z.enum(["disabled","success","failed"]), reason: z.string().optional(),
  results: z.array(z.object({
    endpoint: z.enum(["summary","earnings-date"]), status: z.enum(["success","failed"]), reason: z.string(),
    errorCode: z.enum(["authentication","permission","rate-limit","network","invalid-response","storage"]).nullable(),
    fetched: z.boolean(), saved: z.boolean(), hashVerified: z.boolean(),
    rowCount: z.number().int().nonnegative().nullable(), fetchedAt: z.string().datetime().nullable(),
    revision: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  })).optional(),
});
export type EarningsAcquisition = z.infer<typeof earningsAcquisitionSchema>;
