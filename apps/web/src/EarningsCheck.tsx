import { useEffect, useRef, useState } from "react";
import { companyMaterialsSchema, earningsAcquisitionSchema, type EarningsAcquisition, type CompanyMaterials as Materials } from "../../../packages/core/earnings-schema";
import { CompanyMaterials } from "./CompanyMaterials";
export function EarningsCheck(props:{code:string;data?:Materials}) {
  return <EarningsCheckForCode key={`${props.code}:${props.data?.cutoff ?? ""}`} {...props}/>;
}
function EarningsCheckForCode({code,data}:{code:string;data?:Materials}) {
  const [current,setCurrent] = useState(data),[message,setMessage] = useState(""),[busy,setBusy] = useState(false);
  const [diagnostic,setDiagnostic]=useState<EarningsAcquisition|null>(null), alive=useRef(true),inFlight=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  async function acquire() {
    if(inFlight.current)return;
    inFlight.current=true;setBusy(true);setMessage("");setDiagnostic(null);
    try {
      const response = await fetch(`/api/research/earnings/${code}/acquire`,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({confirmFetch:true})});
      if (!response.ok) throw Error("取得要求を処理できませんでした。");
      const result = earningsAcquisitionSchema.parse(await response.json());
      if(!alive.current)return;
      setDiagnostic(result);
      setMessage(result.reason ?? (result.status === "success" ? "取得結果を確認しました。元の予測・スコアはそのままです。" : "取得に失敗した項目があります。項目ごとの理由を確認してください。"));
      if(result.status==="disabled")return;
      const check = await fetch(`/api/research/earnings/${code}`,{credentials:"same-origin"});
      if (!check.ok) throw Error("取得後の確認結果を読めませんでした");
      const materials=companyMaterialsSchema.parse(await check.json());
      if(alive.current)setCurrent(materials);
    } catch {if(alive.current)setMessage("取得または結果の確認が完了しませんでした。以前の表示を最新の確認結果とは扱わず、本人確認・設定・接続を確認して再操作してください。");}
    finally {inFlight.current=false;if(alive.current)setBusy(false);}
  }
  return <><CompanyMaterials data={current}/>
    <button type="button" disabled={busy} onClick={acquire}>{busy ? "決算を取得・照合中…" : "決算情報を取得"}</button>
    <p>この銘柄1つの決算と予定日をJ-Quants Lightから取得し、ローカルに保存します。ページを開くだけでは取得しません。MemWal送信・Sui操作はありません。</p>
    {message&&<p role="status">{message}</p>}
    {diagnostic?.results&&<section aria-label="決算取得の診断結果"><h4>今回の取得結果</h4>{diagnostic.results.map(r=><div key={r.endpoint}>
      <strong>{r.endpoint==="summary" ? "決算サマリー" : "決算発表予定日"}：{r.status==="success" ? r.rowCount===0 ? "対象データなし" : "取得成功" : "失敗"}</strong>
      <p>{r.reason}</p><p>API取得：{r.fetched ? "完了" : "未完了"} ／ 原本保存：{r.saved ? "完了" : "未確認"} ／ hash照合：{r.hashVerified ? "成功" : "未確認"}</p>
      {r.fetchedAt&&<p>取得日時：{new Date(r.fetchedAt).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"})} JST ／ {r.rowCount}件</p>}
    </div>)}</section>}
  </>;
}
