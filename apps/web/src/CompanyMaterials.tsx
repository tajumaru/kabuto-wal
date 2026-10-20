import type { CompanyMaterials } from "../../../packages/core/earnings-schema";
export function CompanyMaterials({data}:{data?:CompanyMaterials}) {
  const label = (status:string) => ({checked:"確認済み","no-data":"データなし","not-fetched":"未取得",failed:"取得失敗"}[status] ?? status);
  return <section aria-label="企業材料チェック" className="company-materials"><h4>企業材料チェック</h4>
    {data ? <><p>確認の基準日時：{new Date(data.cutoff).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"})} JST</p>
      {([ ["決算",data.earnings],["決算予定",data.schedule] ] as const).map(([title,check])=><div key={title}><strong>{title}：{label(check.status)}</strong><p>{check.reason}</p>{check.checkedAt&&<p>最終確認日時：{new Date(check.checkedAt).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"})} JST ／ 出典：J-Quants v2</p>}{check.evidence?.length ? <p>{check.status==="failed" ? "今回の確認は失敗しています。以下に以前の成功原本に基づく情報が含まれます。" : "保存原本のhash・revision参照を照合済みです。"}</p> : null}</div>)}
      <p>ニュース未確認：{data.news.reason}</p>{data.latestDisclosure&&<p>最新決算開示：{data.latestDisclosure.date} {data.latestDisclosure.time} JST</p>}{data.nextEarningsDate&&<p>次回決算発表予定日：{data.nextEarningsDate}</p>}<details><summary>かぶまるの決算メモ</summary>{data.comments.map((comment,i)=><p key={i}>{comment}</p>)}</details>
      {!!(data.earnings.revisions.length+data.schedule.revisions.length)&&<details><summary>決算原本の参照情報</summary>{data.latestDisclosure&&<p>開示番号：{data.latestDisclosure.number} ／ 開示日：{data.latestDisclosure.date} {data.latestDisclosure.time} JST</p>}{[...(data.earnings.evidence??[]),...(data.schedule.evidence??[])].map(e=><p key={e.revision} style={{overflowWrap:"anywhere"}}>原本取得日時：{new Date(e.fetchedAt).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"})} JST<br/>原本hash：{e.rawHash}<br/>revision：{e.revision}</p>)}<p>hashはローカル原本の照合用です。</p></details>}
    </> : <p>決算・決算予定は未取得です。ニュース未確認：ニュース取得機能は未実装です。</p>}
  </section>;
}
