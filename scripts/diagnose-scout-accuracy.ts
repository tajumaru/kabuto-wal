import { realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "../packages/storage/index";
import { Service } from "../apps/api/src/service";
import { scoutAccuracy } from "../apps/api/src/bottom-scout-accuracy";

// Never init Service, read settings/dotenv, acquire a writer lock, or call a provider.
class DiagnosticStore extends Store {
 private allowed(key:string){
  if(!/^(research\/scout\/(forecasts|reports|evaluations)(\/|$)|market\/calendar\.json$|market\/bottom-series\/|prices\/|revisions\/)/.test(key))throw Error("diagnostic path denied");
 }
 private async confined(key:string){
  this.allowed(key);
  const root=await realpath(this.root),target=await realpath(this.path(key)),rel=path.relative(root,target);
  if(rel.startsWith("..")||path.isAbsolute(rel))throw Error("diagnostic path outside root");
 }
 override async read<T=unknown>(key:string,fallback?:unknown):Promise<T>{
  try{await this.confined(key);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT"&&fallback!==undefined)return fallback as T;throw e;}
  return super.read<T>(key,fallback);
 }
 override async files(prefix:string){
  try{await this.confined(prefix);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return [];throw e;}
  return super.files(prefix);
 }
 override async write():Promise<void>{throw Error("read-only diagnostic");}
 override async lock<T>():Promise<T>{throw Error("read-only diagnostic");}
}
export async function diagnoseScoutAccuracy(root:string,mode:"demo"|"live",now=new Date()){
 try{await realpath(root);}catch{return {status:"unconfirmed",mode,reason:"保存先にアクセスできません",counts:null};}
 const s=new Service(root,mode,false);s.store=new DiagnosticStore(root);
 const counts=[];
 try{
  for(const recordingMode of ["live","research"] as const){
   const result=await scoutAccuracy(s,{recordingMode,pageSize:1},now,{persist:false});
   counts.push({recordingMode,reports:result.totalReports,...result.cumulative,
    availability:result.cumulative.predictions===0?"no-predictions":"predictions-present",
    message:result.cumulative.predictions===0?"検証対象なし（精度0%ではありません）":"保存済み予測から再計算。評価待ち・不能は的中率の分母から除外。",
    groups:result.groups,top:result.top,bands:result.bands,regimes:result.regimes,
    warnings:[...result.notes,
     "予測対象は保存済みスカウト候補だけであり、非候補や市場全体を代表する無作為標本ではありません。選択バイアスがあります。",
     "予測根拠は予測当時の入力revisionに固定。実績は評価cutoffまでに取得済みのrevisionで測定し、予測原本は現在の価格から作り直しません。",
     "表示値は取引費用・配当・約定を含む実際の取引利益ではありません。"]});
  }
  return {status:"confirmed",mode,readOnly:true,persistedEvaluations:0,counts,note:"保存済みデータによる再計算診断。評価原本の新規保存・実API接続は未実施です。"};
 }catch{
  // Do not print raw exceptions, source payloads, names, or paths.
  return {status:"unconfirmed",mode,readOnly:true,counts:null,reason:"保存原本・価格系列・カレンダーの診断を完了できませんでした。原本は変更していません。"};
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const [mode,...roots]=process.argv.slice(2);
 if(!["demo","live"].includes(mode)||!roots.length)throw Error("Usage: diagnose-scout-accuracy.ts demo|live <saved-root...>");
 for(const root of roots)console.log(JSON.stringify(await diagnoseScoutAccuracy(root,mode as "demo"|"live")));
}
