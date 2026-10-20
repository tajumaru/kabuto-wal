import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { z } from "zod";
import { companyMaterialsSchema, earningsCode } from "../../../packages/core/earnings-schema";
import { PageTitle } from "./PageTitle";
import { KabumaruPortrait } from "./Kabumaru";
import { StockPicker } from "./StockPicker";
import { displayStockCode } from "./stock-search";
import { EarningsCheck } from "./EarningsCheck";
import "./EarningsResearch.css";

const stocksSchema=z.array(z.object({providerCode:earningsCode,name:z.string(),displayCode:z.string().optional()}));
async function read(path:string) {
  const response=await fetch(`/api${path}`,{credentials:"same-origin"});
  if(!response.ok)throw Error(response.status===401 ? "設定画面で本人確認を行ってください。" : "保存済みデータを読めませんでした。");
  return response.json() as Promise<unknown>;
}
export function EarningsResearch() {
  const [params,setParams]=useSearchParams(),code=params.get("code")??"";
  const master=useQuery({queryKey:["earnings-master"],queryFn:async()=>stocksSchema.parse(await read("/master")),retry:false,refetchOnWindowFocus:false});
  const valid=earningsCode.safeParse(code).success && !!master.data?.some(s=>s.providerCode===code);
  const saved=useQuery({queryKey:["earnings-saved",code],queryFn:async()=>companyMaterialsSchema.parse(await read(`/research/earnings/${code}`)),enabled:valid,retry:false,refetchOnWindowFocus:false,staleTime:0});
  return <section className="earnings-research">
    <PageTitle eyebrow="EARNINGS CHECK" title="かぶまる決算チェック" description="保存済み銘柄を1つ選んで、決算と発表予定日を確認しよう。ニュースや株価の予測とは別の確認だよ。" portrait={<KabumaruPortrait pose="analyze"/>}/>
    <section className="card"><h2>1. 確認したい銘柄を選ぶ</h2>
      <StockPicker stocks={(master.data??[]).map(s=>({...s,displayCode:s.displayCode??displayStockCode(s.providerCode)}))} value={valid?code:""} loading={master.isLoading} onChange={value=>setParams(value?{code:value}:{})}/>
      {master.isLoading&&<p role="status">保存済み銘柄を読み込み中…</p>}
      {master.error&&<p role="alert">{master.error.message}</p>}
      {master.data?.length===0&&<p>保存済み銘柄がありません。先に通常の市場データ取得で銘柄一覧を保存してください。</p>}
      {code&&!valid&&!master.isLoading&&<p role="alert">保存済み銘柄一覧から選び直してください。</p>}
    </section>
    {valid&&<section className="card"><h2>2. 保存済み情報を確認・必要なら取得</h2>
      {saved.isLoading&&<p role="status">保存済み決算を照合中…</p>}
      {saved.error&&<p role="alert">{saved.error.message}</p>}
      {!saved.isLoading&&<EarningsCheck key={code} code={code} data={saved.data}/>}
    </section>}
  </section>;
}
