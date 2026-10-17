import { z } from "zod";
export const HUNTER_METHOD = "bottom-hunter-v1";
export const HUNTER_FORECAST_METHOD = "bottom-hunter-hypothesis-v1";
export const hunterCategory = z.enum(["反転兆候あり", "底固め観察", "反発進行中", "警戒", "判定不能"]);
