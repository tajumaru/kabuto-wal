import { useState } from "react";
import { Link } from "react-router-dom";
import { z } from "zod";
export function NotebookMemory({id,theme,createdAt,request}:{id:string;theme:string;createdAt:string;request:(url:string,body?:unknown)=>Promise<unknown>}){
  const [confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(""),[references,setReferences]=useState<{notebookId:string;createdAt:string}[]>([]);
  async function act(kind:"memory"|"sync"|"recall"){
    setBusy(true);setMessage("");try{
      if(kind==="recall"){const response=z.object({records:z.array(z.object({notebookId:z.string(),createdAt:z.string()})),note:z.string()}).parse(await request("/research/notebook/recall",{theme,confirmExternal:confirm,asOf:createdAt}));setReferences(response.records);setMessage(response.note);}
      else{const response=await request(`/research/notebook/${id}/${kind}`,kind==="sync"?{confirmExternal:confirm}:{});setMessage(kind==="memory"?z.object({note:z.string()}).parse(response).note:"同期状態を更新しました。記憶画面でpending・accepted・synced・uncertainを確認できます。");}
    }catch(e){setMessage(e instanceof Error?e.message:"記憶を確認できませんでした。");}finally{setBusy(false);}
  }
  return <section className="card"><h2>MemWal研究記憶</h2><p>初期状態はローカルのみ。全価格系列・自由記述の仮説は送信しません。削除済み記憶は再生成しません。</p><button disabled={busy} onClick={()=>void act("memory")}>研究記憶をローカル保存</button>
    <label><input type="checkbox" checked={confirm} onChange={e=>setConfirm(e.target.checked)}/>今回のMemWal送信・検索を明示許可（既存の許可設定も必要）</label>
    <button disabled={busy||!confirm} onClick={()=>void act("sync")}>保存済み研究記憶を同期</button><button disabled={busy||!confirm} onClick={()=>void act("recall")}>原本照合付きMemWal検索</button>
    {message&&<p role="status">{message}</p>}{references.map(r=><p key={r.notebookId}><Link to={`?id=${r.notebookId}`}>原本 {r.notebookId.slice(0,12)} · {r.createdAt}</Link></p>)}
  </section>;
}
