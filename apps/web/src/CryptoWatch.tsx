import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip } from "recharts";
import { cryptoAssets } from "../../../packages/integrations/crypto-watch";
async function requestCryptoWatch(update = false) {
  let response: Response;
  try {
    response = await fetch("/api/crypto/watch", update
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
      : undefined);
  } catch {
    throw Error("アプリのサーバーに接続できません。サーバーの起動状態を確認して、もう一度「価格を取得」を押してください。");
  }
  const data = await response.json().catch(() => null);
  if (response.status === 401) throw Error("本人確認の有効期限が切れています。設定画面で本人確認をやり直してください。");
  if (response.status === 403 && data?.error === "Origin不一致") throw Error("画面のURLとサーバーのAPP_ORIGIN設定が一致していません。");
  if (!response.ok) throw Error(data?.error || `価格を取得できませんでした（HTTP ${response.status}）。`);
  if (!data || !Array.isArray(data.assets)) throw Error("価格データを読み取れませんでした。画面を再読み込みしてください。");
  return data;
}
export function CryptoWatch() {
  const query = useQuery({queryKey:["crypto-watch"],queryFn:()=>requestCryptoWatch()});
  const [busy,setBusy]=useState(false), [error,setError]=useState("");
  const date = (value: string) => new Date(value).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});
  return <section className="card crypto-watch">
    <div className="sectionhead"><div><h2>関連する仮想通貨</h2><p className="muted">株の研究に使う参考価格 · 円建て · 24時間の変動</p></div>
      <button disabled={busy} onClick={async()=>{setBusy(true);setError("");try{await requestCryptoWatch(true);await query.refetch({throwOnError:true});}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>{busy?"取得中…":"価格を取得"}</button>
    </div>
    {(error || query.error) && <p role="alert" className="error">{error || query.error?.message}</p>}
    {query.isPending && <p role="status">読み込み中…</p>}
    {query.data && !query.data.assets.length && <p>「価格を取得」でBTC・SUI・SOL・WALの価格と過去7日のグラフを確認できます。</p>}
    <div className="crypto-grid">{cryptoAssets.map((asset)=>{
      const a = query.data?.assets.find((item: {id: string})=>item.id===asset.id);
      if (!a) return <article key={asset.id}>
        <strong>{asset.symbol}</strong><span className="muted"> {asset.name}</span>
        <p>価格未取得</p><p className="muted">「価格を取得」を押すと価格とグラフを表示します。</p>
      </article>;
      return <article key={a.id}>
      <strong>{a.symbol}</strong><span className="muted"> {a.name}</span>
      <div className="price">{a.price.toLocaleString("ja-JP",{maximumFractionDigits:a.price<1000?2:0})}円</div>
      <p className={a.change24h > 0 ? "crypto-rise" : a.change24h < 0 ? "crypto-fall" : undefined}>{a.change24h===null?"24時間変動：データなし":`${a.change24h>0?"+":""}${a.change24h.toFixed(2)}% ${a.change24h>0?"上昇":a.change24h<0?"下落":"変化なし"}`}</p>
      <small>{date(a.observedAt)} JST時点{Date.now()-Date.parse(a.observedAt)>7200000?" · 古い価格です":""}</small>
      {a.prices?.length > 1 ? <>
        <p className="muted">過去7日 · 円建て</p>
        <div style={{height:150,width:"100%"}} aria-label={`${a.symbol}の過去7日間の価格グラフ`}>
          <ResponsiveContainer width="100%" height="100%"><AreaChart data={a.prices.map(([time,price]:[number,number])=>({time,price}))} margin={{top:8,right:8,bottom:0,left:0}}>
            <XAxis dataKey="time" type="number" domain={["dataMin","dataMax"]} tickFormatter={(t)=>new Date(t).toLocaleDateString("ja-JP",{timeZone:"Asia/Tokyo",month:"numeric",day:"numeric"})} minTickGap={35} tick={{fontSize:11}}/>
            <YAxis domain={["auto","auto"]} width={52} tickFormatter={(v)=>v>=1000000?`${(v/1000000).toFixed(1)}M`:v>=1000?`${(v/1000).toFixed(1)}k`:v.toFixed(0)} tick={{fontSize:11}}/>
            <Tooltip labelFormatter={(t)=>date(new Date(Number(t)).toISOString())+" JST"} formatter={(v)=>[`${Number(v).toLocaleString("ja-JP",{maximumFractionDigits:2})}円`,"価格"]}/>
            <Area type="linear" dataKey="price" stroke={a.change24h > 0 ? "#15803d" : a.change24h < 0 ? "#dc2626" : "#1687c4"} fill={a.change24h > 0 ? "#dcfce7" : a.change24h < 0 ? "#fee2e2" : "#d5edf8"} strokeWidth={2} isAnimationActive={false}/>
          </AreaChart></ResponsiveContainer>
        </div>
      </>:<p className="muted">{a.historyError||"履歴未取得"}</p>}
    </article>;})}</div>
    <small>手動取得 · 1時間以内は取得済み価格を表示{query.data?.fetchedAt?` · 最終取得 ${date(query.data.fetchedAt)} JST`:""} · <a href="https://www.coingecko.com" target="_blank" rel="noreferrer">価格データ：CoinGecko</a></small>
  </section>;
}
