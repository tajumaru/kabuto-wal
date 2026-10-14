import "dotenv/config";
import { Service } from "./service";
const service = new Service();
await service.init();
const result = await service.store.lock(() => service.job());
console.log(JSON.stringify(result, null, 2));
if (result.status === "failed") process.exitCode = 1;
