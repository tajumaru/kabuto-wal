import type { Service } from "../apps/api/src/service";
import type { Bar } from "../packages/core/index";
export async function scoutFixture(s:Service,count=6,positive=true){
 const dates=Array.from({length:360},(_,i)=>new Date(Date.UTC(2025,0,i+1)).toISOString().slice(0,10)),asOf=dates[319],cutoff=`${asOf}T14:00:00.000Z`;
 await s.store.write("market/calendar.json",dates.map(date=>({date,open:true})));
 const master=Array.from({length:count},(_,i)=>({providerCode:`${1000+i}0`,displayCode:String(1000+i),name:`人工テスト銘柄${i+1}`}));await s.store.write("market/master.json",master);
 for(const m of master){const bars:Bar[]=dates.map((date,i)=>{const j=i-240,close=i<240?150+Math.sin(i/4)*20:j<60?150-j*1.25:j<75?75:positive&&j<80?76+(j-75)*2:positive?84+(j-79)*.2:70-(j-75);return {providerCode:m.providerCode,sessionDate:date,open:close-.5,high:close+1,low:close-1,close,adjClose:close,volume:i>=315?2000:1000,factor:1,revisionId:`fixture-${m.providerCode}-${i}`,availableAt:i<=319?`${date}T09:00:00.000Z`:`${date}T09:00:00.000Z`,seriesId:`fixture-${m.providerCode}`,adjOpen:close-.5,adjHigh:close+1,adjLow:close-1};});await s.store.write(`prices/${m.providerCode}/fixture.json`,bars,true);}
 return {master,dates,asOf,now:new Date(cutoff)};
}
