import { z } from "zod";

export const planSchema = z.enum(["Free", "Light", "Standard", "Premium"]);
export type JQuantsPlan = z.infer<typeof planSchema>;
const plans = {
  Free: { limit: 5, years: 2, delayDays: 84, topix: false },
  Light: { limit: 60, years: 5, delayDays: 0, topix: true },
  Standard: { limit: 120, years: 10, delayDays: 0, topix: true },
  Premium: { limit: 500, years: 20, delayDays: 0, topix: true },
};
export function planCapabilities(plan: string, rpm?: number) {
  const name = planSchema.parse(plan),
    p = plans[name];
  const requestsPerMinute = rpm ?? Math.floor(p.limit * 0.8);
  if (
    !Number.isInteger(requestsPerMinute) ||
    requestsPerMinute < 1 ||
    requestsPerMinute > p.limit
  )
    throw Error("JQUANTS_REQUESTS_PER_MINUTEが契約上限を超えています");
  return { name, ...p, requestsPerMinute };
}
export function dataWindow(plan: string, today: string) {
  z.string().date().parse(today);
  const p = planCapabilities(plan),
    end = new Date(`${today}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - p.delayDays);
  const start = new Date(end),
    month = start.getUTCMonth();
  start.setUTCFullYear(start.getUTCFullYear() - p.years);
  if (start.getUTCMonth() !== month) start.setUTCDate(0);
  return {
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
  };
}
