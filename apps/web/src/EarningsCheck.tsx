import { useState } from "react";
import { companyMaterialsSchema, type CompanyMaterials as Materials } from "../../../packages/core/earnings-schema";
import { CompanyMaterials } from "./CompanyMaterials";
export function EarningsCheck({code,data}:{code:string;data?:Materials}) {
  const [current,setCurrent] = useState(data),[message,setMessage] = useState(""),[busy,setBusy] = useState(false);
  async function acquire() {
    setBusy(true);setMessage("");
    try {
      const response = await fetch(`/api/research/earnings/${code}/acquire`,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({confirmFetch:true})});
      const result = await response.json(); if (!response.ok) throw Error(result.error ?? "取得できませんでした");
      setMessage(result.reason ?? (result.status === "success" ? "取得しました。下記は現在時点の企業材料チェックです。元の予測・スコアはそのままです。" : "取得に失敗した項目があります。下記の確認状態を参照してください。"));
      const check = await fetch(`/api/research/earnings/${code}`,{credentials:"same-origin"});
      if (!check.ok) throw Error("取得後の確認結果を読めませんでした");
      setCurrent(companyMaterialsSchema.parse(await check.json()));
    } catch(e) {setMessage(e instanceof Error ? e.message : "取得できませんでした");}
    finally {setBusy(false);}
  }
  return <><CompanyMaterials data={current}/><button disabled={busy} onClick={acquire}>{busy ? "決算を取得中…" : "Lightの決算・予定を取得する"}</button><p>既存のJ-Quants認証・取得予算を使います。取得後の情報は現在時点の確認用です。</p>{message&&<p role="status">{message}</p>}</>;
}
